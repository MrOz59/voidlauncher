import { app, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import archiver from 'archiver'

import * as drive from './drive'
import {
  ludusaviBackupOne,
  ludusaviPreviewBackupOne,
  ludusaviRestoreOne,
  ensureLudusaviAvailable,
  resolveLudusaviBinary,
  resolveLudusaviGameName
} from './ludusavi'
import { detectSaveLocationsAsync, DetectedSaveLocation } from './saveDetector'
import { getGame, getSetting, setSetting } from './db'
import { isValidBackupZip, safeRemoteZipFilename } from './backupIntegrity'
import { chooseSafeSaveAction } from './saveSyncPolicy'
import { makeSaveBundle, unpackSaveBundle, hasLudusaviMapping } from './saveBundles'

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function guessWinePrefixFromCompatData(prefixPath?: string | null): string | undefined {
  const raw = String(prefixPath || '').trim()
  if (!raw) return undefined
  const normalized = raw
  if (normalized.endsWith(`${path.sep}pfx`)) return normalized
  const pfx = path.join(normalized, 'pfx')
  if (fs.existsSync(pfx)) return pfx
  return normalized
}

function newestZipInDir(dir: string, minMtimeMs?: number): string | null {
  try {
    if (!fs.existsSync(dir)) return null
    const entries = fs.readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.zip'))
      .map((n) => path.join(dir, n))

    let best: { p: string; m: number } | null = null
    for (const p of entries) {
      let st: fs.Stats
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (minMtimeMs != null && st.mtimeMs < minMtimeMs) continue
      if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs }
    }
    return best?.p || null
  } catch {
    return null
  }
}

export type CloudSaveSyncOptions = {
  gameUrl?: string
  title?: string
  steamAppId?: string | null
  protonPrefix?: string | null
  gameInstallPath?: string | null
}

export function computeCloudSavesGameKey(opts: CloudSaveSyncOptions): string {
  const steam = String(opts.steamAppId || '').trim()
  if (steam && /^\d+$/.test(steam)) return `steam_${steam}`
  const title = String(opts.title || '').trim()
  if (title) return `title_${slugify(title)}`
  const url = String(opts.gameUrl || '').trim()
  return `url_${slugify(url || 'game')}`
}

function ludusaviConfigDir(): string {
  return path.join(app.getPath('userData'), 'ludusavi-config')
}

function ludusaviBackupDirForGame(gameKey: string): string {
  return path.join(app.getPath('userData'), 'ludusavi-backups', gameKey)
}

export function getLocalLudusaviBackupDir(opts: CloudSaveSyncOptions): string {
  const gameKey = computeCloudSavesGameKey(opts)
  return ludusaviBackupDirForGame(gameKey)
}

function remotePrefixForGame(gameKey: string): string {
  // New canonical prefix (so we can store conflicts without them being auto-restored)
  return `ludusavi_${gameKey}__main_`
}

function remoteLegacyPrefixForGame(gameKey: string): string {
  // Backward compatibility with earlier builds
  return `ludusavi_${gameKey}_`
}

function remoteConflictPrefixForGame(gameKey: string): string {
  return `ludusavi_${gameKey}__conflict_`
}

function remoteHeuristicPrefixForGame(gameKey: string): string {
  // Heuristic ZIPs have a different layout and cannot be restored by Ludusavi.
  return `heuristic_${gameKey}__main_`
}


async function pruneLegacyBackups(gameKey: string): Promise<void> {
  // The old "ludusavi_<game>_" prefix also matches __main_ and __conflict_.
  // Never let legacy retention accidentally delete newer primary backups.
  const prefix = remoteLegacyPrefixForGame(gameKey)
  const entries = await drive.listFilesByNamePrefix(prefix)
  if (!Array.isArray(entries)) return
  const legacy = entries.filter(entry =>
    entry.name.startsWith(prefix) &&
    !entry.name.startsWith(remotePrefixForGame(gameKey)) &&
    !entry.name.startsWith(remoteConflictPrefixForGame(gameKey))
  ).sort((a, b) => (parseDriveModifiedTimeMs(b.modifiedTime) || 0) - (parseDriveModifiedTimeMs(a.modifiedTime) || 0))
  for (const entry of legacy.slice(DRIVE_KEEP_LEGACY_BACKUPS)) {
    const result = await drive.deleteFile(entry.id)
    if (!result.success) console.warn('[CloudSaves] Could not prune old backup:', entry.name, result.message)
  }
}

const DRIVE_KEEP_MAIN_BACKUPS = 10
const DRIVE_KEEP_CONFLICT_BACKUPS = 5
const DRIVE_KEEP_LEGACY_BACKUPS = 2

function parseDriveModifiedTimeMs(modifiedTime?: string): number | null {
  if (!modifiedTime) return null
  const ms = new Date(modifiedTime).getTime()
  return Number.isFinite(ms) ? ms : null
}

function findNewestTimestampMsFromJson(value: any): number | null {
  let best: number | null = null
  const seen = new Set<any>()

  const consider = (n: number) => {
    if (!Number.isFinite(n)) return
    if (n < 0) return
    if (best == null || n > best) best = n
  }

  const walk = (v: any, keyHint?: string) => {
    if (v == null) return
    if (typeof v === 'object') {
      if (seen.has(v)) return
      seen.add(v)
    }

    if (typeof v === 'number') {
      // Heuristic: epoch seconds vs ms
      if (v > 1e12) consider(v)
      else if (v > 1e9) consider(v * 1000)
      return
    }

    if (typeof v === 'string') {
      const s = v.trim()
      // Only treat as time when keys look like timestamps or strings look like ISO
      const key = String(keyHint || '').toLowerCase()
      const keyLooksTime = /(time|mtime|modified|updated|timestamp|latest|newest)/.test(key)
      if (keyLooksTime || /^\d{4}-\d{2}-\d{2}t/i.test(s)) {
        const ms = new Date(s).getTime()
        if (Number.isFinite(ms)) consider(ms)
      }
      return
    }

    if (Array.isArray(v)) {
      for (const item of v) walk(item, keyHint)
      return
    }

    if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        walk(item, k)
      }
    }
  }

  walk(value)
  return best
}

async function getLocalSaveStateMsViaPreview(opts: {
  configDir: string
  backupDir: string
  gameName: string
  winePrefix?: string
}): Promise<number | null> {
  const res = await ludusaviPreviewBackupOne(opts)
  if (!res.ok || !res.json) return null
  return findNewestTimestampMsFromJson(res.json)
}

type RemoteCloudSave = {
  id: string
  name: string
  modifiedTime?: string
  appProperties?: Record<string, string>
}

async function getNewestRemoteForGameKey(gameKey: string): Promise<RemoteCloudSave | null> {
  // v2 objects carry exact game identity and format metadata. List across
  // per-game folders, and never select conflict copies for automatic restore.
  const indexed = await drive.listFilesByAppProperties({ voidGameKey: gameKey, voidRole: 'main' })
  if (Array.isArray(indexed) && indexed.length) {
    const sorted = indexed
      .filter(f => safeRemoteZipFilename(f.name))
      .sort((a, b) => {
        const aTime = Number(a.appProperties?.voidSaveMtime || 0)
        const bTime = Number(b.appProperties?.voidSaveMtime || 0)
        if (aTime > 0 && bTime > 0 && aTime !== bTime) return bTime - aTime
        return (parseDriveModifiedTimeMs(b.modifiedTime) || 0) - (parseDriveModifiedTimeMs(a.modifiedTime) || 0)
      })
    if (sorted.length) return sorted[0]
  }
  // Compatibility: legacy files live in the app root and have no mapping
  // metadata. They must remain visible but cannot be auto-restored blindly.
  const canonical = await drive.getNewestRemoteFileByPrefix(remotePrefixForGame(gameKey))
  const legacy = await drive.listFilesByNamePrefix(remoteLegacyPrefixForGame(gameKey))
  const heuristic = await drive.getNewestRemoteFileByPrefix(remoteHeuristicPrefixForGame(gameKey))
  const candidates: RemoteCloudSave[] = [
    ...(canonical?.name.startsWith(remotePrefixForGame(gameKey)) ? [canonical] : []),
    ...(heuristic?.name.startsWith(remoteHeuristicPrefixForGame(gameKey)) ? [heuristic] : []),
    ...(Array.isArray(legacy) ? legacy.filter(f =>
      f.name.startsWith(remoteLegacyPrefixForGame(gameKey)) &&
      !f.name.startsWith(remotePrefixForGame(gameKey)) &&
      !f.name.startsWith(remoteConflictPrefixForGame(gameKey))
    ) : [])
  ].filter(f => safeRemoteZipFilename(f.name))
  return candidates.sort((a, b) =>
    (parseDriveModifiedTimeMs(b.modifiedTime) || 0) - (parseDriveModifiedTimeMs(a.modifiedTime) || 0))[0] || null
}

export type GameSaveBackup = {
  id: string
  name: string
  modifiedTime?: string
  saveModifiedMs: number | null
  format: string
  role: 'main' | 'conflict' | 'legacy'
  platform?: string
  restorable: boolean
}

export type GameSaveOverview = {
  gameKey: string
  connected: boolean
  local: { exists: boolean; modifiedMs: number | null; locations: Array<{
    path: string; type: string; confidence: string; fileCount: number; modifiedMs: number | null
  }> }
  backups: GameSaveBackup[]
  customLocations: string[]
  recommendation: 'restore' | 'local' | 'ask' | 'none'
}

async function listGameRemoteBackups(gameKey: string): Promise<GameSaveBackup[]> {
  const results = await drive.listSaves()
  if (!Array.isArray(results)) throw new Error(results.error || 'Falha ao listar os backups no Drive.')
  const legacyPrefixes = [
    remotePrefixForGame(gameKey),
    remoteLegacyPrefixForGame(gameKey),
    remoteConflictPrefixForGame(gameKey),
    remoteHeuristicPrefixForGame(gameKey),
    `heuristic_${gameKey}__conflict_`,
    ...(gameKey.startsWith('steam_') && /^steam_\d+$/.test(gameKey)
      ? [`ofsave_${gameKey.slice(6)}_`] : [])
  ]
  const seen = new Set<string>()
  return results.filter(f => {
    if (!f.id || seen.has(f.id) || !safeRemoteZipFilename(f.name)) return false
    const same = f.appProperties?.voidGameKey === gameKey ||
      (!f.appProperties?.voidGameKey && legacyPrefixes.some(prefix => f.name.startsWith(prefix)))
    if (same) seen.add(f.id)
    return same
  }).map(f => {
    const props = f.appProperties || {}
    const format = String(props.voidFormat || 'legacy')
    const role: GameSaveBackup['role'] = props.voidRole === 'conflict' ? 'conflict'
      : props.voidRole === 'main' ? 'main' : 'legacy'
    const timestamp = Number(props.voidSaveMtime || 0)
    const platform = props.voidPlatform || undefined
    const restorable = props.voidSchema === '2' && props.voidGameKey === gameKey &&
      (format === 'ludusavi-bundle' || format === 'heuristic-bundle') &&
      platform === process.platform
    return {
      id: f.id, name: f.name, modifiedTime: f.modifiedTime,
      saveModifiedMs: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
      format, role, platform, restorable
    }
  }).sort((a, b) => (b.saveModifiedMs || Date.parse(b.modifiedTime || '') || 0) -
    (a.saveModifiedMs || Date.parse(a.modifiedTime || '') || 0))
}

/** Called only on user request, not for every card in the library grid. */
export async function getGameSaveOverview(opts: CloudSaveSyncOptions): Promise<GameSaveOverview> {
  const gameKey = computeCloudSavesGameKey(opts)
  const configDir = ludusaviConfigDir()
  const backupDir = ludusaviBackupDirForGame(gameKey)
  const winePrefix = guessWinePrefixFromCompatData(opts.protonPrefix)
  const ludusaviBinary = await resolveLudusaviBinary()
  const gameName = ludusaviBinary ? await resolveLudusaviGameName({
    steamId: opts.steamAppId, title: opts.title
  }) : null
  const local = await inspectLocalSaves(opts, configDir, backupDir, gameName, winePrefix)
  const connected = drive.isCloudSavesEnabled()
  const backups = connected ? await listGameRemoteBackups(gameKey) : []
  const newest = backups.find(b => b.restorable && b.role === 'main')
  return {
    gameKey, connected,
    local: {
      exists: local.exists,
      modifiedMs: local.modifiedMs,
      locations: local.locations.map(loc => ({
        path: loc.path, type: loc.type, confidence: loc.confidence,
        fileCount: loc.saveFileCount || 0,
        modifiedMs: loc.lastModified?.getTime() || null
      }))
    },
    backups,
    customLocations: getCustomSaveLocations(gameKey),
    recommendation: chooseSafeSaveAction(
      { exists: local.exists, modifiedMs: local.modifiedMs },
      { exists: !!newest, modifiedMs: newest?.saveModifiedMs || null }
    )
  }
}

/** Only allow a selected file that still belongs to this exact game. */
export async function getGameBackupById(opts: CloudSaveSyncOptions, fileId: string): Promise<GameSaveBackup | null> {
  const backups = await listGameRemoteBackups(computeCloudSavesGameKey(opts))
  return backups.find(b => b.id === fileId) || null
}

/**
 * Some games store saves as extensionless files or proprietary .db/.profile
 * files. When PCGamingWiki identifies the actual save directory, treat a
 * non-empty directory as a local save even if the extension is unknown.
 */
function locationContainsSaves(loc: DetectedSaveLocation): boolean {
  if (loc.source === 'manual') return (loc.saveFileCount || 0) > 0
  if ((loc.saveFileCount || 0) > 0) return true
  if (loc.type !== 'pcgamingwiki' && loc.type !== 'onlinefix' &&
      !/(?:^|[\\/])(savegames?|savedata|remote|profiles?)(?:[\\/]|$)/i.test(loc.path)) return false
  const stack: Array<{ dir: string; depth: number }> = [{ dir: loc.path, depth: 0 }]
  while (stack.length) {
    const item = stack.pop()!
    if (item.depth > 4) continue
    try {
      for (const entry of fs.readdirSync(item.dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          stack.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
        } else if (entry.isFile() && !/^Thumbs\.db$|^desktop\.ini$|^\.DS_Store$/i.test(entry.name)) {
          return true
        }
      }
    } catch {}
  }
  return false
}

const customSaveSettingKey = (gameKey: string) => `cloud_save_locations_${gameKey}`

/** Explicitly selected save folders, kept separate for each game. */
export function getCustomSaveLocations(gameKey: string): string[] {
  try {
    const stored = JSON.parse(String(getSetting(customSaveSettingKey(gameKey)) || '[]'))
    if (!Array.isArray(stored)) return []
    return stored.filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))
      .slice(0, 20)
  } catch {
    return []
  }
}

export function addCustomSaveLocation(gameKey: string, folder: string): void {
  const root = path.resolve(folder)
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Selecione uma pasta local de saves.')
  const home = path.resolve(app.getPath('home'))
  const disallowed = [path.parse(root).root, home, app.getPath('downloads'),
    path.join(home, 'Documents'), path.join(home, 'Desktop'),
    path.join(home, 'AppData'), path.join(home, '.config')].map(p => path.resolve(p))
  if (disallowed.some(p => process.platform === 'win32' ? p.toLowerCase() === root.toLowerCase() : p === root)) {
    throw new Error('Selecione a pasta específica do jogo, não uma pasta geral do sistema.')
  }
  const entries = new Set(getCustomSaveLocations(gameKey))
  if (entries.size >= 20 && !entries.has(root)) throw new Error('Limite de 20 pastas manuais por jogo.')
  entries.add(root)
  setSetting(customSaveSettingKey(gameKey), JSON.stringify([...entries]))
}

export function removeCustomSaveLocation(gameKey: string, folder: string): void {
  const entries = getCustomSaveLocations(gameKey).filter(p => path.resolve(p) !== path.resolve(folder))
  setSetting(customSaveSettingKey(gameKey), JSON.stringify(entries))
}

function scanCustomLocation(folder: string): DetectedSaveLocation {
  let fileCount = 0
  let size = 0
  let latest = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }]
  while (stack.length && fileCount < 25000) {
    const item = stack.pop()!
    if (item.depth > 8) continue
    try {
      for (const entry of fs.readdirSync(item.dir, { withFileTypes: true })) {
        const p = path.join(item.dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) stack.push({ dir: p, depth: item.depth + 1 })
        else if (entry.isFile()) {
          const stat = fs.statSync(p)
          fileCount++
          size += stat.size
          latest = Math.max(latest, stat.mtimeMs)
        }
      }
    } catch {}
  }
  return {
    path: folder, type: 'unknown', source: 'manual', confidence: 'high',
    saveFileCount: fileCount, totalSize: size, lastModified: latest ? new Date(latest) : undefined
  }
}

type LocalSaveSnapshot = {
  exists: boolean
  modifiedMs: number | null
  locations: DetectedSaveLocation[]
}

async function inspectLocalSaves(
  opts: CloudSaveSyncOptions, configDir: string, backupDir: string,
  gameName: string | null, winePrefix: string | undefined
): Promise<LocalSaveSnapshot> {
  const savedGame = opts.gameUrl ? (getGame(opts.gameUrl) as any) : null
  const locations = await detectSaveLocationsAsync({
    winePrefix,
    gameInstallPath: opts.gameInstallPath || savedGame?.install_path || undefined,
    gameTitle: opts.title || savedGame?.title || undefined,
    steamAppId: opts.steamAppId || savedGame?.steam_app_id || undefined
  })
  // Manual paths supplement Ludusavi and PCGamingWiki; never discard them.
  const gameKey = computeCloudSavesGameKey(opts)
  const manual = getCustomSaveLocations(gameKey).map(folder => {
    try { return fs.statSync(folder).isDirectory() ? scanCustomLocation(folder) : null }
    catch { return null }
  }).filter((loc): loc is DetectedSaveLocation => loc !== null)
  const known = new Set(locations.map(loc => path.resolve(loc.path).toLowerCase()))
  for (const loc of manual) if (!known.has(path.resolve(loc.path).toLowerCase())) locations.push(loc)
  const real = locations.filter(loc => (loc.source === 'manual' && (loc.saveFileCount || 0) > 0) || locationContainsSaves(loc))
  let modifiedMs: number | null = null
  for (const loc of real) {
    const at = loc.lastModified?.getTime()
    if (at != null && Number.isFinite(at)) modifiedMs = Math.max(modifiedMs || 0, at)
  }
  // Preview is only a fallback when path heuristics can't identify local data.
  if (!real.length && gameName) {
    const preview = await getLocalSaveStateMsViaPreview({ configDir, backupDir, gameName, winePrefix })
    if (preview != null) return { exists: true, modifiedMs: preview, locations }
  }
  return { exists: real.length > 0, modifiedMs, locations }
}


/**
 * Create a zip backup of detected save locations using system zip command
 */
async function createHeuristicBackup(
  locations: DetectedSaveLocation[],
  backupDir: string,
  gameTitle?: string,
  gameKey?: string
): Promise<{ success: boolean; zipPath?: string; message?: string }> {
  if (locations.length === 0) {
    return { success: false, message: 'Nenhuma pasta de saves detectada.' }
  }

  ensureDir(backupDir)
  
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safeName = slugify(gameTitle || 'game')
  const zipName = `heuristic_${safeName}_${ts}.zip`
  const zipPath = path.join(backupDir, zipName)

  // Filter to only high/medium confidence and existing paths with actual content
  const validLocations = locations.filter(l => {
    if (l.confidence !== 'high' && l.confidence !== 'medium') return false
    if (!fs.existsSync(l.path)) return false
    // Skip empty folders or folders with no recent activity
    if (!locationContainsSaves(l)) return false
    return true
  })

  if (validLocations.length === 0) {
    return { success: false, message: 'Nenhuma pasta de saves válida encontrada.' }
  }

  console.log('[CloudSaves] Creating heuristic backup with', validLocations.length, 'locations')
  for (const loc of validLocations) {
    console.log(`  - ${loc.type}: ${loc.path} (${loc.saveFileCount || 0} files)`)
  }

  try {
    // Create manifest with metadata
    const manifest = {
      created: new Date().toISOString(),
      gameTitle,
      platform: process.platform,
      locations: validLocations.map(l => ({
        path: l.path,
        type: l.type,
        confidence: l.confidence,
        steamAppId: l.steamAppId,
        gameName: l.gameName,
        saveFileCount: l.saveFileCount,
        totalSize: l.totalSize,
        lastModified: l.lastModified?.toISOString()
      }))
    }

    // Create zip using archiver (no external zip command needed)
    return new Promise((resolve) => {
      const output = fs.createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 9 } })

      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        console.error('[CloudSaves] Failed creating save archive:', err)
        try { output.destroy() } catch {}
        try { fs.rmSync(zipPath, { force: true }) } catch {}
        resolve({ success: false, message: err.message })
      }

      output.on('close', () => {
        if (settled) return
        settled = true
        if (!isValidBackupZip(zipPath)) {
          try { fs.rmSync(zipPath, { force: true }) } catch {}
          resolve({ success: false, message: 'Backup ZIP incompleto ou inválido.' })
          return
        }
        const size = archive.pointer()
        console.log('[CloudSaves] Heuristic backup created:', zipPath, `(${(size / 1024).toFixed(1)} KB)`)
        resolve({ success: true, zipPath })
      })

      output.on('error', fail)
      archive.on('error', fail)
      archive.on('warning', fail)

      archive.pipe(output)

      // Add manifest
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
      archive.append(JSON.stringify({
        version: 2, format: 'heuristic-bundle',
        platform: process.platform, gameTitle,
        gameKey: gameKey || computeCloudSavesGameKey({ title: gameTitle })
      }, null, 2), { name: '.void-save-bundle.json' })

      // Add each save location as a directory
      for (let i = 0; i < validLocations.length; i++) {
        const loc = validLocations[i]
        const folderName = `${i}_${loc.type}_${loc.steamAppId || loc.gameName || 'saves'}`.replace(/[^a-zA-Z0-9_-]/g, '_')
        
        // Add directory contents to archive
        archive.directory(loc.path, folderName)
      }

      archive.finalize()
    })
  } catch (err: any) {
    console.error('[CloudSaves] Failed to create heuristic backup:', err)
    return { success: false, message: err?.message || String(err) }
  }
}

/**
 * Restore heuristic archives without trusting arbitrary destination paths:
 * bundle identity, platform, game folder, symlinks and safe roots are checked.
 * Only reached after conflict policy approved restore and recovery succeeded.
 */
function restoreHeuristicSnapshot(
  staging: string,
  manifest: any,
  opts: CloudSaveSyncOptions,
  gameKey: string
): void {
  const infoPath = path.join(staging, 'manifest.json')
  if (!fs.existsSync(infoPath)) throw new Error('Heuristic save manifest missing')
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'))
  const expectedTitle = slugify(opts.title || '')
  if (manifest.gameKey !== gameKey || slugify(info.gameTitle || '') !== expectedTitle ||
      manifest.platform !== process.platform) {
    throw new Error('Backup belongs to a different game or operating system')
  }
  if (!Array.isArray(info.locations) || info.locations.length === 0) {
    throw new Error('Save backup has no mapped locations')
  }
  const appHome = app.getPath('home')
  const protonRoot = guessWinePrefixFromCompatData(opts.protonPrefix)
  const gameFolder = opts.gameInstallPath || (opts.gameUrl ? (getGame(opts.gameUrl) as any)?.install_path : '') || ''
  const approvedRoots = [appHome, protonRoot, gameFolder,
    ...getCustomSaveLocations(gameKey)].filter(Boolean).map(p => path.resolve(String(p)))
  const underRoot = (target: string, root: string) => {
    const rel = path.relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  }
  const planned: Array<{ from: string; to: string }> = []
  for (let i = 0; i < info.locations.length; i++) {
    const item = info.locations[i]
    const to = path.resolve(String(item?.path || ''))
    const folderName = `${i}_${item.type}_${item.steamAppId || item.gameName || 'saves'}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    const from = path.join(staging, folderName)
    if (!path.isAbsolute(String(item.path || '')) ||
        !approvedRoots.some(root => underRoot(to, root)) ||
        !fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
      throw new Error('Unsafe or missing save destination in cloud archive')
    }
    // Prevent writing through a symlink in any existing destination parent.
    let cursor = to
    while (path.dirname(cursor) !== cursor) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error('Refusing to restore saves through a symlink')
      }
      cursor = path.dirname(cursor)
    }
    planned.push({ from, to })
  }
  for (const { from, to } of planned) {
    fs.mkdirSync(to, { recursive: true })
    fs.cpSync(from, to, { recursive: true, force: true })
  }
}

/**
 * Called after install and before launch. It may restore only when no local
 * saves exist, or after an explicit user choice and an independent recovery
 * snapshot. Old backups without bundled metadata are never auto-restored.
 */
export async function restoreCloudSavesBeforeLaunch(
  opts: CloudSaveSyncOptions,
  selectedRemoteId?: string
): Promise<{ success: boolean; message?: string; skipped?: boolean }> {
  if (!drive.isCloudSavesEnabled()) {
    return { success: true, skipped: true, message: 'Cloud Saves desabilitado.' }
  }
  const gameKey = computeCloudSavesGameKey(opts)
  let remote = await getNewestRemoteForGameKey(gameKey)
  if (selectedRemoteId) {
    const selected = await getGameBackupById(opts, selectedRemoteId)
    if (!selected || !selected.restorable) {
      return { success: false, message: 'Backup não pertence a este jogo ou não pode ser restaurado neste sistema.' }
    }
    remote = { id: selected.id, name: selected.name, modifiedTime: selected.modifiedTime,
      appProperties: {
        voidGameKey: gameKey, voidRole: selected.role, voidFormat: selected.format,
        voidPlatform: selected.platform || '', voidSchema: '2',
        voidSaveMtime: selected.saveModifiedMs ? String(selected.saveModifiedMs) : ''
      } }
  }
  if (!remote) return { success: true, skipped: true, message: 'Nenhum backup remoto encontrado.' }

  const configDir = ludusaviConfigDir()
  const backupDir = ludusaviBackupDirForGame(gameKey)
  ensureDir(configDir)
  ensureDir(backupDir)
  const winePrefix = guessWinePrefixFromCompatData(opts.protonPrefix)
  const name = await resolveLudusaviGameName({ steamId: opts.steamAppId, title: opts.title })
  const local = await inspectLocalSaves(opts, configDir, backupDir, name, winePrefix)
  const props = remote.appProperties || {}
  const remoteTimestamp = Number(props.voidSaveMtime)
  const remoteSaveMs = Number.isFinite(remoteTimestamp) && remoteTimestamp > 0 ? remoteTimestamp : null
  const action = selectedRemoteId && local.exists ? 'ask' : chooseSafeSaveAction(
    { exists: local.exists, modifiedMs: local.modifiedMs },
    { exists: true, modifiedMs: remoteSaveMs }
  )
  if (action === 'local' || action === 'none') {
    return { success: true, skipped: true, message: 'Save local preservado; não houve sobrescrita.' }
  }

  const format = String(props.voidFormat || '')
  if (!['ludusavi-bundle', 'heuristic-bundle'].includes(format)) {
    return {
      success: true, skipped: true,
      message: 'Backup antigo sem estrutura de restauração verificável. Preservado no Drive para recuperação manual.'
    }
  }

  if (action === 'ask') {
    const readable = (time: number | null) => time != null ? new Date(time).toLocaleString() : 'data desconhecida'
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: 'Conflito de saves - VoidLauncher',
      message: `Foram encontrados saves locais e no Drive para ${opts.title || gameKey}.`,
      detail: `Local: ${readable(local.modifiedMs)}\nDrive: ${readable(remoteSaveMs)}\n\nRestaurar do Drive irá substituir arquivos locais. O launcher criará uma cópia de segurança primeiro.`,
      buttons: ['Manter saves locais', 'Restaurar do Drive', 'Cancelar'],
      defaultId: 0, cancelId: 2, noLink: true
    })
    if (answer.response !== 1) {
      return { success: true, skipped: true, message: 'Conflito preservado: usuário manteve os saves locais.' }
    }
  }

  // Before any overwrite, create an independent, local recovery point.
  if (local.exists) {
    const rescueDir = path.join(app.getPath('userData'), 'ludusavi-recovery', gameKey, String(Date.now()))
    ensureDir(rescueDir)
    let rescued = false
    if (name) {
      await ensureLudusaviAvailable({ allowDownload: true })
      const rescue = await ludusaviBackupOne({ configDir, backupDir: rescueDir, gameName: name, winePrefix })
      rescued = rescue.ok && hasLudusaviMapping(rescueDir)
    }
    if (!rescued && local.locations.some(locationContainsSaves)) {
      const heuristic = await createHeuristicBackup(
        local.locations.filter(locationContainsSaves),
        rescueDir, opts.title, gameKey
      )
      rescued = heuristic.success && !!heuristic.zipPath && isValidBackupZip(heuristic.zipPath)
    }
    if (!rescued) return {
      success: false,
      message: 'Restauração cancelada: não foi possível preservar um backup local de segurança.'
    }
  }

  const remoteName = safeRemoteZipFilename(remote.name)
  if (!remoteName) return { success: false, message: 'Nome inválido do backup remoto.' }
  const staging = fs.mkdtempSync(path.join(app.getPath('temp'), 'void-save-restore-'))
  try {
    const downloaded = path.join(staging, remoteName)
    const res = await drive.downloadSave(remote.id, downloaded)
    if (!res.success) throw new Error(res.message || 'Falha ao baixar backup remoto')
    const unpackDir = path.join(staging, 'contents')
    const manifest = await unpackSaveBundle(downloaded, unpackDir)
    if (manifest.gameKey !== gameKey || manifest.format !== format ||
        manifest.platform !== process.platform) {
      throw new Error('Backup pertence a outro jogo ou plataforma; restauração bloqueada')
    }
    if (format === 'ludusavi-bundle') {
      if (!hasLudusaviMapping(unpackDir)) throw new Error('Snapshot Ludusavi sem mapping.yaml ou arquivos')
      await ensureLudusaviAvailable({ allowDownload: true })
      const restoreName = await resolveLudusaviGameName({ steamId: opts.steamAppId, title: opts.title })
      if (!restoreName) throw new Error('Nome do jogo não identificado no Ludusavi')
      const result = await ludusaviRestoreOne({ configDir, backupDir: unpackDir, gameName: restoreName })
      if (!result.ok) throw new Error(result.stderr || result.stdout || 'Ludusavi não conseguiu restaurar o backup')
    } else {
      restoreHeuristicSnapshot(unpackDir, manifest, opts, gameKey)
    }
    return { success: true, message: 'Save restaurado do Drive com verificação de origem e formato.' }
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) }
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch {}
  }
}

export async function backupCloudSavesAfterExit(opts: CloudSaveSyncOptions): Promise<{ success: boolean; message?: string; skipped?: boolean; fileId?: string }> {
  // Check if cloud saves feature is enabled
  if (!drive.isCloudSavesEnabled()) {
    return { success: true, skipped: true, message: 'Cloud Saves desabilitado.' }
  }

  const gameKey = computeCloudSavesGameKey(opts)
  const configDir = ludusaviConfigDir()
  const backupDir = ludusaviBackupDirForGame(gameKey)
  ensureDir(configDir)
  ensureDir(backupDir)

  const winePrefix = guessWinePrefixFromCompatData(opts.protonPrefix)
  const knownInstall = String(opts.gameInstallPath ||
    (opts.gameUrl ? (getGame(opts.gameUrl) as any)?.install_path : '') || '').trim()
  const bin = await resolveLudusaviBinary()
  const resolvedName = bin ? await resolveLudusaviGameName({
    steamId: opts.steamAppId, title: opts.title
  }) : null
  const local = await inspectLocalSaves(opts, configDir, backupDir, resolvedName, winePrefix)
  const remote = await getNewestRemoteForGameKey(gameKey)
  const remoteSaveAt = Number(remote?.appProperties?.voidSaveMtime || 0)
  const remoteIsNewer = !!remote && (
    !local.modifiedMs || !Number.isFinite(remoteSaveAt) || remoteSaveAt <= 0 ||
    remoteSaveAt > local.modifiedMs + 30_000
  )

  let zipPath: string | null = null
  let usedHeuristic = false

  // Save the entire Ludusavi game directory (mapping.yaml + ZIP data).
  // A standalone archive inside it is not a restorable Ludusavi backup.
  if (bin && resolvedName && getCustomSaveLocations(gameKey).length === 0) {
    const snapshotRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'void-ludusavi-backup-'))
    try {
      const result = await ludusaviBackupOne({
        configDir, backupDir: snapshotRoot, gameName: resolvedName, winePrefix
      })
      if (result.ok && hasLudusaviMapping(snapshotRoot)) {
        const filename = `bundle_${Date.now()}.zip`
        zipPath = await makeSaveBundle(snapshotRoot, path.join(backupDir, filename), {
          version: 2,
          format: 'ludusavi-bundle',
          platform: process.platform,
          gameKey,
          gameTitle: opts.title || resolvedName,
          steamAppId: opts.steamAppId || null
        })
      } else {
        console.warn('[CloudSaves] Ludusavi did not create a complete restorable snapshot', result.stderr)
      }
    } catch (err) {
      console.warn('[CloudSaves] Cannot bundle Ludusavi snapshot:', err)
    } finally {
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }) } catch {}
    }
  }

  // Fallback to heuristic detection. Native Windows games have no wine prefix.
  if (!zipPath && (winePrefix || process.platform === 'win32' || knownInstall)) {
    console.log('[CloudSaves] Using heuristic save detection (includes PCGamingWiki lookup)...')
    
    // Use async version that includes PCGamingWiki lookup
    const detected = await detectSaveLocationsAsync({
      winePrefix,
      gameInstallPath: knownInstall || undefined,
      gameTitle: opts.title || undefined,
      steamAppId: opts.steamAppId || undefined
    })

    if (detected.length > 0) {
      console.log('[CloudSaves] Detected', detected.length, 'save locations via heuristics/PCGamingWiki')
      const heuristicResult = await createHeuristicBackup(detected, backupDir, opts.title || undefined, gameKey)
      if (heuristicResult.success && heuristicResult.zipPath) {
        zipPath = heuristicResult.zipPath
        usedHeuristic = true
      }
    } else {
      console.log('[CloudSaves] No save locations detected via heuristics/PCGamingWiki')
    }
  }

  if (!zipPath) {
    return { success: false, message: 'Nenhum save encontrado (Ludusavi e heurística falharam).' }
  }

  if (!isValidBackupZip(zipPath)) {
    return { success: false, message: 'Backup local inválido; upload cancelado para proteger os saves remotos.' }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const format = usedHeuristic ? 'heuristic-bundle' : 'ludusavi-bundle'
  const role = remoteIsNewer ? 'conflict' : 'main'
  const prefix = usedHeuristic
    ? (remoteIsNewer ? `heuristic_${gameKey}__conflict_` : remoteHeuristicPrefixForGame(gameKey))
    : (remoteIsNewer ? remoteConflictPrefixForGame(gameKey) : remotePrefixForGame(gameKey))
  const remoteName = `${prefix}${ts}.zip`
  const metadata = {
    voidGameKey: gameKey,
    voidGameTitle: String(opts.title || '').slice(0, 120),
    voidSteamAppId: String(opts.steamAppId || '').slice(0, 32),
    voidFormat: format,
    voidRole: role,
    voidSaveMtime: local.modifiedMs ? String(local.modifiedMs) : '',
    voidPlatform: process.platform,
    voidSchema: '2'
  }
  const up = await drive.uploadSave(zipPath, remoteName, { appProperties: metadata })
  if (!up.success) return { success: false, message: up.message || 'Falha ao enviar backup ao Drive.' }

  // Only prune valid, indexed v2 backups within this game and role. Never
  // prune legacy archives whose format cannot yet be recovered automatically.
  try {
    const prune = await drive.pruneFilesByAppProperties({
      voidGameKey: gameKey, voidRole: role, voidFormat: format
    }, role === 'conflict' ? DRIVE_KEEP_CONFLICT_BACKUPS : DRIVE_KEEP_MAIN_BACKUPS)
    if (!prune.success) console.warn('[CloudSaves] Retention failed:', prune.message)
  } catch (err) {
    console.warn('[CloudSaves] Drive retention error:', err)
  }

  const methodUsed = usedHeuristic ? 'heurística' : 'Ludusavi'
  return {
    success: true, fileId: up.id,
    message: remoteIsNewer
      ? `Saves remotos mais novos; backup local via ${methodUsed} preservado separadamente como conflito.`
      : `Backup realizado via ${methodUsed}.`
  }
}

export async function syncCloudSavesManual(opts: CloudSaveSyncOptions): Promise<{ success: boolean; message?: string }> {
  const restore = await restoreCloudSavesBeforeLaunch(opts)
  if (!restore.success) return { success: false, message: restore.message }

  // If there was nothing to restore, still ensure we have at least one backup in the cloud.
  const backup = await backupCloudSavesAfterExit(opts)
  if (!backup.success) return { success: false, message: backup.message }

  const restoreSkipped = Boolean((restore as any)?.skipped)
  const backupSkipped = Boolean((backup as any)?.skipped)
  if (restoreSkipped && backupSkipped) {
    return { success: false, message: 'Ludusavi não encontrado; usando método legado.' }
  }

  return { success: true }
}
