/**
 * IPC Handlers for Game Management
 */
import { dialog, shell, BrowserWindow, app, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { spawn, spawnSync } from 'child_process'
import {
  getAllGames,
  getGame,
  deleteGame,
  updateGameInfo,
  setGameFavorite,
  toggleGameFavorite,
  extractGameIdFromUrl
} from '../db'
import { fetchGameUpdateInfo } from '../scraper'
import { getRemoteFix, getRemoteFixIndex } from '../remoteFixes'
import { ensureGamePrefixFromDefault, findProtonRuntime, installExtraComponents, listProtonRuntimes, winetricksAvailable } from '../protonManager'
import { extractOnlineFixOverlayIds, findAndReadOnlineFixIni } from '../utils/onlinefixIni'
import {
  bareExecutableName,
  findEosOverlayInstallPath,
  findRuntimeFacadeAssembly,
  sanitizeRuntimeAssemblies,
  findExecutableInDir,
  listExecutablesInDir,
  getDisplayCompatibilityInfo,
  isEosOverlayPathValid,
  isPidAlive,
  resolveOverlayCompatibility
} from '../utils'
import { detectSteamAppIdFromInstall } from './achievementsHandlers'
import { resolveLegendaryBinary } from '../legendary'
import {
  pendingFixPlaceholders,
  resolveFixInputValues,
  sanitizeFixInputs,
  substituteFixInputsInOptions,
  type FixInput
} from '../../shared/fixInputs'
import { sanitizeFixDownloads, type FixDownload } from '../../shared/fixDownloads'
import { PROTON_ONLY_OPTION_KEYS, currentFixOs, fixAppliesToOs, sanitizeFixOsList, type FixOs } from '../../shared/fixOs'
import { installFixDownloads } from '../fixPayloads'
import type { IpcContext, IpcHandlerRegistrar } from './types'

// Helper to slugify strings
function slugify(str: string): string {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'game'
}

const DEFAULT_PROTON_OPTIONS = {
  esync: true,
  fsync: true,
  dxvk: true,
  mesa_glthread: false,
  locale: '',
  gamemode: false,
  mangohud: false,
  logging: false,
  steamOverlay: true,
  launchArgs: '',
  useGamescope: false,
  wineDllOverrides: ''
}

type CommunityGameFix = {
  kind: 'voidlauncher.gameFix'
  schemaVersion: 1
  id: string
  title: string
  description?: string
  author?: string
  createdAt: string
  launcherVersion?: string
  game: {
    id?: string | null
    title?: string | null
    url?: string | null
    installedVersion?: string | null
  }
  proton?: {
    runtimeName?: string | null
    options?: Record<string, any>
    steamAppId?: string | null
  }
  components?: {
    winetricks?: string[]
  }
  /**
   * The binary to launch, as a bare file name. A game whose mod ships its own
   * launcher is not configured by Proton settings alone — the fix has to be
   * able to say which of the executables in the folder is the right one.
   */
  launchExecutable?: string | null
  runtimeAssemblies?: Array<{ name: string; into: string }>
  /** Systems this fix is for. Empty means every one the launcher runs on. */
  os?: FixOs[]
  /**
   * Values only the person applying the fix knows — a player name, this
   * machine's address. The fix writes `{{id}}` where each one goes and the
   * launcher asks for them instead of leaving the file half-edited by hand.
   */
  inputs?: FixInput[]
  /**
   * Files the fix points at, hosted elsewhere. The only thing in a fix that
   * reaches outside the machine, and the only one that needs the person to
   * agree to it first: see src/shared/fixDownloads.ts.
   */
  downloads?: FixDownload[]
  notes?: string[]
}

const FIX_KIND = 'voidlauncher.gameFix'

function safeFileName(value: string) {
  return String(value || 'game-fix')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'game-fix'
}

function safeText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function safeComponentList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value
    .map(v => safeText(v, 64))
    .filter(v => /^[a-z0-9_.+-]+$/i.test(v))
  )).slice(0, 40)
}

function safeProtonOptions(input: any) {
  const src = input && typeof input === 'object' ? input : {}
  return {
    esync: src.esync !== false,
    fsync: src.fsync !== false,
    dxvk: src.dxvk !== false,
    mesa_glthread: !!src.mesa_glthread,
    locale: safeText(src.locale, 64),
    gamemode: !!src.gamemode,
    mangohud: !!src.mangohud,
    logging: !!src.logging,
    steamOverlay: src.steamOverlay !== false,
    launchArgs: safeText(src.launchArgs, 512),
    useGamescope: !!src.useGamescope,
    wineDllOverrides: safeText(src.wineDllOverrides, 1024)
  }
}

function parseFixProtonOptions(raw: unknown) {
  try {
    if (!raw) return { ...DEFAULT_PROTON_OPTIONS }
    return safeProtonOptions(typeof raw === 'string' ? JSON.parse(raw) : raw)
  } catch {
    return { ...DEFAULT_PROTON_OPTIONS }
  }
}

function normalizeGameFix(raw: any): CommunityGameFix {
  if (!raw || typeof raw !== 'object') throw new Error('Arquivo de fix inválido')
  if (raw.kind && raw.kind !== FIX_KIND) throw new Error('Este JSON não é um fix do VoidLauncher')

  const proton = raw.proton && typeof raw.proton === 'object' ? raw.proton : {}
  const components = raw.components && typeof raw.components === 'object' ? raw.components : {}
  const game = raw.game && typeof raw.game === 'object' ? raw.game : {}
  const createdAt = safeText(raw.createdAt, 64) || new Date().toISOString()
  const id = safeText(raw.id, 120) || safeFileName(`${safeText(raw.title, 100) || 'community-fix'}-${createdAt}`)

  return {
    kind: FIX_KIND,
    schemaVersion: 1,
    id,
    title: safeText(raw.title, 120) || 'Community fix',
    description: safeText(raw.description, 1000),
    author: safeText(raw.author, 80),
    createdAt,
    launcherVersion: safeText(raw.launcherVersion, 40),
    game: {
      id: safeText(game.id, 80) || null,
      title: safeText(game.title, 160) || null,
      url: safeText(game.url, 500) || null,
      installedVersion: safeText(game.installedVersion, 80) || null
    },
    proton: {
      runtimeName: safeText(proton.runtimeName || proton.version || proton.name, 160) || null,
      options: safeProtonOptions(proton.options || raw.protonOptions || {}),
      steamAppId: safeText(proton.steamAppId, 32).replace(/[^\d]/g, '') || null
    },
    components: {
      // A fix written before protontricks was dropped still names plain winetricks
      // verbs, so its list is folded in here rather than thrown away.
      winetricks: safeComponentList([
        ...(Array.isArray(components.winetricks) ? components.winetricks : []),
        ...(Array.isArray((components as any).protontricks) ? (components as any).protontricks : [])
      ])
    },
    // A name, never a path: it only ever selects among the executables already
    // found inside the game's own folder.
    launchExecutable: bareExecutableName(raw.launchExecutable),
    runtimeAssemblies: sanitizeRuntimeAssemblies(raw.runtimeAssemblies),
    os: sanitizeFixOsList(raw.os),
    inputs: sanitizeFixInputs(raw.inputs),
    downloads: sanitizeFixDownloads(raw.downloads),
    notes: Array.isArray(raw.notes) ? raw.notes.map((n: unknown) => safeText(n, 300)).filter(Boolean).slice(0, 12) : []
  }
}

/**
 * Turns the fix's template into the settings this machine gets.
 *
 * The fix that is saved and shared keeps its `{{placeholders}}`; only the copy
 * on its way into the database has the answers in it. Nothing is trusted on the
 * way through: the renderer's dialog already checked the values, and they are
 * checked again here, because a value from the renderer is a value from
 * outside. A placeholder still standing after substitution — one the fix never
 * declared — stops the apply rather than reaching the game as literal text.
 */
function resolveFixForApply(fix: CommunityGameFix, rawValues: unknown): {
  options?: Record<string, any>
  missing: string[]
  invalid: string[]
} {
  const inputs = fix.inputs || []
  const { values, missing, invalid } = resolveFixInputValues(inputs, rawValues)
  if (missing.length || invalid.length) return { missing, invalid }

  const options = substituteFixInputsInOptions(fix.proton?.options || {}, values)
  const pending = pendingFixPlaceholders(options)
  if (pending.length) return { missing: pending, invalid: [] }

  return { options, missing: [], invalid: [] }
}

function buildGameFix(game: any): CommunityGameFix {
  const gameId = (game?.game_id as string | null) || extractGameIdFromUrl(game?.url || '')
  const runtimePath = String(game?.proton_runtime || '').trim()
  const runtimeName = runtimePath ? path.basename(runtimePath) : null
  const createdAt = new Date().toISOString()
  const title = `${game?.title || 'Game'} Proton fix`

  return {
    kind: FIX_KIND,
    schemaVersion: 1,
    id: `${gameId || safeFileName(game?.title || 'game')}-${Date.now()}`,
    title,
    description: '',
    author: '',
    createdAt,
    launcherVersion: app.getVersion?.() || undefined,
    game: {
      id: gameId || null,
      title: game?.title || null,
      url: game?.url || null,
      installedVersion: game?.installed_version || null
    },
    proton: {
      runtimeName,
      options: parseFixProtonOptions(game?.proton_options),
      steamAppId: game?.steam_app_id ? String(game.steam_app_id) : null
    },
    components: {
      winetricks: []
    },
    launchExecutable: bareExecutableName(game?.launch_executable),
    runtimeAssemblies: [],
    os: [],
    inputs: [],
    downloads: [],
    notes: [
      'Este fix compartilha apenas configuracoes. Prefixo Wine, paths locais e saves nao sao incluidos.'
    ]
  }
}

function resolveRuntimePathFromFix(fix: CommunityGameFix): { runtimePath?: string | null; warning?: string } {
  const wanted = safeText(fix.proton?.runtimeName, 160)
  if (!wanted) return { runtimePath: null }

  const wantedLower = wanted.toLowerCase()
  const runtimes = listProtonRuntimes()
  const match = runtimes.find(rt =>
    rt.name.toLowerCase() === wantedLower ||
    path.basename(rt.path).toLowerCase() === wantedLower ||
    rt.path.toLowerCase().endsWith(`/${wantedLower}`)
  )
  if (match) return { runtimePath: match.path }
  return { warning: `Runtime Proton nao encontrado: ${wanted}` }
}

/**
 * Copies the assemblies a fix asked for out of the Proton runtime and into the
 * game folder. Both ends are constrained: the source has to be a facade the
 * runtime actually ships, and the destination has to resolve inside the game's
 * install directory. An existing file is never overwritten — a fix repairs what
 * is missing, it does not replace what the game or the mod already put there.
 */
function deliverRuntimeAssemblies(
  game: any,
  fix: CommunityGameFix,
  runtimePath?: string | null
): { copied: string[]; warnings: string[] } {
  const wanted = fix.runtimeAssemblies || []
  const copied: string[] = []
  const warnings: string[] = []
  if (!wanted.length) return { copied, warnings }

  const installDir = String(game?.install_path || '').trim()
  if (!installDir || !fs.existsSync(installDir)) {
    warnings.push('Pasta do jogo não encontrada; nenhum assembly foi copiado.')
    return { copied, warnings }
  }

  const runtime = String(runtimePath || game?.proton_runtime || '').trim() || findProtonRuntime()
  const installRoot = path.resolve(installDir)

  for (const entry of wanted) {
    const source = findRuntimeFacadeAssembly(runtime, entry.name)
    if (!source) {
      warnings.push(`O runtime Proton não fornece ${entry.name}.`)
      continue
    }

    const destDir = path.resolve(installRoot, entry.into)
    if (destDir !== installRoot && !destDir.startsWith(installRoot + path.sep)) {
      warnings.push(`Destino fora da pasta do jogo, ignorado: ${entry.into}`)
      continue
    }

    const dest = path.join(destDir, entry.name)
    if (fs.existsSync(dest)) continue

    try {
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(source, dest)
      copied.push(path.relative(installRoot, dest))
    } catch (err: any) {
      warnings.push(`Falha ao copiar ${entry.name}: ${err?.message || err}`)
    }
  }

  return { copied, warnings }
}

function getGameFixesRoot() {
  return path.join(app.getPath('userData'), 'game-fixes')
}

function gameFixFolderName(game: any) {
  const gameId = (game?.game_id as string | null) || extractGameIdFromUrl(game?.url || '')
  return safeFileName(gameId ? `game_${gameId}` : game?.title || game?.url || 'game')
}

function normalizeMatchText(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function fixMatchesGame(fix: CommunityGameFix, game: any) {
  const gameId = (game?.game_id as string | null) || extractGameIdFromUrl(game?.url || '')
  const fixGameId = safeText(fix.game?.id, 80)
  if (gameId && fixGameId && gameId === fixGameId) return true
  if (fix.game?.url && game?.url && fix.game.url === game.url) return true
  const fixTitle = normalizeMatchText(fix.game?.title)
  const gameTitle = normalizeMatchText(game?.title)
  return !!(fixTitle && gameTitle && fixTitle === gameTitle)
}

function localFixPath(game: any, fix: CommunityGameFix) {
  const dir = path.join(getGameFixesRoot(), gameFixFolderName(game))
  const file = `${safeFileName(fix.id || fix.title)}.json`
  return path.join(dir, file)
}

function saveLocalGameFix(game: any, rawFix: any) {
  const fix = normalizeGameFix(rawFix)
  const filePath = localFixPath(game, fix)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(fix, null, 2))
  return { fix, path: filePath }
}

function collectLocalFixFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || out.length >= 300) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p, depth - 1)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(p)
    }
  }
  walk(root, 2)
  return out
}

function listLocalGameFixes(game: any) {
  const root = getGameFixesRoot()
  const files = collectLocalFixFiles(root)
  const fixes: Array<{ fix: CommunityGameFix; path: string; updatedAt?: string }> = []
  for (const filePath of files) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      if (raw.length > 256 * 1024) continue
      const fix = normalizeGameFix(JSON.parse(raw))
      if (!fixMatchesGame(fix, game)) continue
      let updatedAt: string | undefined
      try { updatedAt = fs.statSync(filePath).mtime.toISOString() } catch {}
      fixes.push({ fix, path: filePath, updatedAt })
    } catch {
      // ignore invalid local fixes
    }
  }
  fixes.sort((a, b) => String(b.updatedAt || b.fix.createdAt).localeCompare(String(a.updatedAt || a.fix.createdAt)))
  return fixes
}

function getFixWinetricksComponents(fix: CommunityGameFix) {
  return Array.from(new Set(fix.components?.winetricks || [])).filter(Boolean)
}

function pathInfo(p?: string | null, baseDir?: string | null) {
  const value = String(p || '').trim()
  if (!value) return { path: '', exists: false, type: 'missing' as const }
  const resolved = path.isAbsolute(value)
    ? value
    : path.resolve(baseDir || process.cwd(), value)
  try {
    const st = fs.statSync(resolved)
    return {
      path: resolved,
      exists: true,
      type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.isFile() ? st.size : undefined
    }
  } catch {
    return { path: resolved, exists: false, type: 'missing' as const }
  }
}

function commandExists(cmd: string): boolean {
  try {
    const res = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], { stdio: 'ignore' })
    return res.status === 0
  } catch {
    return false
  }
}

function commandPath(cmd: string): string | null {
  try {
    const res = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' })
    const out = String(res.stdout || '').trim().split(/\r?\n/)[0]
    return res.status === 0 && out ? out : null
  } catch {
    return null
  }
}

function isProcessRunning(names: string[]): boolean {
  const wanted = new Set(names.map(n => n.toLowerCase()))
  try {
    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      try {
        const comm = fs.readFileSync(path.join('/proc', entry.name, 'comm'), 'utf8').trim().toLowerCase()
        if (wanted.has(comm)) return true
      } catch {
        // process can exit while scanning
      }
    }
  } catch {
    // /proc is Linux-specific
  }
  return false
}

function steamRootCandidates() {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.steam', 'debian-installation'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    '/usr/share/steam'
  ]
  const seen = new Set<string>()
  return candidates
    .map(p => {
      try { return path.resolve(p) } catch { return p }
    })
    .filter(p => {
      if (!p || seen.has(p)) return false
      seen.add(p)
      return fs.existsSync(p)
    })
}

function firstExisting(paths: string[]) {
  return paths.find(p => {
    try { return fs.existsSync(p) } catch { return false }
  }) || null
}

function diagnosticStatus(ok: boolean, warn = false): 'ok' | 'warn' | 'error' {
  if (ok) return 'ok'
  return warn ? 'warn' : 'error'
}

function parseProtonOptions(raw: any) {
  let parsed: any = {}
  let invalid = false
  try {
    parsed = raw ? JSON.parse(String(raw)) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parsed = {}
      invalid = true
    }
  } catch {
    parsed = {}
    invalid = Boolean(raw)
  }

  return {
    invalid,
    options: {
      ...DEFAULT_PROTON_OPTIONS,
      ...parsed,
      esync: parsed.esync !== false,
      fsync: parsed.fsync !== false,
      dxvk: parsed.dxvk !== false,
      mesa_glthread: !!parsed.mesa_glthread,
      locale: parsed.locale || '',
      gamemode: !!parsed.gamemode,
      mangohud: !!parsed.mangohud,
      logging: !!parsed.logging,
      steamOverlay: parsed.steamOverlay !== false,
      launchArgs: parsed.launchArgs || '',
      useGamescope: !!parsed.useGamescope,
      wineDllOverrides: parsed.wineDllOverrides || ''
    }
  }
}

function isEmptyOrPlaceholderAppId(value: any) {
  const id = String(value || '').trim()
  return !id || id === '0' || id === '480'
}

function startSteamClient(command: string) {
  const child = spawn(command, ['-silent'], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()
}

async function collectGameDiagnostics(gameUrl: string, ctx: IpcContext) {
  const game = getGame(gameUrl) as any
  if (!game) return { success: false, error: 'Jogo não encontrado', errorCode: 'game-not-found' }

  const installPath = pathInfo(game.install_path)
  const exePath = pathInfo(game.executable_path, installPath.exists && installPath.type === 'directory' ? installPath.path : null)
  const prefixPath = pathInfo(game.proton_prefix)
  const detectedRuntime = findProtonRuntime()
  const runtimePath = pathInfo(game.proton_runtime || detectedRuntime)
  const protonRunner = runtimePath.exists && runtimePath.type === 'directory'
    ? pathInfo(path.join(runtimePath.path, 'proton'))
    : pathInfo(null)

  const steamRoots = steamRootCandidates()
  const steamRoot = steamRoots[0] || null
  const overlay32 = firstExisting(steamRoots.map(root => path.join(root, 'ubuntu12_32', 'gameoverlayrenderer.so')))
  const overlay64 = firstExisting(steamRoots.map(root => path.join(root, 'ubuntu12_64', 'gameoverlayrenderer.so')))
  const vk32 = firstExisting(steamRoots.flatMap(root => [
    path.join(root, 'ubuntu12_32', 'steamoverlayvulkanlayer.so'),
    path.join(root, 'steamrt32', 'steamoverlayvulkanlayer.so')
  ]))
  const vk64 = firstExisting(steamRoots.flatMap(root => [
    path.join(root, 'ubuntu12_64', 'steamoverlayvulkanlayer.so'),
    path.join(root, 'steamrt64', 'steamoverlayvulkanlayer.so')
  ]))

  let onlineFix: any = { found: false }
  if (installPath.exists && installPath.type === 'directory') {
    try {
      const found = await findAndReadOnlineFixIni(installPath.path)
      if (found?.content) {
        const ids = extractOnlineFixOverlayIds(found.content)
        onlineFix = {
          found: true,
          path: found.path,
          steamAppId: ids.steamAppId || null,
          steamAppIdSource: ids.steamAppIdSource || null,
          fakeAppId: ids.fakeAppId || null,
          realAppId: ids.realAppId || null,
          epicProductId: ids.epicProductId || null
        }
      }
    } catch {
      onlineFix = { found: false, error: 'Falha ao ler OnlineFix.ini', errorCode: 'onlinefix-ini-unreadable' }
    }
  }

  const parsedProtonOptions = parseProtonOptions(game.proton_options)
  const protonOptions = parsedProtonOptions.options
  const configuredSteamAppId = String(game.steam_app_id || '').trim()
  const detectedSteamAppId = installPath.exists && installPath.type === 'directory'
    ? detectSteamAppIdFromInstall(installPath.path)
    : null
  const overlayPolicy = resolveOverlayCompatibility({
    installPath: installPath.exists && installPath.type === 'directory' ? installPath.path : null,
    onlineFix,
    configuredSteamAppId,
    detectedSteamAppId,
    protonOptions
  })
  const overlayAppId = overlayPolicy.steamOverlayAppId
  const overlayEnabled = overlayPolicy.enableSteamOverlay
  const displayCompatibility = getDisplayCompatibilityInfo()
  const eosOverlayPath = findEosOverlayInstallPath(app.getPath('userData'))
  const eosOverlayValid = isEosOverlayPathValid(eosOverlayPath)
  const legendaryPath = await resolveLegendaryBinary()
  const running = ctx.runningGames.get(gameUrl)
  const runningPidAlive = Boolean(running?.pid && isPidAlive(running.pid))
  const steamCmd = commandPath('steam')
  const steamRunning = isProcessRunning(['steam', 'steamwebhelper'])
  const needsExecutableRepair = !exePath.exists || exePath.type !== 'file'
  const candidateExe = needsExecutableRepair && installPath.exists && installPath.type === 'directory'
    ? findExecutableInDir(installPath.path, { prefer: game.launch_executable })
    : null

  const repairActions: any[] = []
  const addRepair = (id: string, label: string, detail: string, payload?: any) => {
    repairActions.push({ id, label, detail, automatic: true, payload })
  }

  if (running && !runningPidAlive) {
    addRepair('clear-stale-running-state', 'Limpar estado de execução preso', `PID ${running.pid} não está mais ativo`)
  }
  if (needsExecutableRepair && candidateExe) {
    addRepair('set-detected-executable', 'Definir executável detectado', candidateExe, { executablePath: candidateExe })
  }
  if ((!protonRunner.exists || !game.proton_runtime) && detectedRuntime) {
    addRepair('set-detected-proton-runtime', 'Definir runtime Proton detectado', detectedRuntime, { runtimePath: detectedRuntime })
  }
  if (parsedProtonOptions.invalid) {
    addRepair('normalize-proton-options', 'Recriar opções Proton inválidas', 'O JSON salvo está quebrado e será substituído pelos padrões seguros', { options: protonOptions })
  } else if (!game.proton_options) {
    addRepair('normalize-proton-options', 'Salvar opções Proton padrão', 'Cria uma configuração explícita para evitar divergência entre UI e launch', { options: protonOptions })
  }
  if ((!prefixPath.exists || prefixPath.type !== 'directory') && detectedRuntime && process.platform === 'linux') {
    addRepair('create-game-prefix', 'Criar prefixo dedicado', 'Cria/atualiza o prefixo Wine deste jogo em background', { runtimePath: detectedRuntime })
  }
  if (overlayPolicy.store === 'steam' && onlineFix.realAppId && isEmptyOrPlaceholderAppId(configuredSteamAppId)) {
    addRepair('set-onlinefix-real-appid', 'Salvar Steam AppID real do OnlineFix', onlineFix.realAppId, { steamAppId: onlineFix.realAppId })
  }
  if (overlayPolicy.selectedOverlay === 'steam' && steamCmd && !steamRunning) {
    addRepair('start-steam-client', 'Iniciar Steam para overlay', 'Abre o Steam em modo silencioso para melhorar a chance do Shift+Tab funcionar', { command: steamCmd })
  }

  const displayDetail = [
    displayCompatibility.sessionType ? `sessão ${displayCompatibility.sessionType}` : 'sessão desconhecida',
    displayCompatibility.waylandDisplay ? `Wayland ${displayCompatibility.waylandDisplay}` : null,
    displayCompatibility.display ? `X11 ${displayCompatibility.display}` : null,
    displayCompatibility.isGamescope ? `Gamescope${displayCompatibility.gamescopePid ? ` PID ${displayCompatibility.gamescopePid}` : ''}` : null
  ].filter(Boolean).join(' / ')

  const checks = [
    {
      id: 'install-path',
      label: 'Pasta de instalação',
      status: diagnosticStatus(installPath.exists && installPath.type === 'directory'),
      detail: installPath.path || 'Não configurada'
    },
    {
      id: 'executable',
      label: 'Executável',
      status: diagnosticStatus(exePath.exists && exePath.type === 'file'),
      detail: exePath.path || 'Não configurado'
    },
    {
      id: 'proton-runtime',
      label: 'Runtime Proton',
      status: diagnosticStatus(Boolean(protonRunner.exists), true),
      detail: protonRunner.exists ? protonRunner.path : (runtimePath.path || 'Não encontrado')
    },
    {
      id: 'prefix',
      label: 'Prefixo Wine',
      status: diagnosticStatus(prefixPath.exists && prefixPath.type === 'directory', true),
      detail: prefixPath.path || 'Será criado automaticamente'
    },
    {
      id: 'onlinefix',
      label: 'OnlineFix.ini',
      status: onlineFix.found ? 'ok' : 'warn',
      detail: onlineFix.found ? onlineFix.path : 'Não encontrado no diretório do jogo'
    },
    {
      id: 'steam-client',
      label: 'Cliente Steam',
      status: overlayPolicy.selectedOverlay !== 'steam' ? 'info' : steamCmd ? 'ok' : 'warn',
      detail: overlayPolicy.selectedOverlay !== 'steam'
        ? `Não necessário para overlay ${overlayPolicy.selectedOverlay === 'eos' ? 'Epic/EOS' : 'desativado'}`
        : steamCmd ? `Comando steam disponível: ${steamCmd}` : 'Comando steam não encontrado no PATH'
    },
    {
      id: 'steam-running',
      label: 'Steam rodando',
      status: overlayPolicy.selectedOverlay !== 'steam' ? 'info' : steamRunning ? 'ok' : 'warn',
      detail: overlayPolicy.selectedOverlay !== 'steam'
        ? 'Não será iniciado porque este jogo não foi classificado como Steam'
        : steamRunning ? 'Steam está ativo' : 'Necessário para Shift+Tab funcionar de forma confiável'
    },
    {
      id: 'overlay-policy',
      label: 'Decisão de overlay',
      status: overlayPolicy.selectedOverlay === 'none' ? 'info' : 'ok',
      detail: `${overlayPolicy.store.toUpperCase()} -> ${overlayPolicy.selectedOverlay === 'steam' ? `Steam (${overlayPolicy.steamOverlayAppId})` : overlayPolicy.selectedOverlay === 'eos' ? 'Epic/EOS' : 'nenhum'}: ${overlayPolicy.reason}`
    },
    {
      id: 'steam-overlay',
      label: 'Steam Overlay',
      status: overlayPolicy.selectedOverlay === 'steam' && overlay32 && overlay64 ? 'ok' : overlayPolicy.selectedOverlay === 'steam' ? 'warn' : 'info',
      detail: overlayEnabled
        ? `AppID do overlay: ${overlayAppId}`
        : overlayPolicy.store === 'epic'
          ? 'Jogo detectado como Epic/EOS; Steam Overlay não será injetado'
          : 'Sem AppID Steam/OnlineFix detectado ou toggle desligado'
    },
    {
      id: 'eos-overlay',
      label: 'Epic/EOS Overlay',
      status: overlayPolicy.selectedOverlay !== 'eos' ? 'info' : eosOverlayValid ? 'ok' : legendaryPath ? 'warn' : 'warn',
      detail: overlayPolicy.selectedOverlay !== 'eos'
        ? 'Não necessário para este jogo'
        : eosOverlayValid
          ? `EOS overlay encontrado: ${eosOverlayPath}`
          : legendaryPath
            ? `EOS overlay ainda não instalado; Legendary disponível em ${legendaryPath} e o launch pode instalar/ativar`
            : 'EOS overlay não encontrado; instale Legendary ou permita o launcher baixar/ativar no primeiro launch'
    },
    {
      id: 'vulkan-overlay',
      label: 'Vulkan Overlay Layer',
      status: overlayPolicy.selectedOverlay !== 'steam' ? 'info' : vk32 || vk64 ? 'ok' : 'warn',
      detail: overlayPolicy.selectedOverlay !== 'steam'
        ? 'Checagem relevante apenas quando Steam Overlay é usado'
        : [vk64 ? '64-bit OK' : '64-bit ausente', vk32 ? '32-bit OK' : '32-bit ausente'].join(' / ')
    },
    {
      id: 'display-server',
      label: 'Sessão gráfica',
      status: displayCompatibility.isWayland || displayCompatibility.isGamescope ? 'warn' : 'ok',
      detail: displayCompatibility.warnings.length ? `${displayDetail || 'ambiente desconhecido'}; ${displayCompatibility.warnings.join(' ')}` : (displayDetail || 'Ambiente X11/padrão')
    }
  ]

  return {
    success: true,
    diagnostics: {
      generatedAt: Date.now(),
      game: {
        title: game.title,
        url: game.url,
        gameId: game.game_id || extractGameIdFromUrl(game.url),
        installedVersion: game.installed_version || null,
        latestVersion: game.latest_version || null
      },
      paths: {
        install: installPath,
        executable: exePath,
        prefix: prefixPath,
        protonRuntime: runtimePath,
        protonRunner,
        detectedExecutable: candidateExe,
        detectedProtonRuntime: detectedRuntime
      },
      steam: {
        commandAvailable: Boolean(steamCmd),
        commandPath: steamCmd,
        running: steamRunning,
        roots: steamRoots,
        selectedRoot: steamRoot,
        overlay32,
        overlay64,
        vulkan32: vk32,
        vulkan64: vk64,
        configuredSteamAppId: configuredSteamAppId || null,
        detectedSteamAppId,
        overlayAppId,
        overlayEnabled
      },
      epic: {
        overlayPath: eosOverlayPath,
        overlayValid: eosOverlayValid,
        legendaryPath
      },
      display: displayCompatibility,
      overlayCompatibility: overlayPolicy,
      onlineFix,
      protonOptions,
      protonOptionsInvalid: parsedProtonOptions.invalid,
      running: running
        ? { pid: running.pid, alive: runningPidAlive, startedAt: running.startedAt || null, protonLogPath: running.protonLogPath || null }
        : null,
      tools: {
        gamescope: commandExists('gamescope'),
        gamemoderun: commandExists('gamemoderun'),
        winetricks: commandExists('winetricks')
      },
      checks,
      repairActions
    }
  }
}

export const registerGameHandlers: IpcHandlerRegistrar = (ctx: IpcContext) => {
  ipcMain.handle('get-games', async () => {
    try {
      const games = getAllGames()
      return { success: true, games }
    } catch (err: any) {
      return { success: false, error: err.message, games: [] }
    }
  })

  ipcMain.handle('delete-game', async (_event, url: string) => {
    try {
      const game = getGame(url) as { install_path?: string } | undefined

      // Delete game folder if it exists
      if (game?.install_path) {
        const rawPath = String(game.install_path)
        let installPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath)

        try {
          if (fs.existsSync(installPath)) {
            const st = fs.statSync(installPath)
            if (st.isFile()) installPath = path.dirname(installPath)
          }
        } catch {}

        // Basic safety guard: never delete filesystem root
        if (installPath && path.parse(installPath).root === installPath) {
          console.warn('[DeleteGame] Refusing to delete root path:', installPath)
        } else if (fs.existsSync(installPath)) {
          console.log('[DeleteGame] Removing game folder:', installPath)
          try {
            fs.rmSync(installPath, { recursive: true, force: true })
            console.log('[DeleteGame] Game folder removed successfully')
          } catch (folderErr: any) {
            console.warn('[DeleteGame] Failed to remove game folder:', folderErr.message)
          }
        }
      }

      deleteGame(url)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('open-game-folder', async (_event, installPath?: string) => {
    try {
      if (!installPath) return { success: false, error: 'Path not provided', errorCode: 'path-missing' }
      const normalized = path.isAbsolute(installPath) ? installPath : path.resolve(process.cwd(), installPath)
      await shell.openPath(normalized)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('configure-game-exe', async (_event, gameUrl: string) => {
    try {
      const res = await dialog.showOpenDialog({
        title: 'Selecione o executável do jogo',
        properties: ['openFile'],
        filters: [{ name: 'Executáveis', extensions: ['exe'] }]
      })
      if (res.canceled || !res.filePaths.length) return { success: false, error: 'Nenhum arquivo selecionado', errorCode: 'no-file-selected' }
      const exePath = res.filePaths[0]
      updateGameInfo(gameUrl, { executable_path: exePath })
      return { success: true, exePath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-game-diagnostics', async (_event, gameUrl: string) => {
    try {
      return await collectGameDiagnostics(gameUrl, ctx)
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao gerar diagnóstico' }
    }
  })

  ipcMain.handle('repair-game-diagnostics', async (_event, gameUrl: string) => {
    const results: Array<{ id: string; label: string; status: 'done' | 'skipped' | 'error'; detail?: string }> = []
    try {
      const before = await collectGameDiagnostics(gameUrl, ctx)
      if (!before.success) return before

      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo não encontrado', errorCode: 'game-not-found' }

      for (const action of before.diagnostics?.repairActions || []) {
        try {
          switch (action.id) {
            case 'clear-stale-running-state':
              ctx.runningGames.delete(gameUrl)
              results.push({ id: action.id, label: action.label, status: 'done', detail: 'Estado de execução limpo' })
              break

            case 'set-detected-executable': {
              const executablePath = String(action.payload?.executablePath || '').trim()
              if (!executablePath || !fs.existsSync(executablePath)) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Executável detectado não existe mais' })
                break
              }
              updateGameInfo(gameUrl, { executable_path: executablePath })
              results.push({ id: action.id, label: action.label, status: 'done', detail: executablePath })
              break
            }

            case 'set-detected-proton-runtime': {
              const runtimePath = String(action.payload?.runtimePath || findProtonRuntime() || '').trim()
              if (!runtimePath || !fs.existsSync(path.join(runtimePath, 'proton'))) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Runtime Proton não encontrado' })
                break
              }
              updateGameInfo(gameUrl, { proton_runtime: runtimePath })
              results.push({ id: action.id, label: action.label, status: 'done', detail: runtimePath })
              break
            }

            case 'normalize-proton-options': {
              const options = action.payload?.options || DEFAULT_PROTON_OPTIONS
              updateGameInfo(gameUrl, { proton_options: JSON.stringify(options) })
              results.push({ id: action.id, label: action.label, status: 'done', detail: 'Opções Proton normalizadas' })
              break
            }

            case 'create-game-prefix': {
              if (ctx.inFlightPrefixJobs.has(gameUrl)) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Já existe uma operação de prefixo em andamento' })
                break
              }

              const latestGame = getGame(gameUrl) as any
              const stableId = (latestGame?.game_id as string | null) || extractGameIdFromUrl(gameUrl)
              const slug = stableId ? `game_${stableId}` : slugify(latestGame?.title || game.title || gameUrl || 'game')
              const runtimePath = String(action.payload?.runtimePath || latestGame?.proton_runtime || findProtonRuntime() || '').trim()
              if (!runtimePath) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Runtime Proton não encontrado' })
                break
              }

              ctx.inFlightPrefixJobs.set(gameUrl, { startedAt: Date.now() })
              ctx.sendPrefixJobStatus({ gameUrl, status: 'starting', message: 'Autocorreção: preparando prefixo...' })
              const prefix = await ensureGamePrefixFromDefault(slug, runtimePath, undefined, true, (msg) => {
                ctx.sendPrefixJobStatus({ gameUrl, status: 'progress', message: `Autocorreção: ${msg}` })
              }, latestGame?.install_path || undefined, latestGame?.proton_prefix || undefined)
              updateGameInfo(gameUrl, { proton_prefix: prefix })
              ctx.inFlightPrefixJobs.delete(gameUrl)
              ctx.sendPrefixJobStatus({ gameUrl, status: 'done', message: 'Prefixo pronto', prefix })
              results.push({ id: action.id, label: action.label, status: 'done', detail: prefix })
              break
            }

            case 'set-onlinefix-real-appid': {
              const steamAppId = String(action.payload?.steamAppId || '').replace(/[^\d]/g, '')
              if (!steamAppId) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Steam AppID inválido' })
                break
              }
              updateGameInfo(gameUrl, { steam_app_id: steamAppId })
              results.push({ id: action.id, label: action.label, status: 'done', detail: steamAppId })
              break
            }

            case 'start-steam-client': {
              const steam = String(action.payload?.command || commandPath('steam') || '').trim()
              if (!steam) {
                results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Comando steam não encontrado' })
                break
              }
              startSteamClient(steam)
              results.push({ id: action.id, label: action.label, status: 'done', detail: 'Steam iniciado em modo silencioso' })
              break
            }

            default:
              results.push({ id: action.id, label: action.label, status: 'skipped', detail: 'Ação desconhecida' })
              break
          }
        } catch (err: any) {
          if (action.id === 'create-game-prefix') {
            try { ctx.inFlightPrefixJobs.delete(gameUrl) } catch {}
            ctx.sendPrefixJobStatus({ gameUrl, status: 'error', message: err?.message || String(err) })
          }
          results.push({ id: action.id, label: action.label, status: 'error', detail: err?.message || String(err) })
        }
      }

      const after = await collectGameDiagnostics(gameUrl, ctx)
      return { success: true, actions: results, diagnostics: after.success ? after.diagnostics : undefined }
    } catch (err: any) {
      return { success: false, actions: results, error: err?.message || 'Falha ao autocorrigir diagnóstico' }
    }
  })

  ipcMain.handle('set-game-version', async (_event, gameUrl: string, version: string) => {
    try {
      updateGameInfo(gameUrl, { installed_version: version })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('set-game-title', async (_event, gameUrl: string, title: string) => {
    try {
      updateGameInfo(gameUrl, { title })
      ctx.fetchAndPersistBanner(gameUrl, title).catch(() => {})
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('set-game-favorite', async (_event, gameUrl: string, isFavorite: boolean) => {
    try {
      setGameFavorite(gameUrl, !!isFavorite)
      return { success: true, isFavorite: !!isFavorite }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('toggle-game-favorite', async (_event, gameUrl: string) => {
    try {
      const res = toggleGameFavorite(gameUrl)
      return { success: true, isFavorite: !!res?.isFavorite }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('check-all-updates', async () => {
    try {
      const games = (getAllGames() as any[])
        .filter((g: any) => g?.url)
        .filter((g: any) => /^https?:\/\//.test(String(g.url || '')))
      const results: Array<{ url: string; latest?: string; torrentUrl?: string; error?: string }> = []

      const queue = [...games]
      const concurrency = 4
      const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }).map(async () => {
        while (queue.length) {
          const g: any = queue.shift()
          if (!g?.url) continue
          try {
            const info = await fetchGameUpdateInfo(String(g.url))
            if (!info.version) throw new Error('Versao nao encontrada na pagina')
            const payload: any = { latest_version: info.version }
            if (info.torrentUrl) {
              payload.torrent_magnet = info.torrentUrl
              payload.download_url = info.torrentUrl
            }
            updateGameInfo(g.url, payload)
            results.push({ url: g.url, latest: info.version, torrentUrl: info.torrentUrl || undefined })
            ctx.getMainWindow()?.webContents.send('game-version-update', { url: g.url, latest: info.version })
            
            // Check if this is actually a new update (version differs from installed)
            const currentVersion = String(g.installed_version || '').toLowerCase().trim()
            const latestVersion = String(info.version || '').toLowerCase().trim()
            if (currentVersion && latestVersion && currentVersion !== latestVersion && g.is_installed) {
              try {
                const { notifyUpdateAvailable } = require('../notificationOverlay.js')
                notifyUpdateAvailable(g.title || 'Jogo', info.version)
              } catch {}
            }
          } catch (err: any) {
            results.push({ url: String(g.url), error: err?.message || 'unknown error' })
          }
        }
      })

      await Promise.all(workers)

      return { success: true, results }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao verificar atualizações' }
    }
  })

  ipcMain.handle('set-game-proton-options', async (_event, gameUrl: string, runtime: string, options: any) => {
    try {
      updateGameInfo(gameUrl, { proton_runtime: runtime || null })
      updateGameInfo(gameUrl, { proton_options: JSON.stringify(options || {}) })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('export-game-fix', async (_event, gameUrl: string, rawFix?: any) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      // With a fix in hand this writes that one; without, it still exports a
      // snapshot of how the game is configured right now.
      const fix = rawFix ? normalizeGameFix(rawFix) : buildGameFix(game)
      // The published repo requires the file to be named after the id, so a fix
      // exported from the editor can be dropped straight into fixes/.
      const defaultPath = `${safeFileName(rawFix ? fix.id : `${game.title || 'game'}-fix`)}.json`
      const saveOptions: SaveDialogOptions = {
        title: 'Exportar fix do jogo',
        defaultPath,
        filters: [
          { name: 'VoidLauncher game fix', extensions: ['json'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      }
      const owner = ctx.getMainWindow?.() || null
      const res = owner
        ? await dialog.showSaveDialog(owner, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (res.canceled || !res.filePath) return { success: false, canceled: true }

      fs.writeFileSync(res.filePath, JSON.stringify(fix, null, 2))
      return { success: true, fix, path: res.filePath }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao exportar fix' }
    }
  })

  /**
   * A fix that describes the game as it is set up right now: the runtime, its
   * options and the executable in use. It is what the fix editor opens with, so
   * writing one starts from a working configuration instead of a blank file.
   */
  ipcMain.handle('build-game-fix-draft', async (_event, gameUrl: string) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }
      return { success: true, fix: buildGameFix(game) }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao montar o rascunho do fix' }
    }
  })

  /** The names a fix may put in launchExecutable, read off the game folder. */
  ipcMain.handle('list-game-executables', async (_event, gameUrl: string) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      const installDir = String(game.install_path || '').trim()
      if (!installDir || !fs.existsSync(installDir)) {
        return { success: true, executables: [], installed: false }
      }

      return { success: true, executables: listExecutablesInDir(installDir), installed: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao listar executáveis' }
    }
  })

  ipcMain.handle('import-game-fix', async () => {
    try {
      const openOptions: OpenDialogOptions = {
        title: 'Importar fix do jogo',
        properties: ['openFile'],
        filters: [
          { name: 'VoidLauncher game fix', extensions: ['json'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      }
      const owner = ctx.getMainWindow?.() || null
      const res = owner
        ? await dialog.showOpenDialog(owner, openOptions)
        : await dialog.showOpenDialog(openOptions)
      if (res.canceled || !res.filePaths?.[0]) return { success: false, canceled: true }

      const raw = fs.readFileSync(res.filePaths[0], 'utf8')
      if (raw.length > 256 * 1024) return { success: false, error: 'Arquivo de fix muito grande', errorCode: 'fix-file-too-large' }

      const fix = normalizeGameFix(JSON.parse(raw))
      return { success: true, fix, path: res.filePaths[0] }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao importar fix' }
    }
  })

  ipcMain.handle('list-game-fixes', async (_event, gameUrl: string) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }
      const fixes = listLocalGameFixes(game).map(item => ({
        fix: item.fix,
        path: item.path,
        updatedAt: item.updatedAt
      }))
      return { success: true, fixes, directory: getGameFixesRoot() }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao listar fixes' }
    }
  })

  ipcMain.handle('list-remote-game-fixes', async (_event, gameUrl: string, force?: boolean) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      const { fixes, fromCache, error } = await getRemoteFixIndex({ force: Boolean(force) })
      const installed = new Set(listLocalGameFixes(game).map((item) => item.fix.id))

      // The index carries every published fix; only the ones for this game are
      // worth showing, matched the same way a local fix is.
      const matching = fixes
        .filter((entry) => fixMatchesGame({ game: entry.game } as CommunityGameFix, game))
        .map((entry) => ({ ...entry, alreadySaved: installed.has(entry.id) }))

      return { success: true, fixes: matching, fromCache, warning: error }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao consultar os fixes publicados' }
    }
  })

  ipcMain.handle('download-remote-game-fix', async (_event, gameUrl: string, fixId: string) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      // What comes off the network goes through the same normaliser as a file
      // someone imported by hand; nothing is trusted for having been published.
      const saved = saveLocalGameFix(game, await getRemoteFix(fixId))
      return { success: true, fix: saved.fix, path: saved.path }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao baixar o fix' }
    }
  })

  ipcMain.handle('save-game-fix', async (_event, gameUrl: string, rawFix: any) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }
      const saved = saveLocalGameFix(game, rawFix)
      return { success: true, fix: saved.fix, path: saved.path }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao salvar fix' }
    }
  })

  ipcMain.handle('delete-game-fix', async (_event, gameUrl: string, fixId: string) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }
      const cleanId = safeText(fixId, 120)
      if (!cleanId) return { success: false, error: 'Fix inválido', errorCode: 'fix-invalid' }
      const match = listLocalGameFixes(game).find(item => item.fix.id === cleanId)
      if (!match) return { success: false, error: 'Fix não encontrado', errorCode: 'fix-not-found' }

      const root = path.resolve(getGameFixesRoot())
      const target = path.resolve(match.path)
      if (!target.startsWith(root + path.sep)) return { success: false, error: 'Path de fix inválido', errorCode: 'fix-path-invalid' }
      fs.rmSync(target, { force: true })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao remover fix' }
    }
  })

  ipcMain.handle('apply-game-fix', async (_event, gameUrl: string, rawFix: any, rawInputValues?: any) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      const fix = normalizeGameFix(rawFix)
      const os = currentFixOs()
      if (!fixAppliesToOs(fix.os, os)) {
        return {
          success: false,
          error: 'Este fix não se aplica a este sistema',
          errorCode: 'fix-os-mismatch',
          fixOs: fix.os || []
        }
      }

      const resolvedInputs = resolveFixForApply(fix, rawInputValues)
      if (resolvedInputs.missing.length || resolvedInputs.invalid.length) {
        return {
          success: false,
          error: 'Este fix precisa de valores que ainda não foram informados',
          errorCode: 'fix-inputs-required',
          missingInputs: resolvedInputs.missing,
          invalidInputs: resolvedInputs.invalid
        }
      }

      const patch: any = {}
      const warnings: string[] = []

      // Half of what a fix carries is Proton's doing and means nothing outside
      // it. On Windows those parts are skipped and said out loud, rather than
      // written into the database where they would look applied.
      const onProton = os === 'linux'
      let runtime: { runtimePath?: string | null; warning?: string } = {}

      if (onProton) {
        runtime = resolveRuntimePathFromFix(fix)
        if (runtime.warning) warnings.push(runtime.warning)
        if (runtime.runtimePath !== undefined) patch.proton_runtime = runtime.runtimePath || null
        if (fix.proton?.options) patch.proton_options = JSON.stringify(safeProtonOptions(resolvedInputs.options))
      } else if (fix.proton?.options) {
        // The launch arguments are the one setting a game needs wherever it
        // runs, so they are kept and merged into what this game already has.
        const current = parseFixProtonOptions(game.proton_options)
        patch.proton_options = JSON.stringify(safeProtonOptions({
          ...current,
          launchArgs: resolvedInputs.options?.launchArgs ?? current.launchArgs
        }))
        if (PROTON_ONLY_OPTION_KEYS.some((key) => (fix.proton?.options as any)?.[key] !== undefined)) {
          warnings.push('Configurações de Proton do fix foram ignoradas: elas só valem no Linux.')
        }
        if (fix.proton?.runtimeName) warnings.push('O runtime Proton indicado pelo fix foi ignorado: ele só vale no Linux.')
      }

      if (fix.proton?.steamAppId !== undefined) patch.steam_app_id = fix.proton.steamAppId || null

      if (fix.launchExecutable) {
        patch.launch_executable = fix.launchExecutable
        // Resolved against the folder right away, so the fix takes effect
        // without waiting for a repair pass. The name only selects among what
        // is there; the path still comes from the scan.
        const installDir = String(game.install_path || '').trim()
        const resolved = installDir && fs.existsSync(installDir)
          ? findExecutableInDir(installDir, { prefer: fix.launchExecutable })
          : null

        if (resolved && path.basename(resolved).toLowerCase() === fix.launchExecutable.toLowerCase()) {
          patch.executable_path = resolved
        } else {
          warnings.push(`Executável indicado pelo fix não foi encontrado na pasta do jogo: ${fix.launchExecutable}`)
        }
      }

      if (Object.keys(patch).length) updateGameInfo(gameUrl, patch)

      // These come out of the Proton runtime's wine-mono; on Windows the system
      // itself is where the game finds them.
      const assemblies = onProton
        ? deliverRuntimeAssemblies(game, fix, runtime.runtimePath)
        : { copied: [], warnings: fix.runtimeAssemblies?.length ? ['Assemblies do runtime foram ignorados: eles vêm do Proton, que só existe no Linux.'] : [] }
      warnings.push(...assemblies.warnings)

      return {
        success: true,
        fix,
        patch,
        warnings,
        copiedAssemblies: assemblies.copied,
        pendingComponents: fix.components || { winetricks: [] }
      }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao aplicar fix' }
    }
  })

  /**
   * Fetches the files a fix points at.
   *
   * Its own step, never part of applying the settings: this is the one thing a
   * fix does that reaches outside the machine, and the renderer only calls it
   * after the person has been shown the host, the size, the hash and the
   * destination, and agreed to that screen. Everything it was shown is checked
   * again here.
   */
  ipcMain.handle('install-game-fix-downloads', async (_event, gameUrl: string, rawFix: any) => {
    try {
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      const fix = normalizeGameFix(rawFix)
      const os = currentFixOs()
      if (!fixAppliesToOs(fix.os, os)) {
        return { success: false, error: 'Este fix não se aplica a este sistema', errorCode: 'fix-os-mismatch' }
      }

      const downloads = (fix.downloads || []).filter((entry) => fixAppliesToOs(entry.os, os))
      if (!downloads.length) return { success: true, installed: [], warnings: [] }

      const window = ctx.getMainWindow()
      const result = await installFixDownloads({
        game,
        fixId: fix.id,
        downloads,
        onProgress: (progress) => {
          try {
            window?.webContents.send('game-fix-download-progress', { gameUrl, ...progress })
          } catch {
            // The dialog falls back to its own spinner if nothing arrives.
          }
        }
      })

      return {
        success: true,
        installed: result.installed,
        warnings: result.warnings,
        backupDir: result.backupDir
      }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao baixar os arquivos do fix', errorCode: 'fix-download-failed' }
    }
  })

  ipcMain.handle('install-game-fix-components', async (_event, gameUrl: string, rawFix: any) => {
    try {
      // winetricks installs into a Wine prefix; there is nothing to install into
      // on Windows, and a fix that names components is not broken there.
      if (process.platform !== 'linux') return { success: true, installed: [], warnings: ['Componentes winetricks foram ignorados: eles só valem no Linux.'] }
      const game = getGame(gameUrl) as any
      if (!game) return { success: false, error: 'Jogo nao encontrado', errorCode: 'game-not-found' }

      const fix = normalizeGameFix(rawFix)
      const components = getFixWinetricksComponents(fix)
      const warnings: string[] = []

      if (!components.length) {
        return { success: true, installed: [], warnings }
      }
      if (!winetricksAvailable()) {
        return { success: false, error: 'winetricks não está instalado', errorCode: 'winetricks-missing' }
      }
      if (ctx.inFlightPrefixJobs.has(gameUrl)) {
        return { success: false, error: 'Já existe uma operação de prefixo em andamento para este jogo', errorCode: 'prefix-operation-in-progress' }
      }

      const runtimeFromFix = resolveRuntimePathFromFix(fix)
      if (runtimeFromFix.warning) warnings.push(runtimeFromFix.warning)
      const runtimePath = runtimeFromFix.runtimePath || game.proton_runtime || findProtonRuntime() || undefined
      const stableId = (game?.game_id as string | null) || extractGameIdFromUrl(gameUrl)
      const slug = stableId ? `game_${stableId}` : slugify(game?.title || gameUrl || 'game')

      ctx.inFlightPrefixJobs.set(gameUrl, { startedAt: Date.now() })
      ctx.sendPrefixJobStatus({ gameUrl, status: 'starting', message: 'Preparando prefixo para instalar componentes...' })
      const prefix = await ensureGamePrefixFromDefault(slug, runtimePath, undefined, false, (msg) => {
        ctx.sendPrefixJobStatus({ gameUrl, status: 'progress', message: msg })
      }, game.install_path || undefined, game.proton_prefix || undefined, true)
      if (game.proton_prefix !== prefix) updateGameInfo(gameUrl, { proton_prefix: prefix })

      ctx.sendPrefixJobStatus({ gameUrl, status: 'starting', message: `Instalando componentes do fix: ${components.join(' ')}`, prefix })
      const ok = await installExtraComponents(prefix, components, (msg) => {
        ctx.sendPrefixJobStatus({ gameUrl, status: 'progress', message: msg, prefix })
      }, runtimePath)

      ctx.inFlightPrefixJobs.delete(gameUrl)
      if (ok) {
        ctx.sendPrefixJobStatus({ gameUrl, status: 'done', message: 'Componentes do fix instalados', prefix })
      } else {
        ctx.sendPrefixJobStatus({ gameUrl, status: 'error', message: 'Falha ao instalar componentes do fix', prefix })
      }

      return { success: ok, prefix, installed: ok ? components : [], warnings, error: ok ? undefined : 'Falha ao instalar componentes do fix' }
    } catch (err: any) {
      try { ctx.inFlightPrefixJobs.delete(gameUrl) } catch {}
      ctx.sendPrefixJobStatus({ gameUrl, status: 'error', message: err?.message || String(err) })
      return { success: false, error: err?.message || 'Falha ao instalar componentes do fix' }
    }
  })

  ipcMain.handle('set-game-proton-prefix', async (_event, gameUrl: string, prefixPath: string | null) => {
    try {
      updateGameInfo(gameUrl, { proton_prefix: prefixPath || null })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('set-game-steam-appid', async (_event, gameUrl: string, steamAppId: string | null) => {
    try {
      const clean = steamAppId && String(steamAppId).trim() !== '' ? String(steamAppId).trim() : null
      updateGameInfo(gameUrl, { steam_app_id: clean })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('set-game-lan-settings', async (_event, gameUrl: string, payload: { mode?: string | null; networkId?: string | null; autoconnect?: boolean }) => {
    try {
      const mode = payload?.mode ? String(payload.mode) : null
      const networkId = payload?.networkId ? String(payload.networkId) : null
      const autoconnect = payload?.autoconnect ? 1 : 0
      updateGameInfo(gameUrl, { lan_mode: mode, lan_network_id: networkId, lan_autoconnect: autoconnect })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('set-game-image-url', async (_event, gameUrl: string, imageUrl: string | null) => {
    try {
      const value = (imageUrl || '').trim()
      if (!value) {
        updateGameInfo(gameUrl, { image_url: null })
        return { success: true, imageUrl: null }
      }

      if (value.length > 2048) return { success: false, error: 'URL muito longa', errorCode: 'url-too-long' }

      const allowed = value.startsWith('http://') || value.startsWith('https://') || value.startsWith('file://')
      if (!allowed) {
        return { success: false, error: 'URL inválida (use http(s):// ou file://)', errorCode: 'url-scheme-invalid' }
      }

      updateGameInfo(gameUrl, { image_url: value })
      return { success: true, imageUrl: value }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao definir banner' }
    }
  })

  ipcMain.handle('pick-game-banner-file', async (_event, gameUrl: string) => {
    try {
      const parent = BrowserWindow.getFocusedWindow() || ctx.getMainWindow() || undefined
      const options = {
        title: 'Selecionar banner (imagem)',
        properties: ['openFile'] as Array<'openFile'>,
        filters: [
          { name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'Todos os arquivos', extensions: ['*'] }
        ]
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)

      if (result.canceled || !result.filePaths?.[0]) {
        return { success: false, canceled: true }
      }

      const srcPath = result.filePaths[0]
      const ext = (path.extname(srcPath) || '.png').toLowerCase()
      const game = getGame(gameUrl) as any
      const stableId = (game?.game_id as string | null) || extractGameIdFromUrl(gameUrl)
      const slug = stableId ? `game_${stableId}` : slugify(String(game?.title || gameUrl || 'game'))

      const imagesDir = path.join(app.getPath('userData'), 'images')
      fs.mkdirSync(imagesDir, { recursive: true })

      const destPath = path.join(imagesDir, `${slug}${ext}`)
      fs.copyFileSync(srcPath, destPath)

      const fileUrl = pathToFileURL(destPath).toString()
      updateGameInfo(gameUrl, { image_url: fileUrl })
      return { success: true, imageUrl: fileUrl, path: destPath }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao selecionar imagem' }
    }
  })

  ipcMain.handle('open-external', async (_event, target: string) => {
    try {
      const url = String(target || '').trim()
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'URL inválida', errorCode: 'url-invalid' }
      await shell.openExternal(url)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao abrir URL' }
    }
  })

  ipcMain.handle('open-path', async (_event, targetPath: string) => {
    try {
      if (targetPath) {
        const normalized = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath)
        let finalPath = normalized
        if (fs.existsSync(normalized)) {
          const stats = fs.statSync(normalized)
          if (stats.isFile()) {
            finalPath = path.dirname(normalized)
          }
        } else {
          const parent = path.dirname(normalized)
          if (fs.existsSync(parent)) {
            finalPath = parent
          }
        }

        const result = await shell.openPath(finalPath)
        if (result) {
          return { success: false, error: result }
        }
        return { success: true, path: finalPath }
      }
      return { success: false, error: 'Invalid path', errorCode: 'path-invalid' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('select-directory', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: 'Selecione uma pasta',
        properties: ['openDirectory', 'createDirectory']
      })
      if (res.canceled || !res.filePaths.length) return { success: false, error: 'Nenhuma pasta selecionada', errorCode: 'no-folder-selected' }
      return { success: true, path: res.filePaths[0] }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
