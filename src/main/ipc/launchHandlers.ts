/**
 * IPC Handlers for Game Launch/Stop
 */
import { app, dialog } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import {
  getAllGames,
  updateGameInfo,
  updateGamePlayTime,
  extractGameIdFromUrl
} from '../db'
import {
  isLinux,
  buildProtonLaunch,
  ensureGamePrefixFromDefault
} from '../protonManager'
import * as drive from '../drive'
import * as cloudSaves from '../cloudSaves'
import { getActiveVpnSession } from '../vpnSession'
import { appendCloudSavesHistory, type CloudSavesHistoryEntry } from '../cloudSavesHistory'
import { detectSteamAppIdFromInstall } from './achievementsHandlers'
import type { IpcContext, IpcHandlerRegistrar, RunningGameProc } from './types'
import { getOverlayIPC, removeOverlayIPC } from '../overlayIPC'
import { createOverlayServer, removeOverlayServer, getOverlayServer } from '../overlayIPCServer'
import { notifyAchievementUnlocked, setCurrentGamePid, NOTIFICATIONS_ENABLED } from '../desktopNotifications'
import {
  slugify,
  isPidAlive,
  killProcessTreeBestEffort,
  readFileTailBytes,
  readFileHeadTailBytes,
  trimToHeadAndTailChars,
  trimToMaxChars,
  compactProtonLogParts,
  extractInterestingProtonLog,
  findExecutableInDir,
  findEpicAuthLauncherInDir,
  findWin64ShippingExecutableInDir,
  waitMs,
  normalizeSteamId,
  resolveOverlayCompatibility
} from '../utils'
import { extractOnlineFixOverlayIds, findAndReadOnlineFixIni } from '../utils/onlinefixIni'
import { ensureLegendaryAvailable } from '../legendary'

const LIVE_LOG_MAX_CHARS = 300_000
const LIVE_LOG_HEAD_CHARS = 80_000
const LIVE_LOG_TAIL_CHARS = 220_000

// ============================================================================
// Local Helpers
// ============================================================================

function recordCloudSaves(entry: CloudSavesHistoryEntry) {
  try {
    appendCloudSavesHistory(entry)
  } catch {
    // ignore
  }
}

function resolveWinePrefixPath(prefixPath: string): string {
  if (!prefixPath) return prefixPath
  const pfx = path.join(prefixPath, 'pfx')
  if (fs.existsSync(path.join(pfx, 'drive_c'))) return pfx
  if (fs.existsSync(path.join(prefixPath, 'drive_c'))) return prefixPath
  return prefixPath
}

function appendLiveLogChunk(record: RunningGameProc | undefined, chunk: string) {
  if (!record || !chunk) return
  const currentHead = record.liveLogHeadBuffer || ''
  const headRoom = Math.max(0, LIVE_LOG_HEAD_CHARS - currentHead.length)
  if (headRoom > 0) {
    record.liveLogHeadBuffer = currentHead + chunk.slice(0, headRoom)
    const overflow = chunk.slice(headRoom)
    if (overflow) {
      record.liveLogDroppedChars = (record.liveLogDroppedChars || 0) + overflow.length
      record.liveLogTailBuffer = trimToMaxChars(`${record.liveLogTailBuffer || ''}${overflow}`, LIVE_LOG_TAIL_CHARS)
    }
  } else {
    record.liveLogDroppedChars = (record.liveLogDroppedChars || 0) + chunk.length
    record.liveLogTailBuffer = trimToMaxChars(`${record.liveLogTailBuffer || ''}${chunk}`, LIVE_LOG_TAIL_CHARS)
  }
  record.liveLogBuffer = trimToHeadAndTailChars(
    `${record.liveLogHeadBuffer || ''}${record.liveLogDroppedChars ? `\n\n...[${record.liveLogDroppedChars} caracteres intermediarios omitidos]...\n\n` : ''}${record.liveLogTailBuffer || ''}`,
    LIVE_LOG_MAX_CHARS
  )
  record.liveLogUpdatedAt = Date.now()
}

function filterBenignLauncherStderr(text: string): string {
  const raw = String(text || '')
  if (!raw) return ''
  const lines = raw.split(/\n/)
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return true
    return !/^ERROR: ld\.so: object '.*\/gameoverlayrenderer\.so' from LD_PRELOAD cannot be preloaded \(wrong ELF class: ELFCLASS(?:32|64)\): ignored\.$/.test(trimmed)
  })
  return kept.join('\n')
}

function buildProtonLogSnapshot(record?: RunningGameProc, logPath?: string | null, maxChars = LIVE_LOG_MAX_CHARS) {
  const effectivePath = String(logPath || record?.protonLogPath || '').trim() || null
  const processHead = String(record?.liveLogHeadBuffer || record?.liveLogBuffer || '')
  const processTail = String(record?.liveLogTailBuffer || '')
  const fileParts = effectivePath ? readFileHeadTailBytes(effectivePath, 180 * 1024, 320 * 1024) : null
  const sections: string[] = []

  if (processHead || processTail) {
    const launcherParts: string[] = []
    if (processHead) launcherParts.push(`=== Launcher stdout/stderr: inicio preservado ===\n${processHead.trimEnd()}`)
    if (record?.liveLogDroppedChars) launcherParts.push(`...[${record.liveLogDroppedChars} caracteres intermediarios omitidos]...`)
    if (processTail) launcherParts.push(`=== Launcher stdout/stderr: recente ===\n${processTail.trimEnd()}`)
    sections.push(launcherParts.join('\n\n'))
  }

  if (fileParts) {
    const compacted = compactProtonLogParts(fileParts, Math.max(80_000, Math.floor(maxChars * 0.72)))
    if (compacted) sections.push(`=== Proton log file${effectivePath ? ` (${effectivePath})` : ''} ===\n${compacted}`)
  }

  return {
    success: true,
    text: trimToHeadAndTailChars(sections.join('\n\n'), maxChars),
    live: !!record?.pid && isPidAlive(record.pid),
    logPath: effectivePath,
    pid: record?.pid,
    updatedAt: record?.liveLogUpdatedAt || Date.now(),
    hasProcessOutput: !!(processHead || processTail),
    hasProtonLog: !!fileParts
  }
}

function findEosOverlayInstallPath(): string | null {
  const home = os.homedir()
  let userTools: string | null = null
  try {
    userTools = path.join(app.getPath('userData'), 'tools', 'eos_overlay')
  } catch {
    // ignore
  }
  const candidates = [
    ...(userTools ? [userTools] : []),
    path.join(home, '.config', 'heroic', 'tools', 'eos_overlay'),
    path.join(home, '.config', 'legendary', 'overlay'),
    path.join(home, '.config', 'legendary', 'eos_overlay'),
    path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'tools', 'eos_overlay')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function readProcText(pid: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join('/proc', pid, file), 'utf8')
  } catch {
    return null
  }
}

function readProcCmdlineArgs(pid: string): string[] {
  const raw = readProcText(pid, 'cmdline')
  if (!raw) return []
  return raw.split('\0').filter(Boolean)
}

function readProcParentPid(pid: string): number | null {
  const stat = readProcText(pid, 'stat')
  if (!stat) return null
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  const rest = stat.slice(end + 2).trim().split(/\s+/)
  const ppid = Number(rest[1])
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null
}

function listChildProcessPids(rootPid?: number | null): number[] {
  if (!rootPid || process.platform !== 'linux') return []
  let entries: string[] = []
  try {
    entries = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))
  } catch {
    return []
  }

  const children = new Map<number, number[]>()
  for (const pidText of entries) {
    const ppid = readProcParentPid(pidText)
    if (!ppid) continue
    const pid = Number(pidText)
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)?.push(pid)
  }

  const out: number[] = []
  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    if (pid !== rootPid && isPidAlive(pid)) out.push(pid)
    for (const child of children.get(pid) || []) queue.push(child)
  }
  return out
}

const IGNORED_WINE_EXE_NAMES = new Set([
  'services.exe',
  'winedevice.exe',
  'plugplay.exe',
  'rpcss.exe',
  'explorer.exe',
  'svchost.exe',
  'conhost.exe',
  'crashhandler.exe',
  'eosoverlayrenderer-win64-shipping.exe',
  'eosoverlayrenderer-win32-shipping.exe'
])

function listLinuxHandoffPids(options: {
  installDir: string
  exePath?: string | null
  prefixPath?: string | null
  excludePids?: number[]
}): number[] {
  if (process.platform !== 'linux') return []

  const installLower = String(options.installDir || '').toLowerCase()
  const exeBase = options.exePath ? path.basename(options.exePath).toLowerCase() : ''
  const exclude = new Set<number>((options.excludePids || []).filter((p) => Number.isFinite(p)) as number[])
  const prefixCandidates: string[] = []
  if (options.prefixPath) {
    prefixCandidates.push(String(options.prefixPath).toLowerCase())
    prefixCandidates.push(resolveWinePrefixPath(options.prefixPath).toLowerCase())
  }

  let entries: string[] = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return []
  }

  const scored: Array<{ pid: number; score: number }> = []

  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (!pid || exclude.has(pid)) continue

    const args = readProcCmdlineArgs(ent)
    if (!args.length) continue
    const cmdLower = args.join(' ').toLowerCase()

    const exeArg = [...args].reverse().find((a) => a.toLowerCase().endsWith('.exe'))
    if (!exeArg) continue
    const exeName = path.basename(exeArg).toLowerCase()
    if (IGNORED_WINE_EXE_NAMES.has(exeName)) continue

    const matchesInstall = !!installLower && cmdLower.includes(installLower)
    const matchesExe = !!exeBase && cmdLower.includes(exeBase)

    let matchesPrefix = false
    if (prefixCandidates.length) {
      const envRaw = readProcText(ent, 'environ')
      if (envRaw) {
        const envLower = envRaw.toLowerCase()
        matchesPrefix = prefixCandidates.some((p) =>
          envLower.includes(`wineprefix=${p}`) || envLower.includes(`steam_compat_data_path=${p}`)
        )
      }
    }

    if (!matchesPrefix && !matchesInstall && !matchesExe) continue

    let score = 0
    if (matchesPrefix) score += 5
    if (matchesInstall) score += 3
    if (matchesExe) score += 2
    if (cmdLower.includes('wine') || cmdLower.includes('proton')) score += 1
    if (exeBase && exeName === exeBase) score += 2

    scored.push({ pid, score })
  }

  scored.sort((a, b) => (b.score - a.score) || (b.pid - a.pid))
  return scored.map((s) => s.pid)
}

async function waitForHandoffPid(options: {
  installDir: string
  exePath?: string | null
  prefixPath?: string | null
  excludePids?: number[]
  timeoutMs?: number
  intervalMs?: number
}): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? 15000
  const intervalMs = options.intervalMs ?? 1000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pids = listLinuxHandoffPids(options)
    if (pids.length) return pids[0]
    await waitMs(intervalMs)
  }
  return null
}

async function waitForNoHandoffPids(options: {
  installDir: string
  exePath?: string | null
  prefixPath?: string | null
  excludePids?: number[]
  intervalMs?: number
  emptyStreak?: number
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 1500
  const emptyStreakTarget = options.emptyStreak ?? 3
  let emptyStreak = 0
  while (true) {
    const pids = listLinuxHandoffPids(options)
    if (pids.length === 0) {
      emptyStreak += 1
      if (emptyStreak >= emptyStreakTarget) break
    } else {
      emptyStreak = 0
    }
    await waitMs(intervalMs)
  }
}

async function waitForPidExit(pid: number, intervalMs = 1500): Promise<void> {
  while (isPidAlive(pid)) {
    await waitMs(intervalMs)
  }
}

function fileSizeSafe(filePath: string): number {
  try {
    return fs.statSync(filePath).size || 0
  } catch {
    return 0
  }
}

function hasOnlineFixBesideExe(exePath: string): boolean {
  try {
    const dir = path.dirname(exePath)
    return fs.existsSync(path.join(dir, 'OnlineFix.ini')) ||
      fs.existsSync(path.join(dir, 'onlinefix.ini')) ||
      fs.existsSync(path.join(dir, 'OnlineFix64.dll')) ||
      fs.existsSync(path.join(dir, 'OnlineFix.dll'))
  } catch {
    return false
  }
}

function isEpicAuthLauncherPath(exePath?: string | null): boolean {
  const name = path.basename(String(exePath || '')).toLowerCase()
  return name === 'eosauthlauncher.exe' ||
    name === 'eosauthlauncher-win64-shipping.exe' ||
    name === 'eosauthlauncher-win32-shipping.exe' ||
    (name.endsWith('.exe') && name.includes('eos') && name.includes('auth') && name.includes('launcher'))
}

function isWin64ShippingPath(exePath?: string | null): boolean {
  return path.basename(String(exePath || '')).toLowerCase().endsWith('-win64-shipping.exe')
}

function shouldPreferAutoExecutable(currentExe: string, candidateExe: string): boolean {
  if (!currentExe || !candidateExe) return false
  if (path.resolve(currentExe) === path.resolve(candidateExe)) return false
  if (isEpicAuthLauncherPath(currentExe)) return false
  if (isEpicAuthLauncherPath(candidateExe)) return true

  const currentLower = currentExe.toLowerCase()
  const candidateLower = candidateExe.toLowerCase()
  const currentSize = fileSizeSafe(currentExe)
  const candidateSize = fileSizeSafe(candidateExe)

  const currentIsTinyStub = currentSize > 0 && currentSize < 2 * 1024 * 1024
  const candidateIsRealGame = candidateSize > 10 * 1024 * 1024
  const candidateLooksUnreal =
    candidateLower.includes('-win64-shipping.exe') ||
    candidateLower.includes(`${path.sep}binaries${path.sep}win64${path.sep}`)
  const currentLooksUnreal =
    currentLower.includes('-win64-shipping.exe') ||
    currentLower.includes(`${path.sep}binaries${path.sep}win64${path.sep}`)

  if (hasOnlineFixBesideExe(candidateExe) && !hasOnlineFixBesideExe(currentExe)) return true
  if (currentIsTinyStub && candidateIsRealGame && candidateLooksUnreal) return true
  if (!currentLooksUnreal && candidateLooksUnreal && candidateSize > currentSize * 4) return true
  return false
}

function gameDesktopId(gameUrl: string, title?: string | null): string {
  const id = extractGameIdFromUrl(gameUrl) || slugify(title || gameUrl)
  return `voidlauncher-game-${id}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
}

function writeGameDesktopEntry(opts: {
  gameUrl: string
  title?: string | null
  exePath?: string | null
  appId?: string | null
  icon?: string | null
}) {
  if (process.platform !== 'linux') return
  try {
    const desktopId = gameDesktopId(opts.gameUrl, opts.title)
    const applicationsDir = path.join(os.homedir(), '.local', 'share', 'applications')
    fs.mkdirSync(applicationsDir, { recursive: true })

    const exeBase = opts.exePath ? path.basename(opts.exePath, path.extname(opts.exePath)) : desktopId
    const startupClass = opts.appId && /^\d+$/.test(String(opts.appId))
      ? `steam_app_${opts.appId}`
      : exeBase

    const icon = String(opts.icon || '').startsWith('file://')
      ? decodeURIComponent(String(opts.icon).replace(/^file:\/\//, ''))
      : 'voidlauncher'

    const appImage = String(process.env.APPIMAGE || '').trim()
    const execPath = appImage || process.execPath
    const safeExec = execPath.replace(/"/g, '\\"')
    const safeUrl = opts.gameUrl.replace(/"/g, '\\"')
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${opts.title || 'VoidLauncher Game'}`,
      `Exec="${safeExec}" --launch-game-url "${safeUrl}"`,
      `Icon=${icon}`,
      `StartupWMClass=${startupClass}`,
      `X-KDE-StartupWMClass=${startupClass}`,
      `X-VoidLauncher-GameId=${desktopId}`,
      'NoDisplay=true',
      'Categories=Game;',
      ''
    ].join('\n')
    fs.writeFileSync(path.join(applicationsDir, `${desktopId}.desktop`), content)
  } catch (err) {
    console.warn('[Launch] Failed to write per-game desktop entry:', err)
  }
}

function withGameWindowIdentity(env: NodeJS.ProcessEnv, desktopId: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.APPIMAGE
  delete next.APPDIR
  delete next.ARGV0
  delete next.OWD
  delete next.CHROME_DESKTOP
  delete next.DESKTOP_STARTUP_ID
  delete next.GIO_LAUNCHED_DESKTOP_FILE
  delete next.GIO_LAUNCHED_DESKTOP_FILE_PID
  delete next.XDG_ACTIVATION_TOKEN
  next.SDL_VIDEO_X11_WMCLASS = desktopId
  next.RESOURCE_NAME = desktopId
  return next
}

function getTrackedGamePids(entry?: RunningGameProc): number[] {
  const pids = new Set<number>()
  if (entry?.pid && isPidAlive(entry.pid)) pids.add(entry.pid)
  const childPid = Number(entry?.child?.pid || 0)
  if (childPid && isPidAlive(childPid)) pids.add(childPid)
  for (const pid of entry?.pidTree || []) {
    if (pid && isPidAlive(pid)) pids.add(pid)
  }
  for (const pid of listChildProcessPids(childPid || entry?.pid)) {
    if (pid && isPidAlive(pid)) pids.add(pid)
  }
  if (entry?.installDir) {
    for (const pid of listLinuxHandoffPids({
      installDir: entry.installDir,
      exePath: entry.exePath,
      prefixPath: entry.prefixPath,
      excludePids: []
    })) {
      if (pid && isPidAlive(pid)) pids.add(pid)
    }
  }
  return Array.from(pids)
}

function listPrefixRuntimePids(prefixPath?: string | null): number[] {
  if (!prefixPath || process.platform !== 'linux') return []
  const prefixCandidates = [
    String(prefixPath).toLowerCase(),
    resolveWinePrefixPath(prefixPath).toLowerCase()
  ]
  const out: number[] = []
  let entries: string[] = []
  try { entries = fs.readdirSync('/proc') } catch { return out }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (!pid || !isPidAlive(pid)) continue
    const comm = readProcText(ent, 'comm')?.trim().toLowerCase() || ''
    if (!['wineserver', 'services.exe', 'winedevice.exe', 'plugplay.exe', 'rpcss.exe'].includes(comm)) continue
    const envRaw = readProcText(ent, 'environ')
    const envLower = String(envRaw || '').toLowerCase()
    if (prefixCandidates.some(p => envLower.includes(`wineprefix=${p}`) || envLower.includes(`steam_compat_data_path=${p}`))) {
      out.push(pid)
    }
  }
  return out
}

function getStopTargetPids(entry?: RunningGameProc): number[] {
  const pids = new Set<number>(getTrackedGamePids(entry))
  for (const pid of listPrefixRuntimePids(entry?.prefixPath)) {
    if (pid && isPidAlive(pid)) pids.add(pid)
  }
  return Array.from(pids)
}

function refreshTrackedGameEntry(entry?: RunningGameProc): { pids: number[]; entry?: RunningGameProc } {
  if (!entry) return { pids: [] }
  const pids = getTrackedGamePids(entry)
  const next = {
    ...entry,
    pid: pids[0] || entry.pid,
    pidTree: pids,
    lastSeenPids: pids.length ? pids : entry.lastSeenPids,
    lastVerifiedAt: Date.now()
  }
  return { pids, entry: next }
}

function isEosOverlayPathValid(p: string | null): boolean {
  if (!p) return false
  try {
    const win64 = path.join(p, 'EOSOverlayRenderer-Win64-Shipping.exe')
    const win32 = path.join(p, 'EOSOverlayRenderer-Win32-Shipping.exe')
    const dll64 = path.join(p, 'EOSOVH-Win64-Shipping.dll')
    const dll32 = path.join(p, 'EOSOVH-Win32-Shipping.dll')
    return fs.existsSync(win64) || fs.existsSync(win32) || fs.existsSync(dll64) || fs.existsSync(dll32)
  } catch {
    return false
  }
}

async function promptInstallEosOverlay(owner: Electron.BrowserWindow | null): Promise<'install' | 'skip'> {
  const options = {
    type: 'question' as const,
    buttons: ['Instalar agora (Recomendado)', 'Continuar sem'] as string[],
    defaultId: 0,
    cancelId: 1,
    title: 'EOS Overlay não instalado',
    message: 'O EOS Overlay não está instalado.',
    detail: 'Recomendado: sem ele pode não ser possível convidar outros jogadores. Deseja instalar agora?'
  }
  const res = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return res.response === 0 ? 'install' : 'skip'
}

async function enableEosOverlayForPrefix(
  prefixPath: string,
  owner: Electron.BrowserWindow | null,
  onStatus?: (msg: string) => void
): Promise<boolean> {
  if (!prefixPath) return false
  const winePrefix = resolveWinePrefixPath(prefixPath)
  if (!winePrefix || !fs.existsSync(winePrefix)) {
    console.warn('[Launch] EOS overlay: prefix inválido:', winePrefix || prefixPath)
    return false
  }

  const ensured = await ensureLegendaryAvailable({ allowDownload: true, timeoutMs: 120_000 })
  const legendaryPath = ensured.path
  if (!ensured.ok || !legendaryPath) {
    console.warn('[Launch] EOS overlay: legendary indisponível:', ensured.message || 'unknown')
    return false
  }

  let overlayPath = findEosOverlayInstallPath()
  if (!isEosOverlayPathValid(overlayPath)) overlayPath = null
  if (!overlayPath) {
    const decision = await promptInstallEosOverlay(owner)
    if (decision === 'skip') {
      console.warn('[Launch] EOS overlay: usuário optou por não instalar')
      return false
    }

    let installPath = ''
    try {
      installPath = path.join(app.getPath('userData'), 'tools', 'eos_overlay')
    } catch {}

    onStatus?.('Instalando EOS Overlay (recomendado)...')
    console.log('[Launch] EOS overlay: installing via legendary...')
    await new Promise<void>((resolve) => {
      const args = installPath
        ? ['eos-overlay', 'install', '--path', installPath]
        : ['eos-overlay', 'install']
      const proc = spawn(legendaryPath, args, { stdio: 'ignore' })
      const t = setTimeout(() => {
        try { proc.kill() } catch {}
        console.warn('[Launch] EOS overlay: install timeout')
        resolve()
      }, 15 * 60 * 1000)

      proc.on('error', (err: Error) => {
        clearTimeout(t)
        console.warn('[Launch] EOS overlay: install falhou:', err?.message || err)
        resolve()
      })
      proc.on('exit', (code: number | null) => {
        clearTimeout(t)
        if (typeof code === 'number' && code !== 0) {
          console.warn('[Launch] EOS overlay: install retornou código', code)
        }
        resolve()
      })
    })

    overlayPath = findEosOverlayInstallPath()
    if (!isEosOverlayPathValid(overlayPath)) overlayPath = null
    if (!overlayPath) {
      const warnOptions = {
        type: 'warning',
        title: 'Falha ao instalar EOS Overlay',
        message: 'Não foi possível instalar o EOS Overlay.',
        detail: 'O jogo será iniciado sem o overlay. Você pode tentar instalar novamente nas configurações.'
      } as const
      if (owner) {
        await dialog.showMessageBox(owner, warnOptions)
      } else {
        await dialog.showMessageBox(warnOptions)
      }
      return false
    }
  }

  let enableOk = false
  await new Promise<void>((resolve) => {
    const args = ['eos-overlay', 'enable', '--prefix', winePrefix]
    if (overlayPath) args.push('--path', overlayPath)
    console.log('[Launch] EOS overlay: enabling with args:', args.join(' '))
    const proc = spawn(legendaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let stdout = ''
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf-8') })
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf-8') })
    const t = setTimeout(() => {
      try { proc.kill() } catch {}
      console.warn('[Launch] EOS overlay: enable timeout')
      resolve()
    }, 15000)

    proc.on('error', (err: Error) => {
      clearTimeout(t)
      console.warn('[Launch] EOS overlay: enable falhou:', err?.message || err)
      resolve()
    })
    proc.on('exit', (code: number | null) => {
      clearTimeout(t)
      enableOk = typeof code === 'number' ? code === 0 : false
      if (!enableOk) {
        console.warn('[Launch] EOS overlay: enable retornou código', code)
        const out = (stdout + '\n' + stderr).trim()
        if (out) console.warn('[Launch] EOS overlay: enable output:', out.slice(0, 1200))
      }
      resolve()
    })
  })
  return enableOk
}

// ============================================================================
// Handler Registration
// ============================================================================

export const registerLaunchHandlers: IpcHandlerRegistrar = (ctx: IpcContext) => {
  const {
    getMainWindow,
    runningGames,
    inFlightPrefixJobs,
    achievementsManager,
    sendGameLaunchStatus,
    sendCloudSavesStatus
  } = ctx

  ipcMain.handle('launch-game', async (_event, gameUrl: string) => {
    try {
      const existing = runningGames.get(gameUrl)
      if (existing?.pid && isPidAlive(existing.pid)) {
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Jogo já está em execução', pid: existing.pid })
        return { success: false, error: 'Jogo já está em execução', errorCode: 'game-already-running' }
      }
      if (inFlightPrefixJobs.has(gameUrl)) {
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Prefixo está sendo preparado/atualizado. Aguarde.' })
        return { success: false, error: 'Prefixo está sendo preparado/atualizado. Aguarde.', errorCode: 'prefix-preparing' }
      }

      sendGameLaunchStatus({ gameUrl, status: 'starting' })
      console.log('[Launch] ========================================')
      console.log('[Launch] Requested launch for:', gameUrl)

      const allGames = getAllGames()
      console.log('[Launch] All games in DB:', allGames.map((g: any) => ({ url: g.url, title: g.title, install_path: g.install_path })))

      const game = allGames.find((g: any) => g.url === gameUrl) as any
      if (!game) {
        console.error('[Launch] ❌ Game not found in database. Looking for URL:', gameUrl)
        console.error('[Launch] Available game URLs:', allGames.map((g: any) => g.url))
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Jogo não encontrado' })
        return { success: false, error: 'Jogo não encontrado', errorCode: 'game-not-found' }
      }

      console.log('[Launch] 📋 Game data:', {
        title: game.title,
        install_path: game.install_path,
        executable_path: game.executable_path,
        proton_runtime: game.proton_runtime,
        proton_prefix: game.proton_prefix,
        proton_options: game.proton_options
      })

      let exePath = game.executable_path as string | null

      // Resolve install dir
      let installDir: string = process.cwd()
      if (game.install_path) {
        installDir = path.isAbsolute(game.install_path)
          ? game.install_path
          : path.resolve(process.cwd(), game.install_path)
      } else if (exePath) {
        installDir = path.dirname(exePath)
      }

      console.log('[Launch] 📁 Install directory:', installDir)
      console.log('[Launch] 📁 Directory exists:', fs.existsSync(installDir))

      if (!fs.existsSync(installDir)) {
        console.error('[Launch] ❌ Install dir not found:', installDir)
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Pasta de instalação não encontrada' })
        return { success: false, error: 'Pasta de instalação não encontrada', errorCode: 'install-folder-not-found' }
      }

      // Before launching, sync saves between local and Drive
      try {
        sendGameLaunchStatus({ gameUrl, status: 'starting', message: 'Sincronizando saves...' })
        const gameKey = cloudSaves.computeCloudSavesGameKey({
          gameUrl,
          title: game.title,
          steamAppId: game.steam_app_id || null,
          protonPrefix: game.proton_prefix || null
        })
        sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'restore', level: 'info', message: 'Verificando saves na nuvem...' })
        const restoreRes = await cloudSaves.restoreCloudSavesBeforeLaunch({
          gameUrl,
          title: game.title,
          steamAppId: game.steam_app_id || null,
          protonPrefix: game.proton_prefix || null
        })
        if (!restoreRes?.success || (restoreRes as any)?.skipped) {
          console.warn('[CloudSaves] restore reported non-success:', restoreRes)
          const msg = String(restoreRes?.message || 'Sem restore (usando saves locais).')
          recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'restore', level: 'info', message: msg })
          sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'restore', level: 'info', message: msg })
          if (drive.isCloudSavesEnabled()) {
            const syncRes = await drive.syncSavesOnPlayStart({
              protonPrefix: game.proton_prefix,
              installPath: installDir,
              realAppId: game.steam_app_id || undefined
            })
            if (syncRes && !(syncRes as any).success) {
              console.warn('[DriveSync] sync reported non-success:', syncRes)
            }
          }
        } else {
          const msg = String(restoreRes?.message || 'Saves restaurados da nuvem.')
          recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'restore', level: 'success', message: msg })
          sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'restore', level: 'success', message: msg })
        }
      } catch (e: any) {
        console.warn('[DriveSync] Failed to sync saves before launch:', e?.message || e)
      }

      const onlineFixIds: {
        steamAppId?: string | null
        fakeAppId?: string | null
        realAppId?: string | null
        epicProductId?: string | null
      } = {}
      try {
        const found = await findAndReadOnlineFixIni(installDir)
        if (found?.content) {
          const ids = extractOnlineFixOverlayIds(found.content)
          onlineFixIds.steamAppId = ids.steamAppId || null
          onlineFixIds.fakeAppId = ids.fakeAppId || null
          onlineFixIds.realAppId = ids.realAppId || null
          onlineFixIds.epicProductId = ids.epicProductId || null
          if (onlineFixIds.steamAppId) {
            console.log('[Launch] ✅ OnlineFix.ini Steam AppID:', onlineFixIds.steamAppId, ids.steamAppIdSource ? `(source: ${ids.steamAppIdSource})` : '')
          }
          if (ids.fakeAppId) {
            console.log('[Launch] ✅ OnlineFix.ini Fake AppID:', ids.fakeAppId)
          }
          if (ids.realAppId) {
            console.log('[Launch] ✅ OnlineFix.ini Real AppID:', ids.realAppId)
          }
          if (onlineFixIds.epicProductId) console.log('[Launch] ✅ OnlineFix.ini Epic Product ID:', onlineFixIds.epicProductId)
        }
      } catch (err: any) {
        console.warn('[Launch] Failed to read OnlineFix.ini for overlay IDs:', err?.message || err)
      }

      const epicAuthLauncher = findEpicAuthLauncherInDir(installDir)
      const epicWin64ShippingExe = findWin64ShippingExecutableInDir(installDir)
      const preferredEpicExe = onlineFixIds.epicProductId
        ? (epicAuthLauncher || epicWin64ShippingExe)
        : epicAuthLauncher
      const shouldUsePreferredEpicExe = Boolean(preferredEpicExe)

      // Try to auto-find executable if not configured or missing
      if (!exePath || !fs.existsSync(path.isAbsolute(exePath) ? exePath : path.join(installDir, exePath))) {
        console.log('[Launch] 🔍 Auto-searching for executable...')
        const autoExe = shouldUsePreferredEpicExe ? preferredEpicExe : (installDir ? findExecutableInDir(installDir, { prefer: game?.launch_executable }) : null)
        if (autoExe) {
          exePath = autoExe
          updateGameInfo(gameUrl, { executable_path: exePath })
          console.log('[Launch] ✅ Auto-detected executable:', exePath)
        } else {
          console.log('[Launch] ⚠️ No executable found automatically')
        }
      }

      if (!exePath) {
        console.error('[Launch] ❌ No executable configured')
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'missing_exe' })
        return { success: false, error: 'missing_exe' }
      }

      // Resolve exe path relative to install dir if not absolute
      exePath = path.isAbsolute(exePath) ? exePath : path.join(installDir, exePath)

      if (
        shouldUsePreferredEpicExe &&
        preferredEpicExe &&
        path.resolve(exePath) !== path.resolve(preferredEpicExe) &&
        !isEpicAuthLauncherPath(exePath)
      ) {
        console.warn('[Launch] 🟣 Epic/EOS preferred executable detected; switching executable:', {
          from: exePath,
          to: preferredEpicExe,
          epicProductId: onlineFixIds.epicProductId || null,
          reason: isEpicAuthLauncherPath(preferredEpicExe)
            ? 'EOSAuthLauncher recomendado'
            : isWin64ShippingPath(preferredEpicExe)
              ? 'fallback Win64-Shipping'
              : 'fallback Epic'
        })
        exePath = preferredEpicExe
        updateGameInfo(gameUrl, { executable_path: exePath })
      }

      const bestExe = installDir ? findExecutableInDir(installDir, { prefer: game?.launch_executable }) : null
      if (bestExe && fs.existsSync(bestExe) && shouldPreferAutoExecutable(exePath, bestExe)) {
        console.warn('[Launch] ⚠️ Stored executable looks like a stub; switching to better candidate:', {
          from: exePath,
          to: bestExe,
          fromSize: fileSizeSafe(exePath),
          toSize: fileSizeSafe(bestExe)
        })
        exePath = bestExe
        updateGameInfo(gameUrl, { executable_path: exePath })
      }

      console.log('[Launch] 🎮 Executable path:', exePath)
      console.log('[Launch] 🎮 Executable exists:', fs.existsSync(exePath))

      if (!fs.existsSync(exePath)) {
        console.error('[Launch] ❌ Executable not found at', exePath)
        sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Executável não encontrado' })
        return { success: false, error: 'Executável não encontrado', errorCode: 'executable-not-found' }
      }

      if (game.lan_mode === 'ofvpn' && game.lan_autoconnect) {
        sendGameLaunchStatus({ gameUrl, status: 'starting', message: 'Conectando à sala multiplayer...' })
        const vpn = await getActiveVpnSession()?.autoconnect(String(game.lan_network_id || ''))
        if (!vpn?.success) {
          const message = vpn?.error || 'Não foi possível conectar à sala. Abra as configurações de LAN.'
          sendGameLaunchStatus({ gameUrl, status: 'error', message })
          return { success: false, error: message }
        }
      }

      let child: any
      let stderrTail = ''
      let protonLogPath: string | undefined
      let liveLogBuffer = ''
      let liveLogHeadBuffer = ''
      let liveLogTailBuffer = ''
      let liveLogDroppedChars = 0

      const pushLiveLog = (source: string, text: string) => {
        if (!text) return
        const formatted = `[${new Date().toISOString()}] [${source}] ${String(text).replace(/\r\n/g, '\n')}${String(text).endsWith('\n') ? '' : '\n'}`
        const headRoom = Math.max(0, LIVE_LOG_HEAD_CHARS - liveLogHeadBuffer.length)
        if (headRoom > 0) {
          liveLogHeadBuffer += formatted.slice(0, headRoom)
          const overflow = formatted.slice(headRoom)
          if (overflow) {
            liveLogDroppedChars += overflow.length
            liveLogTailBuffer = trimToMaxChars(`${liveLogTailBuffer}${overflow}`, LIVE_LOG_TAIL_CHARS)
          }
        } else {
          liveLogDroppedChars += formatted.length
          liveLogTailBuffer = trimToMaxChars(`${liveLogTailBuffer}${formatted}`, LIVE_LOG_TAIL_CHARS)
        }
        liveLogBuffer = trimToHeadAndTailChars(
          `${liveLogHeadBuffer}${liveLogDroppedChars ? `\n\n...[${liveLogDroppedChars} caracteres intermediarios omitidos]...\n\n` : ''}${liveLogTailBuffer}`,
          LIVE_LOG_MAX_CHARS
        )
        const record = runningGames.get(gameUrl)
        appendLiveLogChunk(record, formatted)
      }
      
      // Generate unique session ID for overlay IPC (used by both Proton and native)
      const overlaySessionId = `game_${extractGameIdFromUrl(gameUrl)}_${Date.now()}`
      const desktopId = gameDesktopId(gameUrl, game.title)
      let activePrefixPath: string | undefined

      if (isLinux() && exePath.toLowerCase().endsWith('.exe')) {
        // Linux + Windows exe = use Proton
        console.log('[Launch] 🐧 Linux detected, using Proton...')

        const stableId = (game?.game_id as string | null) || extractGameIdFromUrl(gameUrl)
        const slug = stableId ? `game_${stableId}` : slugify(game.title || gameUrl)
        console.log('[Launch] 🏷️ Game slug:', slug)

        const protonOpts = game.proton_options ? JSON.parse(game.proton_options) : {}
        console.log('[Launch] ⚙️ Proton options:', protonOpts)

        // Installation, refresh and launch share the same prefix and dependency state.
        if (inFlightPrefixJobs.has(gameUrl)) throw new Error('Prefixo está sendo preparado/atualizado. Aguarde.')
        inFlightPrefixJobs.set(gameUrl, { startedAt: Date.now() })
        let prefixPath: string
        try {
          prefixPath = await ensureGamePrefixFromDefault(slug, game.proton_runtime || undefined, undefined, false, (msg) => {
            sendGameLaunchStatus({ gameUrl, status: 'starting', message: msg })
          }, installDir, game.proton_prefix || undefined, true)
          if (game.proton_prefix !== prefixPath) updateGameInfo(gameUrl, { proton_prefix: prefixPath })
        } finally {
          inFlightPrefixJobs.delete(gameUrl)
        }

        console.log('[Launch] 📂 Prefix path:', prefixPath)
        console.log('[Launch] 📂 Prefix exists:', fs.existsSync(prefixPath))
        activePrefixPath = prefixPath

        const detectedSteamAppId = detectSteamAppIdFromInstall(installDir)
        const overlayPolicy = resolveOverlayCompatibility({
          installPath: installDir,
          onlineFix: onlineFixIds,
          configuredSteamAppId: game?.steam_app_id as string | null,
          detectedSteamAppId,
          protonOptions: protonOpts
        })
        const steamAppId = overlayPolicy.realSteamAppId || overlayPolicy.steamOverlayAppId
        const overlayGameId = overlayPolicy.steamOverlayAppId
        const enableSteamOverlay = overlayPolicy.enableSteamOverlay
        const enableEosOverlay = overlayPolicy.enableEosOverlay
        console.log('[Launch] 🧭 Overlay policy:', {
          store: overlayPolicy.store,
          selectedOverlay: overlayPolicy.selectedOverlay,
          steamOverlayAppId: overlayPolicy.steamOverlayAppId,
          realSteamAppId: overlayPolicy.realSteamAppId,
          reason: overlayPolicy.reason,
          warnings: overlayPolicy.warnings
        })

        writeGameDesktopEntry({
          gameUrl,
          title: game.title,
          exePath,
          appId: overlayPolicy.realSteamAppId || normalizeSteamId(detectedSteamAppId) || normalizeSteamId(steamAppId),
          icon: game.image_url || null
        })

        let eosOverlayEnabled = false
        if (enableEosOverlay) {
          console.log('[Launch] 🟣 Enabling EOS overlay for prefix...')
          eosOverlayEnabled = await enableEosOverlayForPrefix(prefixPath, getMainWindow(), (msg) => {
            sendGameLaunchStatus({ gameUrl, status: 'starting', message: msg })
          })
        }

        console.log('[Launch] 🔧 Building Proton launch command...')
        const launch = buildProtonLaunch(
          exePath,
          [],
          slug,
          game.proton_runtime || undefined,
          { ...protonOpts, steamAppId: steamAppId || undefined, overlayGameId: overlayGameId || undefined, installDir, enableSteamOverlay, enableEosOverlay: eosOverlayEnabled },
          prefixPath
        )

        console.log('[Launch] 🚀 Proton launch config:', {
          cmd: launch.cmd,
          args: launch.args,
          runner: launch.runner,
          env_keys: Object.keys(launch.env || {})
        })

        if (!launch.runner) {
          console.error('[Launch] ❌ Proton runner not found!')
          sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Proton não encontrado. Configure nas opções do jogo.' })
          return { success: false, error: 'Proton não encontrado. Configure nas opções do jogo.', errorCode: 'proton-not-configured' }
        }

        if (!launch.cmd) {
          console.error('[Launch] ❌ Proton command is empty!')
          sendGameLaunchStatus({ gameUrl, status: 'error', message: 'Comando Proton inválido' })
          return { success: false, error: 'Comando Proton inválido', errorCode: 'proton-command-invalid' }
        }

        console.log('[Launch] 🎯 Full command:', launch.cmd, launch.args?.join(' '))
        console.log('[Launch] 📁 Working directory:', installDir)

        // Build environment for game launch
        const gameEnv: NodeJS.ProcessEnv = withGameWindowIdentity({
          ...launch.env,
          // Session ID for notification routing
          VOIDLAUNCHER_SESSION: overlaySessionId,
        }, desktopId)
        console.log('[Launch] 🔑 Session:', overlaySessionId)

        // Check if Gamescope mode is enabled for in-game notifications
        const useGamescope = protonOpts.useGamescope === true
        let finalCmd = launch.cmd
        let finalArgs = launch.args || []

        if (useGamescope) {
          console.log('[Launch] 🎮 Gamescope mode enabled for in-game notifications')
          // Wrap the command with gamescope
          // -e: enable Steam integration (overlay support)
          // --backend sdl: use SDL for window creation
          // -W/-H: output resolution, -w/-h: game resolution
          finalArgs = [
            '--backend', 'sdl',
            '-e',
            '-W', '1920', '-H', '1080',
            '-w', '1920', '-h', '1080',
            '--',
            launch.cmd,
            ...(launch.args || [])
          ]
          finalCmd = 'gamescope'
        }

        const launchStartedAt = Date.now()
        child = spawn(finalCmd, finalArgs, {
          env: gameEnv,
          cwd: installDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        try {
          const logDir = String((launch.env as any)?.PROTON_LOG_DIR || '')
          const appId = String((launch.env as any)?.SteamAppId || (launch.env as any)?.STEAM_COMPAT_APP_ID || (launch.env as any)?.SteamOverlayGameId || '')
          if (logDir && appId) protonLogPath = path.join(logDir, `steam-${appId}.log`)
        } catch {}

        pushLiveLog('launcher', [
          `cmd: ${finalCmd}`,
          `args: ${finalArgs.join(' ')}`,
          `cwd: ${installDir}`,
          `pid: pending`,
          `protonLogPath: ${protonLogPath || 'none'}`,
          `SteamAppId: ${String(gameEnv.SteamAppId || gameEnv.STEAM_COMPAT_APP_ID || '')}`,
          `SteamGameId: ${String((launch.env as any)?.SteamGameId || '')}`,
          `SteamOverlayGameId: ${String((launch.env as any)?.SteamOverlayGameId || '')}`,
          `DesktopId: ${desktopId}`,
          `WINEPREFIX: ${String(gameEnv.WINEPREFIX || '')}`,
          `WINEDLLOVERRIDES: ${String(gameEnv.WINEDLLOVERRIDES || '')}`,
          `LD_PRELOAD: ${String(gameEnv.LD_PRELOAD || '')}`,
          `VK_INSTANCE_LAYERS: ${String(gameEnv.VK_INSTANCE_LAYERS || '')}`,
          `VK_ADD_LAYER_PATH: ${String(gameEnv.VK_ADD_LAYER_PATH || '')}`,
          `ENABLE_VK_LAYER_VALVE_steam_overlay_1: ${String(gameEnv.ENABLE_VK_LAYER_VALVE_steam_overlay_1 || '')}`,
          ''
        ].join('\n'))

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString()
          console.log('[Game stdout]', text)
          pushLiveLog('stdout', text)
        })

        child.stderr?.on('data', (data: Buffer) => {
          const text = filterBenignLauncherStderr(data.toString())
          if (!text) return
          console.error('[Game stderr]', text)
          pushLiveLog('stderr', text)
          stderrTail = (stderrTail + text).slice(-8192)
        })

        child.on('error', (err: Error) => {
          console.error('[Launch] ❌ Spawn error:', err)
          pushLiveLog('launcher-error', err.message || String(err))
          sendGameLaunchStatus({ gameUrl, status: 'error', message: err.message || String(err), stderrTail, protonLogPath })
        })

        child.on('exit', async (code: number, signal: string) => {
          console.log('[Launch] 🏁 Process exited with code:', code, 'signal:', signal)

          const earlyExit = Date.now() - launchStartedAt < 20000
          let handoffPid: number | null = null
          if (earlyExit && process.platform === 'linux') {
            handoffPid = await waitForHandoffPid({
              installDir,
              exePath,
              prefixPath,
              excludePids: [child.pid],
              timeoutMs: 20000,
              intervalMs: 1000
            })
            if (handoffPid) {
              console.warn('[Launch] Launcher repassou execução para PID:', handoffPid)
              const existing = runningGames.get(gameUrl)
              if (existing) {
                const updated = { ...existing, pid: handoffPid, handoffPid, pidTree: getTrackedGamePids({ ...existing, pid: handoffPid }), lastVerifiedAt: Date.now() }
                runningGames.set(gameUrl, updated)
              }
              setCurrentGamePid(handoffPid)
              sendGameLaunchStatus({
                gameUrl,
                status: 'running',
                pid: handoffPid,
                message: 'Launcher finalizado; acompanhando jogo.'
              })
              console.log('[Launch] Handoff: acompanhando processos do jogo...')
              await waitForNoHandoffPids({
                installDir,
                exePath,
                prefixPath,
                excludePids: [child.pid],
                intervalMs: 1500,
                emptyStreak: 3
              })
              console.log('[Launch] Handoff: nenhum processo do jogo encontrado.')
            }
          }

          const handoffNoPid = !handoffPid && overlayPolicy.store === 'epic' && earlyExit
          const effectiveCode = handoffPid || handoffNoPid ? 0 : code
          const effectiveSignal = handoffPid || handoffNoPid ? null : signal
          if (handoffNoPid) {
            console.warn('[Launch] Epic launcher exited early; treating as handoff (no error).')
          }
          
          // Cleanup overlay IPC using the session ID stored in runningGames
          const gameInfo = runningGames.get(gameUrl)
          if (gameInfo?.overlaySessionId) {
            try {
              removeOverlayServer(gameInfo.overlaySessionId)
              console.log('[Launch] 🧹 Cleaned up overlay IPC for session:', gameInfo.overlaySessionId)
            } catch (err) {
              console.error('[Launch] Failed to cleanup overlay IPC:', err)
            }
          }
          
          // Clear current game PID to switch notifications back to desktop
          setCurrentGamePid(null)
          
          try { runningGames.delete(gameUrl) } catch {}
          try { achievementsManager.stopWatching(gameUrl) } catch {}

          let mergedTail = stderrTail
          const shouldAppendLog = (effectiveCode != null && Number(effectiveCode) !== 0) || !!effectiveSignal
          if (shouldAppendLog && protonLogPath) {
            const logRawTail = readFileTailBytes(protonLogPath, 256 * 1024)
            if (logRawTail) {
              const filtered = extractInterestingProtonLog(logRawTail, 160) || logRawTail.split(/\r?\n/).slice(-120).join('\n')
              mergedTail = trimToMaxChars(
                mergedTail + '\n\n--- PROTON LOG (filtered) ---\n' + filtered,
                8192
              )
            }
          }
          const exitMsg = handoffNoPid ? 'Launcher finalizado; o jogo pode ter continuado.' : undefined
          sendGameLaunchStatus({ gameUrl, status: 'exited', code: effectiveCode, signal: effectiveSignal, stderrTail: mergedTail, protonLogPath, message: exitMsg })

          // Backup saves after exit
          try {
            console.log('[CloudSaves] Backing up saves after Proton game exit...')
            const gameKey = cloudSaves.computeCloudSavesGameKey({
              gameUrl,
              title: game.title,
              steamAppId: game.steam_app_id || null,
              protonPrefix: prefixPath || game.proton_prefix || null
            })
            sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'info', message: 'Salvando na nuvem...' })
            const backupRes = await cloudSaves.backupCloudSavesAfterExit({
              gameUrl,
              title: game.title,
              steamAppId: game.steam_app_id || null,
              protonPrefix: prefixPath || game.proton_prefix || null
            })
            if (!backupRes?.success || (backupRes as any)?.skipped) {
              console.warn('[CloudSaves] backup reported non-success:', backupRes)
              const msg = String(backupRes?.message || 'Falha ao salvar com Ludusavi; usando método legado.')
              recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'backup', level: 'warning', message: msg })
              sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'warning', message: msg })
              if (drive.isCloudSavesEnabled()) {
                await drive.backupLocalSavesToDrive({
                  protonPrefix: prefixPath || game.proton_prefix,
                  installPath: installDir,
                  realAppId: game.steam_app_id || undefined
                })
                sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'success', message: 'Backup na nuvem atualizado (método legado).' })
              }
            }
            if (backupRes?.success && !(backupRes as any)?.skipped) {
              const isConflict = /conflito/i.test(String(backupRes?.message || ''))
              const msg = String(backupRes?.message || 'Backup na nuvem atualizado.')
              recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'backup', level: isConflict ? 'warning' : 'success', message: msg })
              sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: isConflict ? 'warning' : 'success', message: msg, conflict: isConflict })
            }
            console.log('[CloudSaves] Backup finished (Proton/Linux).')
          } catch (e: any) {
            console.warn('[CloudSaves] Failed to backup saves after Proton exit:', e?.message || e)
          }
        })

      } else {
        // Native exe (Windows or non-.exe on Linux)
        console.log('[Launch] 🪟 Starting native exe:', exePath)
        console.log('[Launch] 📁 Working directory:', installDir)

        // Build environment for game launch
        const gameEnv: NodeJS.ProcessEnv = { 
          ...process.env,
          // Session ID for notification routing
          VOIDLAUNCHER_SESSION: overlaySessionId,
        }
        const nativeEnv = withGameWindowIdentity(gameEnv, desktopId)
        console.log('[Launch] 🔑 Session:', overlaySessionId)

        writeGameDesktopEntry({
          gameUrl,
          title: game.title,
          exePath,
          appId: game.steam_app_id || null,
          icon: game.image_url || null
        })

        // The same launch arguments the Proton path passes. A mod that takes
        // the player's name off the command line needs them wherever the game
        // runs, and a fix that sets them was being ignored here.
        let nativeArgs: string[] = []
        try {
          const nativeOpts = game.proton_options ? JSON.parse(game.proton_options) : {}
          nativeArgs = String(nativeOpts?.launchArgs || '').split(' ').filter(Boolean)
        } catch {
          // A settings blob that will not parse is not a reason to refuse to
          // start the game; it just means no extra arguments.
        }

        child = spawn(exePath, nativeArgs, {
          env: nativeEnv,
          cwd: installDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        pushLiveLog('launcher', [
          `cmd: ${exePath}`,
          `args: ${nativeArgs.join(' ')}`,
          `cwd: ${installDir}`,
          `pid: pending`,
          ''
        ].join('\n'))

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString()
          console.log('[Game stdout]', text)
          pushLiveLog('stdout', text)
        })

        child.stderr?.on('data', (data: Buffer) => {
          const text = filterBenignLauncherStderr(data.toString())
          if (!text) return
          console.error('[Game stderr]', text)
          pushLiveLog('stderr', text)
          stderrTail = (stderrTail + text).slice(-8192)
        })

        child.on('error', (err: Error) => {
          console.error('[Launch] ❌ Spawn error:', err)
          pushLiveLog('launcher-error', err.message || String(err))
          sendGameLaunchStatus({ gameUrl, status: 'error', message: err.message || String(err), stderrTail })
        })

        child.on('exit', async (code: number, signal: string) => {
          console.log('[Launch] 🏁 Process exited with code:', code, 'signal:', signal)
          
          // Cleanup overlay IPC using the session ID stored in runningGames
          const gameInfo = runningGames.get(gameUrl)
          if (gameInfo?.overlaySessionId) {
            try {
              removeOverlayServer(gameInfo.overlaySessionId)
              console.log('[Launch] 🧹 Cleaned up overlay IPC for session:', gameInfo.overlaySessionId)
            } catch (err) {
              console.error('[Launch] Failed to cleanup overlay IPC:', err)
            }
          }
          
          // Clear current game PID to switch notifications back to desktop
          setCurrentGamePid(null)
          
          try { runningGames.delete(gameUrl) } catch {}
          try { achievementsManager.stopWatching(gameUrl) } catch {}
          sendGameLaunchStatus({ gameUrl, status: 'exited', code, signal, stderrTail })

          // Backup saves after exit
          try {
            const gameKey = cloudSaves.computeCloudSavesGameKey({
              gameUrl,
              title: game.title,
              steamAppId: game.steam_app_id || null,
              protonPrefix: game.proton_prefix || null
            })
            sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'info', message: 'Salvando na nuvem...' })
            const backupRes = await cloudSaves.backupCloudSavesAfterExit({
              gameUrl,
              title: game.title,
              steamAppId: game.steam_app_id || null,
              protonPrefix: game.proton_prefix || null
            })
            if (!backupRes?.success || (backupRes as any)?.skipped) {
              console.warn('[CloudSaves] backup reported non-success:', backupRes)
              const msg = String(backupRes?.message || 'Falha ao salvar com Ludusavi; usando método legado.')
              recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'backup', level: 'warning', message: msg })
              sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'warning', message: msg })
              if (drive.isCloudSavesEnabled()) {
                await drive.backupLocalSavesToDrive({
                  protonPrefix: game.proton_prefix,
                  installPath: installDir,
                  realAppId: game.steam_app_id || undefined
                })
                sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: 'success', message: 'Backup na nuvem atualizado (método legado).' })
              }
            }
            if (backupRes?.success && !(backupRes as any)?.skipped) {
              const isConflict = /conflito/i.test(String(backupRes?.message || ''))
              const msg = String(backupRes?.message || 'Backup na nuvem atualizado.')
              recordCloudSaves({ at: Date.now(), gameKey, gameUrl, stage: 'backup', level: isConflict ? 'warning' : 'success', message: msg })
              sendCloudSavesStatus({ at: Date.now(), gameUrl, gameKey, stage: 'backup', level: isConflict ? 'warning' : 'success', message: msg, conflict: isConflict })
            }
          } catch (e: any) {
            console.warn('[CloudSaves] Failed to backup saves after exit:', e?.message || e)
          }
        })
      }

      if (child?.pid) {
        runningGames.set(gameUrl, {
          pid: child.pid,
          child,
          pidTree: [child.pid],
          lastSeenPids: [child.pid],
          handoffPid: null,
          lastVerifiedAt: Date.now(),
          protonLogPath,
          startedAt: Date.now(),
          overlaySessionId,
          installDir,
          exePath,
          prefixPath: activePrefixPath,
          liveLogBuffer,
          liveLogHeadBuffer,
          liveLogTailBuffer,
          liveLogDroppedChars,
          liveLogUpdatedAt: Date.now()
        })
        pushLiveLog('launcher', `childPid: ${child.pid}`)

        // Set current game PID for notification routing
        setCurrentGamePid(child.pid)

        // Create IPC server for in-game overlay communication (notifications)
        if (NOTIFICATIONS_ENABLED) {
          try {
            const server = createOverlayServer(overlaySessionId)
            await server.start()
            console.log('[Launch] 🔌 Overlay IPC server started for session:', overlaySessionId)
          } catch (err) {
            console.error('[Launch] Failed to start overlay IPC server:', err)
          }
        }

        // Update play time
        try {
          const startedAt = runningGames.get(gameUrl)?.startedAt
          const elapsedMs = startedAt ? (Date.now() - startedAt) : 0
          const minutes = Math.max(0, Math.round(elapsedMs / 60000))
          updateGamePlayTime(gameUrl, minutes)
        } catch {}

        // Start achievement watcher
        try {
          const detectedSteamAppId = detectSteamAppIdFromInstall(installDir)
          achievementsManager.startWatching(
            {
              gameUrl,
              title: game.title || undefined,
              installPath: installDir,
              executablePath: exePath,
              steamAppId: game.steam_app_id || null,
              schemaSteamAppId: detectedSteamAppId || game.steam_app_id || null,
              protonPrefix: game.proton_prefix || null
            },
            (ev: any) => {
              try {
                getMainWindow()?.webContents.send('achievement-unlocked', ev)
              } catch {}
              
              // Send notifications (desktop + in-game overlay)
              if (NOTIFICATIONS_ENABLED) {
                try {
                  const notif = notifyAchievementUnlocked(
                    ev.title || ev.achievement?.displayName || ev.achievement?.name || 'Achievement Unlocked',
                    ev.description || ev.achievement?.description,
                    ev.icon || ev.iconUrl || ev.achievement?.iconUrl || ev.achievement?.icon,
                    game.title || undefined
                  )
                  
                  // Send to in-game overlay if game is running
                  const gameInfo = runningGames.get(gameUrl)
                  if (gameInfo?.overlaySessionId) {
                    const server = getOverlayServer(gameInfo.overlaySessionId)
                    if (server && server.isRunning()) {
                      server.sendNotification(notif)
                    }
                  }
                } catch (err) {
                  console.error('[Launch] Failed to send achievement notification:', err)
                }
              }
            }
          )
        } catch (err) {
          console.warn('[Achievements] Failed to start watcher:', err)
        }
      }

      child.unref()
      console.log('[Launch] ✅ Game process started successfully (PID:', child.pid, ')')
      console.log('[Launch] ========================================')
      const entryForStatus = runningGames.get(gameUrl)
      if (entryForStatus) {
        const refreshed = refreshTrackedGameEntry(entryForStatus)
        if (refreshed.entry) runningGames.set(gameUrl, refreshed.entry)
      }
      const verifiedEntry = runningGames.get(gameUrl)
      sendGameLaunchStatus({ gameUrl, status: 'running', pid: verifiedEntry?.pid || child.pid, protonLogPath, message: 'Em execução' })

      return { success: true }

    } catch (err: any) {
      console.error('[Launch] 💥 Exception:', err)
      console.error('[Launch] Stack:', err?.stack)
      sendGameLaunchStatus({ gameUrl, status: 'error', message: err?.message || String(err) })
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('stop-game', async (_event, gameUrl: string, force?: boolean) => {
    try {
      const entry = runningGames.get(gameUrl)
      const refreshed = refreshTrackedGameEntry(entry)
      if (refreshed.entry) runningGames.set(gameUrl, refreshed.entry)
      const initialPids = getStopTargetPids(refreshed.entry || entry)
      if (!entry || initialPids.length === 0) {
        try { runningGames.delete(gameUrl) } catch {}
        try { achievementsManager.stopWatching(gameUrl) } catch {}
        return { success: false, error: 'Jogo não está em execução', errorCode: 'game-not-running' }
      }

      sendGameLaunchStatus({ gameUrl, status: 'starting', message: 'Parando jogo...', pid: entry.pid })

      // First try a graceful stop
      for (const pid of initialPids) killProcessTreeBestEffort(pid, 'SIGTERM')

      const waitMs = async (ms: number) => await new Promise<void>(r => setTimeout(r, ms))
      await waitMs(2500)

      let remaining = getStopTargetPids(runningGames.get(gameUrl))
      if (force === true || remaining.length > 0) {
        for (const pid of remaining) killProcessTreeBestEffort(pid, 'SIGKILL')
        await waitMs(800)
      }

      remaining = getStopTargetPids(runningGames.get(gameUrl))
      if (remaining.length === 0) {
        try { runningGames.delete(gameUrl) } catch {}
        try { achievementsManager.stopWatching(gameUrl) } catch {}
        setCurrentGamePid(null)
        sendGameLaunchStatus({ gameUrl, status: 'exited', code: 0, signal: 'SIGTERM', message: 'Jogo parado pelo launcher', protonLogPath: entry.protonLogPath })
        return { success: true }
      }

      sendGameLaunchStatus({ gameUrl, status: 'running', pid: remaining[0], message: 'Em execução', protonLogPath: entry.protonLogPath })
      return { success: false, error: `Falha ao encerrar processo(s): ${remaining.join(', ')}` }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('get-proton-log-snapshot', async (_event, payload?: { gameUrl?: string; logPath?: string | null; maxChars?: number }) => {
    try {
      const gameUrl = typeof payload?.gameUrl === 'string' ? payload.gameUrl.trim() : ''
      const logPath = typeof payload?.logPath === 'string' ? payload.logPath.trim() : ''
      const maxChars = Math.max(8_192, Math.min(Number(payload?.maxChars) || LIVE_LOG_MAX_CHARS, 1_000_000))
      const record = gameUrl ? runningGames.get(gameUrl) : undefined

      if (!record && !logPath) {
        return { success: false, error: 'Nenhum log disponível para este jogo.', errorCode: 'no-log-available' }
      }

      return buildProtonLogSnapshot(record, logPath || undefined, maxChars)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('is-game-running', async (_event, gameUrl: string) => {
    try {
      const entry = runningGames.get(gameUrl)
      const refreshed = refreshTrackedGameEntry(entry)
      const pids = refreshed.pids
      if (!entry || pids.length === 0) return { running: false }
      if (refreshed.entry) runningGames.set(gameUrl, refreshed.entry)
      return { running: true, pid: pids[0], pids, startedAt: entry?.startedAt, lastVerifiedAt: refreshed.entry?.lastVerifiedAt }
    } catch {
      return { running: false }
    }
  })
}
