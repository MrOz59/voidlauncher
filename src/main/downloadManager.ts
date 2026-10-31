import { downloadFile, downloadTorrent, pauseTorrent, resumeTorrent, cancelTorrent, type TorrentProgress, isTorrentActive, getActiveTorrentIds, getActiveTorrentSnapshots } from './downloader'
import { extractZipWithPassword } from './zip'
import { processUpdateExtraction, findFilesRecursive } from './extractionUtils'
import { isValidFinalizedInstall } from './installFinalization'
import { findAndReadOnlineFixIni } from './utils/onlinefixIni'
import { sanitizeVersionText } from './utils/versionUtils'
import {
  getGame,
  createDownload,
  updateDownloadInstallPath,
  updateDownloadProgress,
  updateDownloadStatus,
  updateDownloadInfoHash,
  markGameInstalled,
  getSetting,
  getDownloadByInfoHash,
  getDownloadByUrl,
  getDownloadByGameUrl,
  getDownloadById,
  deleteDownload,
  extractGameIdFromUrl,
  updateGameInfo,
  addOrUpdateGame,
  getActiveDownloads
} from './db'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Worker } from 'worker_threads'
import { session, BrowserWindow, app } from 'electron'
import { notifyDownloadError } from './desktopNotifications'
import { taskId, upsertTask } from './taskManager'
import { findExecutableInDir } from './utils'

// ============================================================================
// DOWNLOAD QUEUE SYSTEM
// ============================================================================

interface QueuedDownload {
  id: string
  options: DownloadOptions
  onProgress?: (progress: number, details?: ProgressDetails) => void
  resolve: (result: StartGameDownloadResult) => void
  reject: (error: Error) => void
  addedAt: number
  priority: number // Lower = higher priority
}

export type StartGameDownloadResult = {
  success: boolean
  error?: string
  installPath?: string
  firstInstall?: boolean
  wasUpdate?: boolean
}

// Download queue state
const downloadQueue: QueuedDownload[] = []
const activeDownloads = new Map<string, QueuedDownload>()
let queueProcessing = false

// Generate unique queue ID
function generateQueueId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// Get max parallel downloads from settings
function getMaxParallelDownloads(): number {
  const setting = getSetting('parallel_downloads')
  const n = Number(setting)
  return Number.isFinite(n) && n > 0 ? n : 3
}

// Broadcast queue status to all windows
function broadcastQueueStatus() {
  const status = getDownloadQueueStatus()
  BrowserWindow.getAllWindows().forEach(w => {
    try {
      w.webContents.send('download-queue-status', status)
    } catch {
      // ignore
    }
  })
}

// Broadcast download progress to all windows (used by resume/rehydrate flows).
const downloadProgressThrottle = new Map<string, number>()
function broadcastDownloadProgress(payload: any) {
  try {
    const key = String(payload?.infoHash || payload?.magnet || payload?.url || '')
    const now = Date.now()
    if (key) {
      const last = downloadProgressThrottle.get(key) || 0
      if (now - last < 200) return
      downloadProgressThrottle.set(key, now)
    }
    if (key) {
      const isExtract = payload?.stage === 'extract' || payload?.extractProgress !== undefined
      const progress = isExtract ? (payload?.extractProgress ?? payload?.progress) : payload?.progress
      upsertTask({
        id: taskId(isExtract ? 'extract' : 'download', key),
        kind: isExtract ? 'extract' : 'download',
        title: isExtract ? 'Extraindo jogo' : 'Baixando jogo',
        status: progress >= 100 ? 'done' : 'running',
        progress,
        message: payload?.statusMessage,
        targetPath: payload?.destPath,
        impact: isExtract ? 'disk' : 'network'
      })
    }
    BrowserWindow.getAllWindows().forEach(w => {
      try { w.webContents.send('download-progress', payload) } catch {}
    })
  } catch {
    // ignore
  }
}

// Get current queue status
export function getDownloadQueueStatus() {
  return {
    maxParallel: getMaxParallelDownloads(),
    activeCount: activeDownloads.size,
    queuedCount: downloadQueue.length,
    active: Array.from(activeDownloads.entries()).map(([id, d]) => ({
      id,
      gameUrl: d.options.gameUrl,
      downloadUrl: d.options.torrentMagnet || d.options.downloadUrl,
      title: d.options.gameTitle,
      priority: d.priority,
      addedAt: d.addedAt
    })),
    queued: downloadQueue.map(d => ({
      id: d.id,
      gameUrl: d.options.gameUrl,
      downloadUrl: d.options.torrentMagnet || d.options.downloadUrl,
      title: d.options.gameTitle,
      priority: d.priority,
      addedAt: d.addedAt
    })),
    updatedAt: Date.now()
  }
}

function resolvedPathMaybe(p?: string | null): string | null {
  const value = String(p || '').trim()
  if (!value) return null
  try { return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value) } catch { return value }
}

function fileExists(p?: string | null): boolean {
  const rp = resolvedPathMaybe(p)
  if (!rp) return false
  try { return fs.existsSync(rp) } catch { return false }
}

/**
 * Legacy markers and existing executables do not prove that the current
 * download finished installing. Only an installed marker for this ID does.
 */
export function isDownloadInstallFinalized(download: { id?: number; game_url?: string | null }, installDir?: string | null): boolean {
  const dir = resolvedPathMaybe(installDir)
  if (!dir) return false
  return isValidFinalizedInstall({
    downloadId: Number(download?.id),
    gameUrl: download?.game_url,
    installDir: dir,
    hasPayload: countFilesRecursive(dir, 1) > 0,
    hasExecutable: process.platform !== 'win32' || Boolean(findExecutableInDir(dir)),
    requireWindowsExecutable: process.platform === 'win32'
  })
}

export function hasExistingGameInstall(gameUrl: string, installPath?: string | null): boolean {
  try {
    const game = getGame(gameUrl) as any
    if (fileExists(game?.executable_path)) return true
    const knownPath = game?.install_path || installPath
    if (game?.installed_at && knownPath && countFilesRecursive(knownPath, 1) > 0) return true
  } catch {
    // ignore DB lookup failures
  }

  const rp = resolvedPathMaybe(installPath)
  if (!rp || !fs.existsSync(rp)) return false
  try {
    const marker = path.join(rp, '.of_game.json')
    if (fs.existsSync(marker)) {
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'))
      if (parsed?.status === 'installed' && countFilesRecursive(rp, 1) > 0) return true
    }
  } catch {
    // ignore malformed marker
  }
  return false
}

function hasExtractionMarker(dir?: string | null): boolean {
  const rp = resolvedPathMaybe(dir)
  if (!rp || !fs.existsSync(rp)) return false
  return fs.existsSync(path.join(rp, '.of_extracting.json')) ||
    fs.existsSync(path.join(rp, '.of_update_extracting.json')) ||
    fs.existsSync(path.join(rp, '.extracting'))
}

function emitDownloadDeleted() {
  BrowserWindow.getAllWindows().forEach(w => {
    try { w.webContents.send('download-deleted') } catch {}
  })
}

export function reconcileDownloadState(reason = 'manual') {
  const actions: Array<{ id: number; action: string; reason: string }> = []
  const downloads = getActiveDownloads() as any[]
  const activeTorrents = getActiveTorrentSnapshots()
  const activeAliases = new Set<string>()
  for (const torrent of activeTorrents) {
    for (const alias of torrent.aliases || []) activeAliases.add(String(alias))
    if (torrent.infoHash) activeAliases.add(String(torrent.infoHash))
    if (torrent.source) activeAliases.add(String(torrent.source))
  }

  for (const d of downloads) {
    const id = Number(d?.id)
    if (!Number.isFinite(id)) continue
    const status = String(d?.status || '').toLowerCase()
    const type = String(d?.type || '').toLowerCase()
    const progress = Number(d?.progress || 0)
    const installPath = resolvedPathMaybe(d?.install_path || d?.dest_path)
    const destPath = resolvedPathMaybe(d?.dest_path)
    const keys = [d?.info_hash, d?.download_url, d?.game_url, String(id)].filter(Boolean).map(String)
    const hasAgent = keys.some(k => activeAliases.has(k))

    try {
      if (status === 'completed') continue

      if (isDownloadInstallFinalized(d, installPath)) {
        updateDownloadProgress(id, 100)
        updateDownloadStatus(id, 'completed')
        deleteDownload(id)
        emitDownloadDeleted()
        upsertTask({
          id: taskId('download', d?.info_hash || d?.download_url || String(id)),
          kind: 'download',
          title: d?.title || 'Download',
          status: 'done',
          progress: 100,
          message: 'Reconciliado como instalado pelo conteúdo no disco',
          gameUrl: d?.game_url,
          targetPath: installPath || undefined,
          impact: 'network'
        })
        actions.push({ id, action: 'completed-and-removed', reason: 'installed-files-found' })
        continue
      }

      if (status === 'extracting') {
        if (isDownloadInstallFinalized(d, installPath)) {
          updateDownloadProgress(id, 100)
          updateDownloadStatus(id, 'completed')
          deleteDownload(id)
          emitDownloadDeleted()
          actions.push({ id, action: 'completed-and-removed', reason: 'extraction-finished-on-disk' })
        } else if (!hasExtractionMarker(installPath) && !hasExtractionMarker(destPath)) {
          updateDownloadStatus(id, 'error', 'Extração interrompida. Execute a extração novamente.')
          actions.push({ id, action: 'error', reason: 'missing-extraction-marker' })
        }
        continue
      }

      if (type === 'torrent' && ['downloading', 'pending'].includes(status) && !hasAgent) {
        if (isDownloadInstallFinalized(d, installPath)) {
          updateDownloadProgress(id, 100)
          updateDownloadStatus(id, 'completed')
          deleteDownload(id)
          emitDownloadDeleted()
          actions.push({ id, action: 'completed-and-removed', reason: 'torrent-done-on-disk' })
        } else {
          updateDownloadStatus(id, 'paused', 'Torrent não estava ativo no agente; pausado para retomada segura.')
          actions.push({ id, action: 'paused', reason: 'missing-agent-session' })
        }
        continue
      }

      if (type === 'http' && status === 'downloading' && !fileExists(d?.dest_path) && !fileExists(`${d?.dest_path || ''}.part`)) {
        updateDownloadStatus(id, 'error', 'Arquivo parcial do download não encontrado.')
        actions.push({ id, action: 'error', reason: 'missing-http-file' })
      }
    } catch (err: any) {
      console.warn('[DownloadReconciler] Failed to reconcile row:', id, err?.message || err)
    }
  }

  if (actions.length) {
    console.log('[DownloadReconciler] Applied actions:', reason, actions)
  }
  return { checked: downloads.length, actions, activeTorrentAliases: activeAliases.size, updatedAt: Date.now() }
}

// Process the download queue
let queueRetryTimer: ReturnType<typeof setTimeout> | null = null

async function processQueue() {
  if (queueProcessing) return
  queueProcessing = true

  try {
    const maxParallel = getMaxParallelDownloads()

    while (activeDownloads.size < maxParallel && downloadQueue.length > 0) {
      // Sort queue by priority (lower first), then by addedAt (older first)
      downloadQueue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.addedAt - b.addedAt
      })

      const next = downloadQueue.shift()
      if (!next) break

      // Check if already downloading this game
      const gameUrl = next.options.gameUrl
      const isAlreadyActive = Array.from(activeDownloads.values()).some(d => d.options.gameUrl === gameUrl)
      if (isAlreadyActive) {
        console.log('[DownloadQueue] Game already downloading, skipping:', gameUrl)
        next.resolve({ success: false, error: 'Este jogo já está sendo baixado' })
        continue
      }

      // Move to active
      activeDownloads.set(next.id, next)
      broadcastQueueStatus()

      // Start download in background (don't await here)
      executeDownload(next).catch(err => {
        console.error('[DownloadQueue] Unexpected error in executeDownload:', err)
      })
    }
  } finally {
    queueProcessing = false
  }

  broadcastQueueStatus()

  // Safety net: if there are still items in the queue and slots available, retry shortly.
  // This handles edge cases where processQueue was skipped due to the queueProcessing guard.
  if (queueRetryTimer) clearTimeout(queueRetryTimer)
  if (downloadQueue.length > 0 && activeDownloads.size < getMaxParallelDownloads()) {
    queueRetryTimer = setTimeout(() => {
      queueRetryTimer = null
      processQueue()
    }, 500)
  }
}

// Execute a single download
async function executeDownload(queued: QueuedDownload) {
  try {
    console.log('[DownloadQueue] Starting download:', queued.options.gameTitle)
    const result = await startGameDownloadInternal(queued.options, queued.onProgress)
    queued.resolve(result)
  } catch (err: any) {
    console.error('[DownloadQueue] Download failed:', err)
    queued.reject(err)
  } finally {
    activeDownloads.delete(queued.id)
    broadcastQueueStatus()
    // Process next in queue
    setTimeout(() => processQueue(), 100)
  }
}

// Add download to queue (public API)
export function queueGameDownload(
  options: DownloadOptions,
  onProgress?: (progress: number, details?: ProgressDetails) => void
): Promise<StartGameDownloadResult> {
  return new Promise((resolve, reject) => {
    const id = generateQueueId()
    const queued: QueuedDownload = {
      id,
      options,
      onProgress,
      resolve,
      reject,
      addedAt: Date.now(),
      priority: 100 // Default priority
    }

    // Check if this game is already in queue or active
    const gameUrl = options.gameUrl
    const inQueue = downloadQueue.some(d => d.options.gameUrl === gameUrl)
    const inActive = Array.from(activeDownloads.values()).some(d => d.options.gameUrl === gameUrl)

    if (inQueue || inActive) {
      resolve({ success: false, error: 'Este jogo já está na fila ou sendo baixado' })
      return
    }

    downloadQueue.push(queued)
    console.log('[DownloadQueue] Added to queue:', options.gameTitle, 'Queue size:', downloadQueue.length)
    broadcastQueueStatus()
    processQueue()
  })
}

// Prioritize a download (move to front of queue or swap with active)
export function prioritizeDownload(queueId: string): { success: boolean; error?: string } {
  // If it's in the queue, move to front
  const queueIndex = downloadQueue.findIndex(d => d.id === queueId)
  if (queueIndex >= 0) {
    const item = downloadQueue.splice(queueIndex, 1)[0]
    item.priority = 0 // Highest priority
    downloadQueue.unshift(item)
    broadcastQueueStatus()
    processQueue()
    return { success: true }
  }

  // If it's not in queue, check if it's a game URL
  const inQueueByGame = downloadQueue.find(d => d.options.gameUrl === queueId)
  if (inQueueByGame) {
    const idx = downloadQueue.indexOf(inQueueByGame)
    downloadQueue.splice(idx, 1)
    inQueueByGame.priority = 0
    downloadQueue.unshift(inQueueByGame)
    broadcastQueueStatus()
    processQueue()
    return { success: true }
  }

  return { success: false, error: 'Download não encontrado na fila' }
}

// Remove download from queue
export function removeFromQueue(queueId: string): { success: boolean; error?: string } {
  const queueIndex = downloadQueue.findIndex(d => d.id === queueId || d.options.gameUrl === queueId)
  if (queueIndex >= 0) {
    const removed = downloadQueue.splice(queueIndex, 1)[0]
    removed.resolve({ success: false, error: 'Removido da fila' })
    broadcastQueueStatus()
    return { success: true }
  }

  return { success: false, error: 'Download não encontrado na fila' }
}

// Pause active download and move queued one to active
export function swapActiveDownload(queueIdToActivate: string): { success: boolean; error?: string } {
  // Find in queue
  const queueIndex = downloadQueue.findIndex(d => d.id === queueIdToActivate || d.options.gameUrl === queueIdToActivate)
  if (queueIndex < 0) {
    return { success: false, error: 'Download não encontrado na fila' }
  }

  // Find an active torrent download to pause (can only pause torrents)
  let activeToPause: QueuedDownload | null = null
  for (const [, d] of activeDownloads) {
    if (d.options.torrentMagnet) {
      activeToPause = d
      break
    }
  }

  if (!activeToPause) {
    // No torrent to pause, just prioritize
    return prioritizeDownload(queueIdToActivate)
  }

  // Pause the active torrent
  const torrentId = activeToPause.options.torrentMagnet || activeToPause.options.downloadUrl || ''
  if (torrentId && isTorrentActive(torrentId)) {
    pauseTorrent(torrentId)
    console.log('[DownloadQueue] Paused active torrent to swap:', activeToPause.options.gameTitle)
  }

  // Prioritize the queued download
  const item = downloadQueue.splice(queueIndex, 1)[0]
  item.priority = -1 // Higher than highest
  downloadQueue.unshift(item)

  broadcastQueueStatus()
  processQueue()

  return { success: true }
}

// Get count of truly active (downloading) items
export function getActiveDownloadCount(): number {
  // Count from DB: downloads with status 'downloading'
  try {
    const active = getActiveDownloads() as any[]
    return active.filter(d => d.status === 'downloading').length
  } catch {
    return activeDownloads.size
  }
}

// Check if a game is in queue or active
export function isGameInDownloadQueue(gameUrl: string): boolean {
  const inQueue = downloadQueue.some(d => d.options.gameUrl === gameUrl)
  const inActive = Array.from(activeDownloads.values()).some(d => d.options.gameUrl === gameUrl)
  return inQueue || inActive
}

// ============================================================================
// END DOWNLOAD QUEUE SYSTEM
// ============================================================================

export interface DownloadOptions {
  gameUrl: string
  downloadUrl?: string
  torrentMagnet?: string
  gameTitle: string
  gameVersion: string
  gameId?: string  // ID from the game URL (e.g., 17973)
  autoExtract?: boolean
  existingDownloadId?: number
  destPathOverride?: string
}

type DownloadRow = {
  id: number
  dest_path?: string | null
  install_path?: string | null
  info_hash?: string | null
  download_url?: string | null
  game_url?: string | null
  title?: string | null
  type?: string | null
  status?: string | null
}

function resolveDefaultGamesPath(): string {
  const configured = String(getSetting('games_path') || '').trim()
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured)

  const home = os.homedir()
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const docs = app.getPath('documents')
      if (docs) return path.join(docs, 'VoidLauncher')
    } catch {
      // ignore
    }
  }

  if (home) return path.join(home, 'Games', 'VoidLauncher')
  return path.join(process.cwd(), 'games')
}

export function resolveDownloadRoot(): string {
  return resolveDefaultDownloadPath()
}

function resolveDefaultDownloadPath(): string {
  const configured = String(getSetting('download_path') || '').trim()
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured)

  try {
    const downloads = app.getPath('downloads')
    if (downloads) return downloads
  } catch {
    // ignore
  }

  const home = os.homedir()
  if (home) return path.join(home, 'Downloads')
  return path.join(process.cwd(), 'downloads')
}

// If the game content is nested inside a single subfolder (common in torrents/zips),
// move everything up one level to avoid duplicated folder nesting.
function mergeMoveEntry(srcPath: string, destPath: string) {
  try {
    const srcStat = fs.existsSync(srcPath) ? fs.statSync(srcPath) : null
    if (!srcStat) return

    // Directory merge
    if (srcStat.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      const entries = fs.readdirSync(srcPath, { withFileTypes: true })
      for (const entry of entries) {
        const s = path.join(srcPath, entry.name)
        const d = path.join(destPath, entry.name)
        mergeMoveEntry(s, d)
      }
      try { fs.rmSync(srcPath, { recursive: true, force: true }) } catch {}
      return
    }

    // File overwrite
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    try {
      if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
        fs.rmSync(destPath, { recursive: true, force: true })
      } else if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { force: true })
      }
    } catch {
      // ignore
    }

    try {
      fs.renameSync(srcPath, destPath)
    } catch {
      try {
        fs.cpSync(srcPath, destPath, { force: true })
        try { fs.rmSync(srcPath, { force: true }) } catch {}
      } catch (err) {
        console.warn('[mergeMoveEntry] Failed to move', srcPath, '->', destPath, err)
      }
    }
  } catch (err) {
    console.warn('[mergeMoveEntry] Error', srcPath, '->', destPath, err)
  }
}

function flattenSingleSubdir(basePath: string) {
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.name !== '.DS_Store' && e.name !== 'Thumbs.db' &&
        !/^\.of_/.test(e.name) && e.name !== '.extracting')

    if (entries.length !== 1 || !entries[0].isDirectory()) return

    // Never flatten Unity _Data folders - they must stay next to the executable
    if (entries[0].name.endsWith('_Data') ||
        /^(Engine|Content|Binaries|Plugins|Data|Resources|StreamingAssets|Managed|MonoBleedingEdge)$/i.test(entries[0].name)) return

    const subDir = path.join(basePath, entries[0].name)
    const subEntries = fs.readdirSync(subDir, { withFileTypes: true })

    subEntries.forEach(entry => {
      const src = path.join(subDir, entry.name)
      const dest = path.join(basePath, entry.name)
      mergeMoveEntry(src, dest)
    })

    try {
      fs.rmdirSync(subDir)
    } catch (err) {
      console.warn('[flattenSingleSubdir] Failed to remove subdir', subDir, err)
    }

    console.log('[flattenSingleSubdir] Flattened nested folder:', subDir)
  } catch (err) {
    console.warn('[flattenSingleSubdir] Error while flattening', basePath, err)
    throw err
  }
}

function removeFolderIfExists(target: string) {
  if (!target || target === '/' || target === '.' || target === '..') return
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('[removeFolderIfExists] Failed to remove', target, err)
  }
}

function removeFileIfExists(target: string) {
  try {
    if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
      fs.rmSync(target, { force: true })
    }
  } catch (err) {
    console.warn('[removeFileIfExists] Failed to remove file', target, err)
  }
}

function removeArchives(dir: string) {
  try {
    if (!dir || !fs.existsSync(dir)) return
    const archives = findFilesRecursive(dir, /\.(rar|zip|7z)$/i)
    archives.forEach(f => {
      try { fs.rmSync(f, { force: true }) } catch (err) { console.warn('[removeArchives] Failed to remove', f, err) }
    })
  } catch (err) {
    console.warn('[removeArchives] Failed in', dir, err)
  }
}

function writeLauncherMarker(installPath: string, data: Record<string, any>) {
  try {
    if (!installPath) return
    const markerPath = path.join(installPath, '.of_game.json')
    const existing = fs.existsSync(markerPath)
      ? JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
      : {}
    const next = {
      ...existing,
      ...data,
      updatedAt: Date.now()
    }
    fs.writeFileSync(markerPath, JSON.stringify(next, null, 2))
  } catch (err) {
    // Without the marker a resumed download cannot be reconciled on restart.
    console.warn('[Downloads] Failed to write download marker:', err)
  }
}

/**
 * Safely clean up temporary files and optionally remove empty directories.
 * Never throws - all errors are logged and ignored.
 */
function safeCleanupTempFiles(dir: string, filesToRemove: string[] = []) {
  if (!dir || !fs.existsSync(dir)) return

  // Remove specific files
  for (const fileName of filesToRemove) {
    const filePath = path.join(dir, fileName)
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        if (stat.isFile()) {
          fs.unlinkSync(filePath)
          console.log('[safeCleanupTempFiles] Removed:', filePath)
        }
      }
    } catch (err) {
      console.warn('[safeCleanupTempFiles] Failed to remove file:', filePath, err)
    }
  }

  // Try to remove the directory if it's empty
  try {
    const remaining = fs.readdirSync(dir)
    if (remaining.length === 0) {
      fs.rmdirSync(dir)
      console.log('[safeCleanupTempFiles] Removed empty directory:', dir)
    }
  } catch (err) {
    // Directory not empty or other error - that's fine
  }
}

function countFilesRecursive(dir: string, max = 5000): number {
  let count = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop() as string
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name))
        } else if (!/^\.of_|^\.extracting$|^\.DS_Store$|^Thumbs\.db$/i.test(entry.name)) {
          count++
          if (count >= max) return count
        }
      }
    } catch {
      // ignore
    }
  }
  return count
}

// If there's a dominant subfolder (lots more files than the root), flatten it to avoid duplicate installs
function flattenDominantSubdir(basePath: string) {
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.name !== '.DS_Store' && e.name !== 'Thumbs.db')
    const subdirs = entries.filter(e => e.isDirectory())
    if (!subdirs.length) return

    const filesAtRoot = entries.filter(e => e.isFile()).length
    let bestDir: string | null = null
    let bestCount = 0

    for (const dir of subdirs) {
      const full = path.join(basePath, dir.name)
      const count = countFilesRecursive(full, 10000)
      if (count > bestCount) {
        bestCount = count
        bestDir = full
      }
    }

    if (!bestDir) return

    // Heuristic: flatten if the dominant folder clearly has more files than the root itself
    if (bestCount < Math.max(5, filesAtRoot * 2)) return

    // Never flatten Unity _Data folders - they must stay next to the executable
    if (path.basename(bestDir).endsWith('_Data')) {
      console.log('[flattenDominantSubdir] Skipping Unity _Data folder:', bestDir)
      return
    }

    console.log('[flattenDominantSubdir] Flattening dominant folder:', bestDir, 'files:', bestCount, 'rootFiles:', filesAtRoot)

    const subEntries = fs.readdirSync(bestDir, { withFileTypes: true })
    subEntries.forEach(entry => {
      const src = path.join(bestDir, entry.name)
      const dest = path.join(basePath, entry.name)
      mergeMoveEntry(src, dest)
    })

    removeFolderIfExists(bestDir)
  } catch (err) {
    console.warn('[flattenDominantSubdir] Error while flattening', basePath, err)
  }
}

export interface InstallIntegrityResult {
  valid: boolean
  warnings: string[]
  fileCount: number
  hasExecutable: boolean
}

/**
 * Reject invalid game payloads before marking a download as installed.
 * Windows first installs require an EXE; Linux native/Proton compatibility
 * retains the less restrictive executable heuristics.
 */
export function validateGameInstall(installPath: string, firstInstall = false): InstallIntegrityResult {
  const result = normalizeGameInstallDir(installPath)
  if (result.fileCount === 0) {
    result.valid = false
    result.warnings.push('No game payload files found after extraction')
  }
  if (process.platform === 'win32' && firstInstall && !result.hasExecutable) {
    result.valid = false
    result.warnings.push('No Windows executable found after extraction')
  }
  if (!result.valid) {
    throw new Error(`Incomplete installation at ${installPath}: ${result.warnings.join('; ')}`)
  }
  return result
}

/**
 * Normalize game install directory structure and validate integrity.
 * Returns integrity check results for logging/debugging purposes.
 */
export function normalizeGameInstallDir(installPath: string): InstallIntegrityResult {
  const result: InstallIntegrityResult = {
    valid: true,
    warnings: [],
    fileCount: 0,
    hasExecutable: false
  }

  try {
    if (!installPath || !fs.existsSync(installPath)) {
      result.valid = false
      result.warnings.push('Install path does not exist')
      return result
    }

    console.log('[normalizeGameInstallDir] Processing:', installPath)

    // Flatten one or two levels of nesting (common in OF releases).
    // Do not flatten the most populated subdirectory: it can be Engine/ or
    // Content/ and is a required part of the game's directory structure.
    flattenSingleSubdir(installPath)

    // Remove common junk folders that sometimes come with releases.
    const junkFolders = ['Fix Repair', 'Fix_Repair', '__MACOSX', 'Thumbs.db']
    for (const junk of junkFolders) {
      removeFolderIfExists(path.join(installPath, junk))
    }

    // Integrity checks
    try {
      result.fileCount = countFilesRecursive(installPath, 5000)

      // Check for very low file count (possibly incomplete extraction)
      if (result.fileCount === 0) {
        result.valid = false
        result.warnings.push('No files found in install directory - extraction may have failed')
      } else if (result.fileCount < 10) {
        result.warnings.push(`Low file count (${result.fileCount}) - install may be incomplete`)
      }

      // Check for executable files (Windows games)
      const hasExe = findFilesRecursive(installPath, /\.exe$/i).length > 0
      const hasSo = findFilesRecursive(installPath, /\.so$/i).length > 0
      const hasApp = findFilesRecursive(installPath, /\.app$/i).length > 0
      result.hasExecutable = hasExe || hasSo || hasApp

      if (!result.hasExecutable) {
        result.warnings.push('No executable files found (.exe, .so, .app)')
      }

      // Check for common game engine files (Unreal Engine)
      const vorbisBase = path.join(installPath, 'Engine', 'Binaries', 'ThirdParty', 'Vorbis')
      if (fs.existsSync(vorbisBase)) {
        const candidates = [
          path.join(vorbisBase, 'Win64', 'VS2015'),
          path.join(vorbisBase, 'Win64', 'VS2017'),
          path.join(vorbisBase, 'Win64', 'VS2019'),
          path.join(vorbisBase, 'Win64', 'VS2022'),
          path.join(vorbisBase, 'Win64'),
        ]
        const foundVorbis = candidates.some(dir => {
          try {
            if (!fs.existsSync(dir)) return false
            const entries = fs.readdirSync(dir)
            return entries.some(n => /^libvorbis(file)?(_64)?\.dll$/i.test(n))
          } catch {
            return false
          }
        })
        if (!foundVorbis) {
          result.warnings.push('Unreal Engine Vorbis DLLs missing - game may crash')
        }
      }

      // Check for Unity games missing required files
      const unityDataFolders = fs.readdirSync(installPath).filter(f =>
        f.endsWith('_Data') && fs.statSync(path.join(installPath, f)).isDirectory()
      )
      if (unityDataFolders.length > 0) {
        const dataFolder = path.join(installPath, unityDataFolders[0])
        const hasGlobalGameManagers = fs.existsSync(path.join(dataFolder, 'globalgamemanagers')) ||
                                       fs.existsSync(path.join(dataFolder, 'mainData'))
        if (!hasGlobalGameManagers) {
          result.warnings.push('Unity game data files may be incomplete')
        }
      }

      // Log warnings
      if (result.warnings.length > 0) {
        console.warn('[normalizeGameInstallDir] Integrity warnings for', installPath)
        result.warnings.forEach(w => console.warn('  -', w))
      } else {
        console.log('[normalizeGameInstallDir] Integrity check passed:', result.fileCount, 'files')
      }

    } catch (integrityErr) {
      result.valid = false
      result.warnings.push('Could not inspect extracted files')
      console.warn('[normalizeGameInstallDir] Integrity check error:', integrityErr)
    }

  } catch (err) {
    console.error('[normalizeGameInstallDir] Failed to process', installPath, err)
    result.valid = false
    result.warnings.push(`Processing error: ${err}`)
  }

  return result
}

/**
 * Start a download (HTTP or torrent) with automatic extraction
 * This is the PUBLIC API that uses the download queue system
 */
interface ProgressDetails extends Partial<TorrentProgress> {
  stage?: 'download' | 'extract'
  extractProgress?: number
  extractEtaSeconds?: number // Estimated time remaining for extraction
}

export async function startGameDownload(
  options: DownloadOptions,
  onProgress?: (progress: number, details?: ProgressDetails) => void
): Promise<StartGameDownloadResult> {
  // Use the queue system
  return queueGameDownload(options, onProgress)
}

/**
 * Internal function that actually executes the download
 * Called by the queue system - not exported directly
 */
async function startGameDownloadInternal(
  options: DownloadOptions,
  onProgress?: (progress: number, details?: ProgressDetails) => void
): Promise<StartGameDownloadResult> {
  const isCancelledError = (err: any) => err?.message === 'cancelled'

  const {
    gameUrl,
    downloadUrl,
    torrentMagnet,
    gameTitle,
    gameVersion,
    gameId: providedGameId,
    autoExtract = true,
    existingDownloadId,
    destPathOverride
  } = options

  // Determine download type
  const downloadType = torrentMagnet ? 'torrent' : 'http'
  const url = torrentMagnet || downloadUrl

  if (!url) {
    return { success: false, error: 'No download URL or torrent magnet provided' }
  }

  // Extract game ID from URL if not provided
  const gameId = providedGameId || extractGameIdFromUrl(gameUrl)
  console.log('[DownloadManager] Game ID:', gameId)

  // Downloads and games are configurable via settings.
  const downloadsPath = resolveDefaultDownloadPath()
  const gamesPath = resolveDefaultGamesPath()
  fs.mkdirSync(downloadsPath, { recursive: true })
  fs.mkdirSync(gamesPath, { recursive: true })

  // Use game ID for folder name if available, otherwise use sanitized title
  const safeName = gameTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  const gameFolderName = gameId || safeName

// Download path (temporary - downloads folder)
const downloadDestPath = destPathOverride || path.join(downloadsPath, gameFolderName)
fs.mkdirSync(downloadDestPath, { recursive: true })

// Install path (final - games folder)
  const installPath = path.join(gamesPath, gameFolderName)
  const hadExistingInstall = hasExistingGameInstall(gameUrl, installPath)
  const firstInstall = !hadExistingInstall

  console.log('[DownloadManager] Paths configured:')
  console.log('[DownloadManager]   gamesPath:', gamesPath)
  console.log('[DownloadManager]   downloadsPath:', downloadsPath)
  console.log('[DownloadManager]   downloadDestPath:', downloadDestPath)
  console.log('[DownloadManager]   installPath:', installPath)
  console.log('[DownloadManager]   destPathOverride:', destPathOverride)
  console.log('[DownloadManager]   firstInstall:', firstInstall)

  const ensureGameRecord = () => {
    addOrUpdateGame(gameUrl, gameTitle)
    if (gameId) {
      updateGameInfo(gameUrl, { game_id: gameId })
    }
  }

  // For HTTP downloads: download zip to downloads folder, extract to games folder
  // For torrents: download to downloads folder, then move contents to games folder after completion
  const fileName = `${safeName}.zip`
  const downloadFilePath = path.join(downloadDestPath, fileName)

  // Create download record in database
  const downloadId = existingDownloadId ?? createDownload({
    game_url: gameUrl,
    title: gameTitle,
    type: downloadType,
    download_url: url,
    dest_path: downloadType === 'torrent' ? downloadDestPath : downloadFilePath,
    install_path: installPath
  })

  // Keep install_path in sync for resumed downloads / older DB rows.
  try {
    updateDownloadInstallPath(Number(downloadId), installPath)
  } catch {
    // ignore
  }

  try {
    let lastDetails: ProgressDetails | undefined
    let capturedInfoHash: string | undefined

    // Update status to downloading
    updateDownloadStatus(Number(downloadId), 'downloading')

    // Start download
    if (downloadType === 'torrent') {
      if (isTorrentActive(url)) {
        console.log('[DownloadManager] Torrent already active, skipping duplicate start:', url)
        return { success: false, error: 'Este torrent já está em andamento' }
      }
      const aliases = [url, String(downloadId)]

      // Create install directory for torrent
      fs.mkdirSync(installPath, { recursive: true })
      writeLauncherMarker(installPath, {
        url: gameUrl,
        title: gameTitle,
        status: 'downloading',
        showInLibrary: false
      })

      // If it's a .torrent URL, download the file first
      let torrentPath = url
      if (url.startsWith('http')) {
        console.log('[DownloadManager] Downloading .torrent file from:', url)
        const tempTorrentPath = path.join(downloadDestPath, 'temp.torrent')

        // Get cookies for authentication
        const ses = session.fromPartition('persist:online-fix')
        const urlObj = new URL(url)
        const cookies = await ses.cookies.get({ url: urlObj.origin })
        const mainCookies = await ses.cookies.get({ url: 'https://online-fix.me' })
        const allCookies = [...cookies, ...mainCookies]
        const uniqueCookies = Array.from(new Map(allCookies.map(c => [c.name, c])).values())
        const cookieHeader = uniqueCookies.map(c => `${c.name}=${c.value}`).join('; ')

        console.log('[DownloadManager] Using cookies for .torrent download:', uniqueCookies.map(c => c.name))

        await downloadFile(url, tempTorrentPath, undefined, {
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://online-fix.me/'
        })
        torrentPath = tempTorrentPath
        console.log('[DownloadManager] .torrent file saved to:', torrentPath)
      }

      // Now download the torrent content directly to games folder.
      // Existing installs only need the Updates folder when the torrent provides it.
      const torrentDownloadMode = firstInstall ? 'all' : 'updates'
      console.log('[DownloadManager] Starting torrent download to:', installPath)
      console.log('[DownloadManager] Torrent file mode:', torrentDownloadMode)
      let lastDbProgressWriteAt = 0
      let lastDbProgressValue = -1
      let infoHashSaved = false
      await downloadTorrent(torrentPath, installPath, (progress, details) => {
        lastDetails = details
        // Save infoHash once (it can repeat on every tick)
        if (!infoHashSaved && details?.infoHash) {
          infoHashSaved = true
          capturedInfoHash = details.infoHash
          updateDownloadInfoHash(Number(downloadId), details.infoHash)
        }

        // Persist progress to DB at a low frequency to avoid heavy JSON fallback writes.
        const now = Date.now()
        const progressDelta = Math.abs((Number(progress) || 0) - lastDbProgressValue)
        const shouldPersist =
          now - lastDbProgressWriteAt > 2000 ||
          progressDelta >= 1 ||
          progress >= 99.5
        if (shouldPersist) {
          lastDbProgressWriteAt = now
          lastDbProgressValue = Number(progress) || 0
          updateDownloadProgress(Number(downloadId), progress)
        }
        onProgress?.(progress, details)
      }, aliases, undefined, torrentDownloadMode)

      // Move downloaded content from temp download folder to final install folder
      moveDirContents(downloadDestPath, installPath)
      // Clean temp download folder (best effort)
      removeFolderIfExists(downloadDestPath)

      // Wait until extraction finishes before modifying the game tree.

      // Remove common junk folders/files (but keep archives for extraction step)
      // Note: normalizeGameInstallDir already removes 'Fix Repair' from installPath
      removeFileIfExists(path.join(installPath, 'temp.torrent'))

      // Only clean downloadDestPath if it still exists (may have been removed by moveDirContents)
      if (fs.existsSync(downloadDestPath)) {
        removeFolderIfExists(path.join(downloadDestPath, 'Fix Repair'))
        removeFileIfExists(path.join(downloadDestPath, 'temp.torrent'))
      }

      // Clean up temp .torrent file if we downloaded it
      if (url.startsWith('http')) {
        safeCleanupTempFiles(downloadDestPath, ['temp.torrent'])
      }
    } else {
      // HTTP download - save to downloads folder
      console.log('[DownloadManager] Starting HTTP download to:', downloadFilePath)
      await downloadFile(url, downloadFilePath, (progress, details) => {
        updateDownloadProgress(
          Number(downloadId),
          progress,
          details?.speed != null ? String(Math.round(details.speed)) : undefined,
          details?.eta != null ? String(Math.round(details.eta)) : undefined
        )
        onProgress?.(progress, {
          stage: 'download',
          progress,
          downloadSpeed: details?.speed ?? 0,
          downloaded: details?.downloaded ?? 0,
          total: details?.total ?? 0,
          timeRemaining: details?.eta ?? 0
        })
      })
    }

    // A completed transfer is not an installed game.
    if (downloadType === 'http' && !autoExtract) updateDownloadStatus(Number(downloadId), 'completed')

    // Auto-extract if enabled (only for HTTP downloads)
    let finalInstallPath = installPath
    if (autoExtract && downloadType === 'http') {
      updateDownloadStatus(Number(downloadId), 'extracting')
      const extractStart = Date.now()

      fs.mkdirSync(installPath, { recursive: true })
      const markerPath = path.join(installPath, '.of_extracting.json')
      try {
        fs.writeFileSync(markerPath, JSON.stringify({ downloadId: Number(downloadId), gameUrl, archivePath: downloadFilePath, startedAt: Date.now() }, null, 2))
      } catch {
        // ignore
      }

      // Create install directory
      fs.mkdirSync(installPath, { recursive: true })
      writeLauncherMarker(installPath, {
        url: gameUrl,
        title: gameTitle,
        status: 'extracting',
        showInLibrary: false
      })

      try {
        console.log(`[DownloadManager] Extracting ${downloadFilePath} to ${installPath}`)
        await extractZipWithPassword(downloadFilePath, installPath, undefined, (percent, details) => {
          updateDownloadProgress(Number(downloadId), percent)
          onProgress?.(percent, {
            stage: 'extract',
            extractProgress: percent,
            extractEtaSeconds: details?.etaSeconds,
            timeRemaining: details?.etaSeconds
          })
        })
        console.log('[DownloadManager] Extraction completed')

        // Flatten/normalize extracted content (avoid nested installs)
        validateGameInstall(installPath, firstInstall)

        // Keep the archive until the DB and completion marker are written.
        // Try to find the executable
        const executablePath = findExecutable(installPath)

        // Mark game as installed with new version (only after extraction completed)
        ensureGameRecord()
        const version = sanitizeVersionText(
          (gameVersion && gameVersion !== 'unknown')
            ? gameVersion
            : (parseVersionFromName(url) || parseVersionFromName(gameTitle) || 'unknown')
        ) || 'unknown'
        console.log('[DownloadManager] ========= MARKING GAME INSTALLED =========')
        console.log('[DownloadManager] gameUrl (to mark):', gameUrl)
        console.log('[DownloadManager] installPath:', installPath)
        console.log('[DownloadManager] version:', version)
        console.log('[DownloadManager] executablePath:', executablePath)
        markGameInstalled(gameUrl, installPath, version, executablePath || undefined)
        writeLauncherMarker(installPath, {
          url: gameUrl,
          title: gameTitle,
          status: 'installed',
          downloadId: Number(downloadId),
          showInLibrary: true,
          installPath,
          version,
          executablePath: executablePath || null
        })

        // Mark download as finished
        try { updateDownloadProgress(Number(downloadId), 100) } catch {}
        updateDownloadStatus(Number(downloadId), 'completed')
        try { fs.unlinkSync(markerPath) } catch {}
        try { fs.writeFileSync(path.join(installPath, '.of_extracted'), String(Date.now())) } catch {}

        // Archive cleanup must not reverse a verified installation's status.
        try {
          fs.unlinkSync(downloadFilePath)
          if (fs.existsSync(downloadDestPath) && fs.readdirSync(downloadDestPath).length === 0) {
            fs.rmdirSync(downloadDestPath)
          }
        } catch (cleanupError) {
          console.warn('[DownloadManager] Archive cleanup failed after install:', cleanupError)
        }

        // Emit final extraction progress to UI
        onProgress?.(100, { stage: 'extract', extractProgress: 100 })

        // Clean up download record from database - game is now installed
        try {
          deleteDownload(Number(downloadId))
          BrowserWindow.getAllWindows().forEach(w => {
            w.webContents.send('download-deleted')
            w.webContents.send('download-complete', {
              magnet: url,
              infoHash: capturedInfoHash || undefined,
              destPath: installPath
            })
          })
          console.log('[DownloadManager] Cleaned up download record after successful HTTP extraction')
          
        } catch {}

        finalInstallPath = installPath
      } catch (extractError: any) {
        console.error('Extraction failed:', extractError)
        updateDownloadStatus(Number(downloadId), 'error', extractError?.message || String(extractError))
        return {
          success: false,
          error: `Download completed but extraction failed: ${extractError.message}`
        }
      }
    } else if (downloadType === 'torrent') {
      // For torrents, check if there are RAR files that need extraction (update scenario)
      console.log('[DownloadManager] Torrent completed, dispatching extraction worker...')

      updateDownloadStatus(Number(downloadId), 'extracting')

      const markerPath = path.join(installPath, '.of_update_extracting.json')
      try {
        fs.writeFileSync(markerPath, JSON.stringify({ downloadId: Number(downloadId), gameUrl, startedAt: Date.now() }, null, 2))
      } catch {
        // ignore
      }

      // Get previous executable path from database before spawning worker
      // (worker can't access db since it imports electron)
      const existingGame = getGame(gameUrl) as { executable_path?: string } | undefined
      const previousExePath = existingGame?.executable_path || null

      // Extraction timeout: 2 hours max (large games can take a while)
      const EXTRACTION_TIMEOUT_MS = 2 * 60 * 60 * 1000

      const updateResult = await new Promise<{ success: boolean; error?: string; executablePath?: string }>((resolve, reject) => {
        const workerPath = path.join(__dirname, 'extractWorker.js')
        const worker = new Worker(workerPath, { workerData: { installPath, gameUrl, previousExePath } })

        let lastProgressTime = Date.now()
        let isResolved = false

        // Timeout handler - checks for stalled extraction
        const timeoutCheck = setInterval(() => {
          const elapsed = Date.now() - lastProgressTime
          // If no progress for 10 minutes, consider it stalled
          if (elapsed > 10 * 60 * 1000) {
            clearInterval(timeoutCheck)
            if (!isResolved) {
              isResolved = true
              console.error('[DownloadManager] Extraction appears stalled, terminating worker')
              try { worker.terminate() } catch {}
              reject(new Error('Extraction stalled - no progress for 10 minutes'))
            }
          }
        }, 30000) // Check every 30 seconds

        // Hard timeout
        const hardTimeout = setTimeout(() => {
          clearInterval(timeoutCheck)
          if (!isResolved) {
            isResolved = true
            console.error('[DownloadManager] Extraction timeout reached (2 hours)')
            try { worker.terminate() } catch {}
            reject(new Error('Extraction timeout - exceeded 2 hours'))
          }
        }, EXTRACTION_TIMEOUT_MS)

        worker.on('message', (msg: any) => {
          lastProgressTime = Date.now() // Reset progress timer on any message

          if (msg?.type === 'progress') {
            const percent = Number(msg.percent) || 0
            updateDownloadProgress(Number(downloadId), percent)
            // Use ETA from worker (calculated from 7z extraction progress)
            const etaSeconds = msg.etaSeconds != null ? Number(msg.etaSeconds) : undefined
            onProgress?.(percent, { stage: 'extract', extractProgress: percent, extractEtaSeconds: etaSeconds })
          } else if (msg?.type === 'done') {
            clearInterval(timeoutCheck)
            clearTimeout(hardTimeout)
            if (!isResolved) {
              isResolved = true
              resolve(msg.result || { success: true })
            }
          } else if (msg?.type === 'error') {
            clearInterval(timeoutCheck)
            clearTimeout(hardTimeout)
            if (!isResolved) {
              isResolved = true
              reject(new Error(msg.error || 'Extraction error'))
            }
          }
        })

        worker.on('error', (err) => {
          clearInterval(timeoutCheck)
          clearTimeout(hardTimeout)
          if (!isResolved) {
            isResolved = true
            reject(err)
          }
        })

        worker.on('exit', (code) => {
          clearInterval(timeoutCheck)
          clearTimeout(hardTimeout)
          if (!isResolved) {
            isResolved = true
            reject(new Error(`Extraction worker exited before completion (code ${code})`))
          }
        })
      })

      if (!updateResult.success) {
        console.error('[DownloadManager] Update extraction failed:', updateResult.error)
        updateDownloadStatus(Number(downloadId), 'error', updateResult.error || 'Extraction failed')
        return {
          success: false,
          error: `Torrent completed but update extraction failed: ${updateResult.error}`
        }
      }

      // Keep archives until the final game payload passes validation.
      validateGameInstall(installPath, firstInstall)
      removeArchives(installPath)
      removeArchives(downloadDestPath)

      // Mark as installed after download (already in games folder)
      ensureGameRecord()
      const executablePath = updateResult.executablePath || findExecutable(installPath)
      const version = sanitizeVersionText(
        (gameVersion && gameVersion !== 'unknown')
          ? gameVersion
          : (parseVersionFromName(url) || parseVersionFromName(gameTitle) || 'unknown')
      ) || 'unknown'
      console.log('[DownloadManager] Marking torrent game installed:')
      console.log('[DownloadManager]   gameUrl:', gameUrl)
      console.log('[DownloadManager]   installPath:', installPath)
      console.log('[DownloadManager]   version:', version)
      console.log('[DownloadManager]   executablePath:', executablePath)
      markGameInstalled(gameUrl, installPath, version, executablePath || undefined)
      writeLauncherMarker(installPath, {
        url: gameUrl,
        title: gameTitle,
        status: 'installed',
        downloadId: Number(downloadId),
        showInLibrary: true,
        installPath,
        version,
        executablePath: executablePath || null
      })

      // Mark download as finished
      try { updateDownloadProgress(Number(downloadId), 100) } catch {}
      updateDownloadStatus(Number(downloadId), 'completed')
      try { fs.unlinkSync(markerPath) } catch {}
      try { fs.writeFileSync(path.join(installPath, '.of_update_extracted'), String(Date.now())) } catch {}

      // Emit final extraction progress to UI
      onProgress?.(100, { stage: 'extract', extractProgress: 100 })

      // Stop torrent to prevent seeding and avoid re-download on restart
      if (capturedInfoHash) {
        try { cancelTorrent(capturedInfoHash) } catch {}
      }

      // Clean up download record from database - game is now installed
      try {
        deleteDownload(Number(downloadId))
        BrowserWindow.getAllWindows().forEach(w => {
          w.webContents.send('download-deleted')
          w.webContents.send('download-complete', {
            magnet: url,
            infoHash: capturedInfoHash || undefined,
            destPath: installPath
          })
        })
        console.log('[DownloadManager] Cleaned up download record after successful torrent extraction')
        
      } catch {}
    } else {
      // Only send final download progress if we did NOT extract.
      // If extraction happened, the extract progress event already signals completion.
      onProgress?.(100, { ...lastDetails, stage: 'download' })
    }

    return {
      success: true,
      installPath: downloadType === 'http' && !autoExtract ? undefined : finalInstallPath,
      firstInstall,
      wasUpdate: !firstInstall
    }
  } catch (error: any) {
    if (isCancelledError(error)) {
      console.log('[DownloadManager] Download cancelled:', url)
      updateDownloadStatus(Number(downloadId), 'cancelled')
      return { success: false, error: 'cancelled' }
    }

    const message = error?.message || String(error || 'Unknown error')
    const errorCode = error?.code || 'UNKNOWN'

    // Enhanced error logging
    console.error('[DownloadManager] Download failed')
    console.error('  URL:', url)
    console.error('  Type:', downloadType)
    console.error('  Error:', message)
    console.error('  Code:', errorCode)
    if (error?.stack) {
      console.error('  Stack:', error.stack.split('\n').slice(0, 5).join('\n'))
    }

    // Categorize errors for better user feedback
    let userFriendlyError = message
    if (message.includes('ENOSPC') || message.includes('no space')) {
      userFriendlyError = 'Espaço em disco insuficiente. Libere espaço e tente novamente.'
    } else if (message.includes('EACCES') || message.includes('permission')) {
      userFriendlyError = 'Permissão negada. Verifique as permissões da pasta de instalação.'
    } else if (message.includes('ENOENT')) {
      userFriendlyError = 'Arquivo ou pasta não encontrado. O download pode estar corrompido.'
    } else if (message.includes('timeout') || message.includes('stalled')) {
      userFriendlyError = 'Download travado ou timeout. Verifique sua conexão e tente novamente.'
    } else if (message.includes('LIBTORRENT_UNAVAILABLE')) {
      userFriendlyError = 'Cliente torrent não disponível. Verifique se as dependências estão instaladas.'
    } else if (message.includes('network') || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      userFriendlyError = 'Erro de conexão. Verifique sua internet e tente novamente.'
    }

    updateDownloadStatus(Number(downloadId), 'error', userFriendlyError)
    
    // Send desktop notification
    try {
      notifyDownloadError(gameTitle || 'Jogo', userFriendlyError)
    } catch (err) {
      console.error('[DownloadManager] Failed to send notification:', err)
    }
    
    return {
      success: false,
      error: userFriendlyError
    }
  }
}

/**
 * Find executable file in game directory
 * Looks for .exe files (Windows games) with smart prioritization
 */
function findExecutable(gameDir: string): string | null {
  console.log('[findExecutable] Searching in:', gameDir)
  try {
    // Collect all exe files with their paths
    const exeFiles: Array<{ name: string; path: string; depth: number }> = []

    function scanDir(dir: string, depth: number = 0) {
      if (depth > 4) return // Don't go too deep
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            // Skip common non-game directories
            const skipDirs = ['__macosx', 'redist', 'directx', '_commonredist', 'vcredist', 'support', 'dotnet']
            if (!skipDirs.includes(entry.name.toLowerCase())) {
              scanDir(fullPath, depth + 1)
            }
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
            exeFiles.push({ name: entry.name, path: fullPath, depth })
          }
        }
      } catch (err) {
        // Ignore permission errors
      }
    }

    scanDir(gameDir)

    if (exeFiles.length === 0) {
      console.log('[findExecutable] No exe files found')
      return null
    }

    console.log('[findExecutable] Found', exeFiles.length, 'exe files')

    // Scoring system for prioritization
    const scoreExe = (exe: { name: string; path: string; depth: number }): number => {
      const nameLower = exe.name.toLowerCase()
      let score = 0

      // Negative scores - files to avoid
      if (nameLower.includes('uninstall')) score -= 100
      if (nameLower.includes('uninst')) score -= 100
      if (nameLower.includes('setup')) score -= 50
      if (nameLower.includes('install')) score -= 50
      if (nameLower.includes('redist')) score -= 50
      if (nameLower.includes('vcredist')) score -= 100
      if (nameLower.includes('dxsetup')) score -= 100
      if (nameLower.includes('directx')) score -= 100
      if (nameLower.includes('dotnet')) score -= 100
      if (nameLower.includes('crash')) score -= 30
      if (nameLower.includes('report')) score -= 30
      if (nameLower.includes('helper')) score -= 20
      if (nameLower.includes('update')) score -= 20
      if (nameLower.includes('patch')) score -= 20

      // Positive scores - likely game executables
      if (nameLower.includes('game')) score += 30
      if (nameLower.includes('launcher')) score += 20
      if (nameLower.includes('play')) score += 20
      if (nameLower.includes('start')) score += 15

      // Files in root directory are more likely to be the main executable
      score += (4 - exe.depth) * 10

      // Larger file names (not just "game.exe") might be more specific
      if (exe.name.length > 10) score += 5

      return score
    }

    // Sort by score (highest first)
    exeFiles.sort((a, b) => scoreExe(b) - scoreExe(a))

    // Log top candidates
    console.log('[findExecutable] Top candidates:')
    exeFiles.slice(0, 5).forEach((exe, i) => {
      console.log(`  ${i + 1}. ${exe.name} (score: ${scoreExe(exe)}, depth: ${exe.depth})`)
    })

    // Return the highest scored executable
    const best = exeFiles[0]
    console.log('[findExecutable] Selected:', best.path)
    return best.path
  } catch (error) {
    console.error('[findExecutable] Error:', error)
    return null
  }
}

export function parseVersionFromName(name: string): string | null {
  if (!name) return null
  const raw = String(name)

  // Try multiple version patterns in order of specificity
  const patterns = [
    // Build format: Build 04122025, Build.04122025, Build_18012025
    /\b(Build[.\s_]*\d{6,10})\b/i,
    // Full semantic versioning with optional v prefix: v1.2.3.4, 1.2.3.4567
    /\bv?(\d+\.\d+\.\d+(?:\.\d+)?)\b/i,
    // Two-part version with v prefix: v1.2
    /\bv(\d+\.\d+)\b/i,
    // Standalone version number after common prefixes
    /(?:version|ver|v)[.\s_-]*(\d+(?:\.\d+)+)/i,
    // Date-based versions: 2024.12.04, 2024-12-04
    /\b(20\d{2}[.\-_]\d{2}[.\-_]\d{2})\b/,
    // Date-based versions reversed: 04.12.2024
    /\b(\d{2}[.\-_]\d{2}[.\-_]20\d{2})\b/,
    // Simple numeric version embedded in filename
    /[_\-.\s](\d+\.\d+(?:\.\d+)*)[_\-.\s]/,
    // Version at end of string before extension
    /[_\-.\s]v?(\d+(?:\.\d+)+)(?:\.[a-z]{2,4})?$/i,
    // Fallback: any version-like pattern
    /\b(\d+\.\d+(?:\.\d+)?)\b/
  ]

  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (match && match[1]) {
      const version = sanitizeVersionText(match[1].trim())
      // Validate it looks like a real version (not just a random number)
      if (version && version.length >= 3) {
        return version
      }
    }
  }

  return null
}

/**
 * Pause a download by torrent ID (only works for torrents)
 */
export async function pauseDownloadByTorrentId(torrentId: string): Promise<boolean> {
  const paused = pauseTorrent(torrentId)
  if (paused) {
    const existing = findDownloadRecord(torrentId)
    if (existing) updateDownloadStatus(Number(existing.id), 'paused')
    console.log('[DownloadManager] Paused torrent:', torrentId)
  }
  return paused
}

/**
 * Resume a download by torrent ID
 */
export async function resumeDownloadByTorrentId(torrentId: string): Promise<boolean> {
  const resumed = resumeTorrent(torrentId)
  if (resumed) {
    const existing = findDownloadRecord(torrentId)
    if (existing) updateDownloadStatus(Number(existing.id), 'downloading')
    console.log('[DownloadManager] Resumed torrent:', torrentId)
    return true
  }

  const existing = findDownloadRecord(torrentId)
  if (!existing) return false

  const status = String(existing?.status || '').toLowerCase()
  if (status === 'extracting') return false

  const type = String(existing?.type || '').toLowerCase()
  if (type !== 'torrent') return false

  const url = String(existing?.download_url || '').trim()
  if (!url) return false

  const gameUrl = String(existing?.game_url || existing?.download_url || '').trim()
  const title = String(existing?.title || 'Download')

  let destPathOverride: string | undefined = String(existing?.dest_path || '').trim() || undefined

  console.log('[DownloadManager] Rehydrating paused torrent download:')
  console.log('[DownloadManager]   torrent url:', url)
  console.log('[DownloadManager]   gameUrl:', gameUrl)
  console.log('[DownloadManager]   title:', title)
  console.log('[DownloadManager]   destPathOverride:', destPathOverride)
  console.log('[DownloadManager]   existing record:', JSON.stringify(existing, null, 2))

  try {
    updateDownloadStatus(Number(existing.id), 'pending')
  } catch {
    // ignore
  }

  // Fire-and-forget: start download in background so IPC returns immediately
  const progressBridge = (progress: number, details?: any) => {
    broadcastDownloadProgress({
      magnet: url,
      url,
      infoHash: details?.infoHash,
      progress,
      speed: details?.downloadSpeed,
      downloaded: details?.downloaded,
      total: details?.total,
      eta: details?.timeRemaining,
      peers: details?.peers,
      seeds: details?.seeds,
      statusMessage: details?.statusMessage,
      agentState: details?.state,
      hasMetadata: details?.hasMetadata,
      stage: details?.stage,
      extractProgress: details?.extractProgress,
      destPath: destPathOverride
    })
  }

  startGameDownload({
    gameUrl,
    torrentMagnet: url,
    gameTitle: title,
    gameVersion: 'unknown',
    existingDownloadId: Number(existing.id),
    destPathOverride,
    autoExtract: getSetting('auto_extract') !== 'false'
  }, progressBridge).then((result) => {
    if (!result.success) {
      console.warn('[DownloadManager] Rehydrated download failed:', result.error)
    }
  }).catch((err) => {
    console.warn('[DownloadManager] Failed to rehydrate paused torrent', err)
  })

  return true
}

/**
 * Cancel a download by torrent ID
 */
export async function cancelDownloadByTorrentId(torrentId: string): Promise<boolean> {
  const download = findDownloadRecord(torrentId)
  const cancelled = cancelTorrent(torrentId)

  if (download) {
    updateDownloadStatus(Number(download.id), 'cancelled')
    const canRemoveInstallPath = shouldRemoveInstallPathOnCancel(download)
    const pathsAreSame = sameResolvedPath(download.dest_path, download.install_path)
    if (!pathsAreSame) {
      safelyRemoveDownloadData(download.dest_path)
    }
    if (canRemoveInstallPath) {
      safelyRemoveDownloadData(download.install_path)
    } else if (download.install_path) {
      console.log('[DownloadManager] Preserving install path on cancel:', download.install_path)
    }
    deleteDownload(Number(download.id))
    // Notify renderer to clear any stale cards
    try {
      const { BrowserWindow } = await import('electron')
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('download-deleted'))
    } catch {
      // ignore
    }
  }

  if (cancelled || download) {
    console.log('[DownloadManager] Cancelled torrent and cleaned up:', torrentId)
    return true
  }
  return false
}

function findDownloadRecord(torrentId: string) {
  const asNumber = Number(torrentId)
  return (
    (getDownloadByInfoHash(torrentId) as DownloadRow | undefined) ||
    (getDownloadByUrl(torrentId) as DownloadRow | undefined) ||
    (getDownloadByGameUrl(torrentId) as DownloadRow | undefined) ||
    (!Number.isNaN(asNumber) ? (getDownloadById(asNumber) as DownloadRow | undefined) : null) ||
    undefined
  )
}

function safelyRemoveDownloadData(destPath?: string | null) {
  if (!destPath) return
  try {
    // Remove the download/install path
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { recursive: true, force: true })
    }

    // If parent is now empty, remove it too (best-effort)
    const parent = path.dirname(destPath)
    if (parent && parent !== '/' && parent !== '.' && parent !== destPath && fs.existsSync(parent)) {
      try {
        const remaining = fs.readdirSync(parent)
        if (remaining.length === 0) {
          fs.rmdirSync(parent)
        }
      } catch (err: any) {
        // ignore ENOTEMPTY, just log others
        if (err?.code !== 'ENOTEMPTY') {
          console.warn('[DownloadManager] Failed to clean parent dir', parent, err)
        }
      }
    }
  } catch (err) {
    console.warn('[DownloadManager] Failed to delete download data for', destPath, err)
  }
}

function sameResolvedPath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  try {
    return path.resolve(String(a)) === path.resolve(String(b))
  } catch {
    return String(a) === String(b)
  }
}

function readLauncherMarker(installPath?: string | null): any | null {
  if (!installPath) return null
  try {
    const markerPath = path.join(String(installPath), '.of_game.json')
    if (!fs.existsSync(markerPath)) return null
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
  } catch {
    return null
  }
}

function shouldRemoveInstallPathOnCancel(download: any): boolean {
  const installPath = String(download?.install_path || '').trim()
  if (!installPath) return false

  try {
    const game = getGame(String(download?.game_url || download?.download_url || '')) as any
    const registeredInstallPath = String(game?.install_path || '').trim()
    if (registeredInstallPath && sameResolvedPath(registeredInstallPath, installPath)) {
      return false
    }
  } catch {
    // Conservatively continue with marker checks below.
  }

  const marker = readLauncherMarker(installPath)
  const markerUrl = String(marker?.url || '').trim()
  const downloadGameUrl = String(download?.game_url || '').trim()
  const markerMatchesDownload = !markerUrl || !downloadGameUrl || markerUrl === downloadGameUrl

  // Only remove install_path automatically when it looks like a launcher-created
  // partial install, not an existing game folder being updated in place.
  return (
    markerMatchesDownload &&
    String(marker?.status || '').toLowerCase() === 'downloading' &&
    marker?.showInLibrary === false
  )
}

/**
 * Move directory contents from src to dest with proper error handling.
 * Throws an error if critical files fail to move.
 */
function moveDirContents(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    console.log('[moveDirContents] Source does not exist, skipping:', src)
    return
  }

  // Guard: skip if source and destination resolve to the same path
  try {
    if (path.resolve(src) === path.resolve(dest)) {
      console.log('[moveDirContents] Source and dest are the same path, skipping:', path.resolve(src))
      return
    }
  } catch {}

  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  const errors: Array<{ path: string; error: string }> = []

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    try {
      if (entry.isDirectory()) {
        // If destination exists, merge; else move
        if (fs.existsSync(destPath)) {
          moveDirContents(srcPath, destPath)
          try { fs.rmSync(srcPath, { recursive: true, force: true }) } catch {}
        } else {
          try {
            fs.renameSync(srcPath, destPath)
          } catch (renameErr) {
            // Fallback to copy+delete for cross-device moves
            fs.cpSync(srcPath, destPath, { recursive: true, force: true })
            fs.rmSync(srcPath, { recursive: true, force: true })
          }
        }
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true })

        // Remove destination if it exists (file or directory)
        if (fs.existsSync(destPath)) {
          const destStat = fs.statSync(destPath)
          if (destStat.isDirectory()) {
            fs.rmSync(destPath, { recursive: true, force: true })
          } else {
            fs.unlinkSync(destPath)
          }
        }

        try {
          fs.renameSync(srcPath, destPath)
        } catch (renameErr) {
          // Fallback to copy+delete for cross-device moves
          fs.copyFileSync(srcPath, destPath)
          fs.unlinkSync(srcPath)
        }
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      console.error('[moveDirContents] Failed to move', srcPath, '->', destPath, errorMsg)
      errors.push({ path: srcPath, error: errorMsg })
    }
  }

  // Partial file moves must fail the installation rather than be swallowed.
  if (errors.length > 0) {
    console.warn(`[moveDirContents] ${errors.length} file(s) failed to move:`)
    errors.slice(0, 10).forEach(e => console.warn(`  - ${e.path}: ${e.error}`))
    if (errors.length > 10) {
      console.warn(`  ... and ${errors.length - 10} more`)
    }
    throw new Error(`Failed to move ${errors.length} downloaded files to the game folder`)
  }
}

/**
 * Find OnlineFix.ini file in game directory
 */
function findOnlineFixIni(gameDir: string): string | null {
  const files = findFilesRecursive(gameDir, /^OnlineFix\.ini$/i)
  return files.length > 0 ? files[0] : null
}

export async function readOnlineFixIni(gameUrl: string): Promise<{ success: boolean; path?: string; content?: string; exists?: boolean; error?: string }> {
  try {
    const game = getGame(gameUrl) as { install_path?: string } | undefined
    const installPath = game?.install_path
    if (!installPath || !fs.existsSync(installPath)) {
      return { success: false, error: 'Pasta do jogo não encontrada' }
    }

    const found = await findAndReadOnlineFixIni(installPath)
    if (found) {
      return { success: true, path: found.path, content: found.content, exists: true }
    }

    // Legacy fallback: some parts of the app assume a path even when the file does not exist yet.
    const legacyFallback = findOnlineFixIni(installPath) || path.join(installPath, 'OnlineFix.ini')
    return { success: true, path: legacyFallback, content: '', exists: false }
  } catch (err: any) {
    return { success: false, error: err?.message || 'Falha ao ler OnlineFix.ini' }
  }
}

export async function writeOnlineFixIni(gameUrl: string, content: string): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const game = getGame(gameUrl) as { install_path?: string } | undefined
    const installPath = game?.install_path
    if (!installPath || !fs.existsSync(installPath)) {
      return { success: false, error: 'Pasta do jogo não encontrada' }
    }

    const found = await findAndReadOnlineFixIni(installPath)
    let iniPath = found?.path

    if (!iniPath) {
      // Prefer steam_settings if present; it's a common location for OF config files.
      const steamSettingsDir = path.join(installPath, 'steam_settings')
      iniPath = fs.existsSync(steamSettingsDir)
        ? path.join(steamSettingsDir, 'OnlineFix.ini')
        : path.join(installPath, 'OnlineFix.ini')
    }

    await fs.promises.mkdir(path.dirname(iniPath), { recursive: true })
    await fs.promises.writeFile(iniPath, content ?? '', 'utf-8')
    return { success: true, path: iniPath }
  } catch (err: any) {
    return { success: false, error: err?.message || 'Falha ao salvar OnlineFix.ini' }
  }
}

// Re-export from extractionUtils for backwards compatibility
export { processUpdateExtraction, findFilesRecursive } from './extractionUtils'
