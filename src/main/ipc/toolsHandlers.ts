import { app, BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import fs from 'fs'
import https from 'https'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { IpcContext, IpcHandlerRegistrar } from './types'
import {
  getPrefixRootDir,
  getSavedProtonRuntime,
  isLinux,
  setSavedProtonRuntime,
  winetricksAvailable
} from '../protonManager'
import { ensureLegendaryAvailable, resolveLegendaryBinary, runLegendary } from '../legendary'
import { assetNamesHostArch, assetRunsOnHost } from '../utils/releaseAssets'
import { ensureLudusaviAvailable, resolveLudusaviBinary, runLudusavi } from '../ludusavi'
import { findEosOverlayInstallPath, isEosOverlayPathValid } from '../utils'
import { resolveAppIconPath } from '../appIcon'

type ManagedTool = 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay'
type ProtonProvider = 'proton-ge' | 'proton-cachyos'
type ReleaseInfo = {
  tag: string
  name: string
  publishedAt?: string
  assetName?: string
  downloadUrl?: string
}
type LegendaryAuthInfo = {
  loggedIn: boolean
  displayName?: string
  email?: string
  accountId?: string
  error?: string
  raw?: string
}
type EosOverlayInfo = {
  managed: boolean
  valid: boolean
  version?: string
  availableVersion?: string
  installPath?: string
  installedAt?: number
  raw?: string
  error?: string
}

const PROTON_GE_REPO = 'GloriousEggroll/proton-ge-custom'
const PROTON_CACHYOS_REPO = 'CachyOS/proton-cachyos'
const LEGENDARY_REPO = 'legendary-gl/legendary'
const LUDUSAVI_REPO = 'mtkennerly/ludusavi'
const releaseRefreshAttempted = new Set<ManagedTool>()
const LEGENDARY_EPIC_LOGIN_URL = 'https://legendary.gl/epiclogin'

function firstLine(text: string): string {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || ''
}

function httpJson(url: string, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'voidlauncher-tools'
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpJson(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject)
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function httpDownload(url: string, destFile: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'voidlauncher-tools' }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpDownload(new URL(res.headers.location, url).toString(), destFile, timeoutMs).then(resolve, reject)
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`download failed: HTTP ${res.statusCode}`))
        return
      }
      fs.mkdirSync(path.dirname(destFile), { recursive: true })
      const out = fs.createWriteStream(destFile)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function spawnCapture(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string; code?: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = opts?.timeoutMs ? setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, opts.timeoutMs) : null
    child.stdout?.on('data', b => { stdout += b.toString('utf8') })
    child.stderr?.on('data', b => { stderr += b.toString('utf8') })
    child.on('close', code => {
      if (timeout) clearTimeout(timeout)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
    child.on('error', err => {
      if (timeout) clearTimeout(timeout)
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(err) })
    })
  })
}

async function toolVersion(kind: 'legendary' | 'ludusavi', pathValue: string | null): Promise<string | null> {
  if (!pathValue) return null
  try {
    const result = kind === 'legendary'
      ? await runLegendary(['--version'], { timeoutMs: 8_000 })
      : await runLudusavi(['--version'], { timeoutMs: 8_000 })
    const text = firstLine(result.stdout) || firstLine(result.stderr)
    return text || null
  } catch {
    return null
  }
}

function managedToolDir(kind: 'legendary' | 'ludusavi'): string {
  return path.join(app.getPath('userData'), 'tools', kind, `${process.platform}-${process.arch}`)
}

function managedEosOverlayDir(): string {
  return path.join(app.getPath('userData'), 'tools', 'eos_overlay')
}

function managedProtonRoot(provider: ProtonProvider = 'proton-ge'): string {
  return path.join(os.homedir(), '.local', 'share', 'of-launcher', 'proton', provider)
}

function readTextIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf8').trim() || null
  } catch {
    return null
  }
}

function readManagedVersion(kind: 'legendary' | 'ludusavi'): string | null {
  return readTextIfExists(path.join(managedToolDir(kind), 'VERSION.txt'))
}

function stringFromDeepObject(value: any, keys: string[], depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 5) return undefined
  for (const key of keys) {
    const found = value[key]
    if (typeof found === 'string' && found.trim()) return found.trim()
    if (typeof found === 'number' && Number.isFinite(found)) return String(found)
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = stringFromDeepObject(child, keys, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

function parseLegendaryAuthInfo(stdout: string, stderr = ''): LegendaryAuthInfo {
  const raw = firstLine(stdout) || firstLine(stderr)
  try {
    const data = JSON.parse(stdout)
    const displayName = stringFromDeepObject(data, ['displayName', 'display_name', 'username', 'userName', 'account_name', 'accountName', 'name'])
    const email = stringFromDeepObject(data, ['email', 'emailAddress', 'email_address'])
    const accountId = stringFromDeepObject(data, ['accountId', 'account_id', 'epicAccountId', 'epic_account_id', 'id'])
    const status = String(data?.status || data?.state || '').toLowerCase()
    const loggedIn = Boolean(displayName || email || accountId || /login|authenticated|online|ok/.test(status))
    return { loggedIn, displayName, email, accountId, raw }
  } catch {
    const text = `${stdout}\n${stderr}`
    const displayName = /(?:user|account|display name)\s*[:=]\s*([^\r\n]+)/i.exec(text)?.[1]?.trim()
    const email = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(text)?.[1]?.trim()
    const loggedIn = Boolean(displayName || email || /logged in|authenticated|epic account/i.test(text))
    return { loggedIn, displayName, email, raw }
  }
}

function parseLegendaryCredentialInput(value: string, allowRaw = true, allowGenericCode = true): { kind: 'code' | 'token' | 'sid'; value: string } | null {
  const raw = String(value || '').trim()
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    const code = stringFromDeepObject(parsed, allowGenericCode
      ? ['authorizationCode', 'authorization_code', 'code', 'exchangeCode', 'exchange_code']
      : ['authorizationCode', 'authorization_code', 'exchangeCode', 'exchange_code'])
    if (code) return { kind: 'code', value: code }
    const token = stringFromDeepObject(parsed, ['exchangeToken', 'exchange_token', 'token'])
    if (token) return { kind: 'token', value: token }
    const sid = stringFromDeepObject(parsed, ['sid', 'sessionId', 'session_id'])
    if (sid) return { kind: 'sid', value: sid }
  } catch {
    // Raw code/token paste is supported below.
  }

  const codePattern = allowGenericCode
    ? /"?(?:authorizationCode|authorization_code|code|exchangeCode|exchange_code)"?\s*[:=]\s*"?([^",\s}]+)/i
    : /"?(?:authorizationCode|authorization_code|exchangeCode|exchange_code)"?\s*[:=]\s*"?([^",\s}]+)/i
  const codeMatch = codePattern.exec(raw)
  if (codeMatch?.[1]) return { kind: 'code', value: codeMatch[1].trim() }
  const tokenMatch = /"?(?:exchangeToken|exchange_token|token)"?\s*[:=]\s*"?([^",\s}]+)/i.exec(raw)
  if (tokenMatch?.[1]) return { kind: 'token', value: tokenMatch[1].trim() }
  const sidMatch = /"?(?:sid|sessionId|session_id)"?\s*[:=]\s*"?([^",\s}]+)/i.exec(raw)
  if (sidMatch?.[1]) return { kind: 'sid', value: sidMatch[1].trim() }

  return allowRaw ? { kind: 'code', value: raw.replace(/^"|"$/g, '') } : null
}

function parseLegendaryCredentialUrl(value: string): { kind: 'code' | 'token' | 'sid'; value: string } | null {
  try {
    const url = new URL(String(value || ''))
    const code = url.searchParams.get('authorizationCode') || url.searchParams.get('authorization_code') || url.searchParams.get('exchangeCode') || url.searchParams.get('exchange_code')
    if (code) return { kind: 'code', value: code }
    const token = url.searchParams.get('exchangeToken') || url.searchParams.get('exchange_token') || url.searchParams.get('token')
    if (token) return { kind: 'token', value: token }
    const sid = url.searchParams.get('sid') || url.searchParams.get('sessionId') || url.searchParams.get('session_id')
    if (sid) return { kind: 'sid', value: sid }
    if (url.hash) return parseLegendaryCredentialInput(url.hash.slice(1), false, false)
  } catch {
    // ignore
  }
  return null
}

function legendaryConfigDir(): string {
  const env = String(process.env.LEGENDARY_CONFIG_PATH || '').trim()
  if (env) return env.startsWith('~') ? path.join(os.homedir(), env.slice(1)) : env
  if (process.platform === 'win32') return path.join(app.getPath('appData'), 'legendary')
  return path.join(os.homedir(), '.config', 'legendary')
}

function readLegendaryAuthFile(): LegendaryAuthInfo | null {
  try {
    const filePath = path.join(legendaryConfigDir(), 'user.json')
    if (!fs.existsSync(filePath)) return null
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const displayName = stringFromDeepObject(data, ['displayName', 'display_name', 'username', 'userName', 'account_name', 'accountName', 'name'])
    const email = stringFromDeepObject(data, ['email', 'emailAddress', 'email_address'])
    const accountId = stringFromDeepObject(data, ['account_id', 'accountId', 'epicAccountId', 'epic_account_id', 'id', 'in_app_id'])
    const hasToken = Boolean(data?.access_token || data?.refresh_token)
    if (!hasToken && !displayName && !accountId && !email) return null
    return { loggedIn: true, displayName, email, accountId, raw: 'Legendary user.json' }
  } catch {
    return null
  }
}

function captureLegendaryCredentialFromBrowser(): Promise<{ kind: 'code' | 'token' | 'sid'; value: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const iconPath = resolveAppIconPath()
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      title: 'Epic Games Login',
      icon: iconPath,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    const finish = (err?: Error | null, credential?: { kind: 'code' | 'token' | 'sid'; value: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!win.isDestroyed()) win.close()
      if (err) reject(err)
      else if (credential) resolve(credential)
      else reject(new Error('Login Epic cancelado.'))
    }

    const inspectPage = async () => {
      if (settled || win.isDestroyed()) return
      const urlCredential = parseLegendaryCredentialUrl(win.webContents.getURL())
      if (urlCredential) {
        finish(null, urlCredential)
        return
      }

      try {
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)
        const textCredential = parseLegendaryCredentialInput(String(text || ''), false, true)
        if (textCredential) finish(null, textCredential)
      } catch {
        // ignore pages that block script execution during navigation
      }
    }

    const timeout = setTimeout(() => {
      finish(new Error('Tempo limite do login Epic atingido. Tente novamente.'))
    }, 5 * 60 * 1000)

    win.on('closed', () => {
      if (!settled) finish(new Error('Login Epic cancelado.'))
    })
    win.webContents.on('did-finish-load', inspectPage)
    win.webContents.on('did-navigate', () => setTimeout(inspectPage, 250))
    win.webContents.on('did-navigate-in-page', () => setTimeout(inspectPage, 250))
    win.webContents.on('did-fail-load', (_event, _code, description) => {
      if (!settled && description) console.warn('[Tools] Epic login load failed:', description)
    })

    win.loadURL(LEGENDARY_EPIC_LOGIN_URL).catch(err => finish(err))
  })
}

async function getLegendaryAuthInfo(): Promise<LegendaryAuthInfo> {
  const legendaryPath = await resolveLegendaryBinary()
  if (!legendaryPath) return { loggedIn: false, error: 'Legendary nao encontrado.' }

  const res = await runLegendary(['status', '--json'], { timeoutMs: 15_000 })
  if (!res.ok) {
    const fromFile = readLegendaryAuthFile()
    if (fromFile?.loggedIn) return fromFile
    const error = firstLine(res.stderr) || firstLine(res.stdout)
    return { loggedIn: false, error: error || 'Nao foi possivel ler o login da Epic.' }
  }
  const parsed = parseLegendaryAuthInfo(res.stdout, res.stderr)
  if (!parsed.loggedIn) {
    const fromFile = readLegendaryAuthFile()
    if (fromFile?.loggedIn) return fromFile
  }
  return parsed
}

function parseEosOverlayInfo(stdout: string, stderr = '', fallbackPath?: string | null): EosOverlayInfo {
  const text = `${stdout || ''}\n${stderr || ''}`.trim()
  const noManagedInstall = /no legendary-managed installation found/i.test(text)
  const version =
    /(?:installed|local|current)\s+version\s*[:=]\s*([^\r\n]+)/i.exec(text)?.[1]?.trim() ||
    /(?:version|build)\s*[:=]\s*([^\r\n]+)/i.exec(text)?.[1]?.trim()
  const availableVersion =
    /(?:available|remote|latest)\s+version\s*[:=]\s*([^\r\n]+)/i.exec(text)?.[1]?.trim()
  const installPath = /(?:path|install(?:ation)? path|folder)\s*[:=]\s*([^\r\n]+)/i.exec(text)?.[1]?.trim() || fallbackPath || undefined
  const valid = isEosOverlayPathValid(installPath) || isEosOverlayPathValid(fallbackPath)
  return {
    managed: !noManagedInstall && Boolean(text || valid),
    valid,
    version,
    availableVersion,
    installPath,
    raw: text || undefined
  }
}

function detectEosOverlayBinaryVersion(root?: string | null): string | undefined {
  const base = String(root || '').trim()
  if (!base || !fs.existsSync(base)) return undefined
  const candidates = [
    path.join(base, 'EOSOVH-Win64-Shipping.dll'),
    path.join(base, 'EOSOverlayRenderer-Win64-Shipping.exe'),
    path.join(base, 'EOSOVH-Win32-Shipping.dll'),
    path.join(base, 'EOSOverlayRenderer-Win32-Shipping.exe')
  ]

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue
      const text = fs.readFileSync(filePath).toString('latin1')
      const matches = text.match(/\b\d+\.\d+\.\d+\.\d+\b/g) || []
      const version = matches.find(value => {
        if (value === '127.0.0.1' || value === '6.0.0.0') return false
        if (/^0\.0\./.test(value)) return false
        return true
      })
      if (version) return version
    } catch {
      // ignore version extraction failures
    }
  }
  return undefined
}

async function getEosOverlayInfo(): Promise<EosOverlayInfo> {
  if (!isLinux()) return { managed: false, valid: false, error: 'EOS Overlay nao e necessario no Windows.' }

  const managedDir = managedEosOverlayDir()
  const detectedPath = findEosOverlayInstallPath(app.getPath('userData'))
  const valid = isEosOverlayPathValid(detectedPath)
  const legendaryPath = await resolveLegendaryBinary()
  if (!legendaryPath) {
    return { managed: false, valid, installPath: detectedPath || managedDir, error: 'Legendary nao encontrado.' }
  }

  const res = await runLegendary(['eos-overlay', 'info', '--path', managedDir], { timeoutMs: 20_000 })
  const parsed = parseEosOverlayInfo(res.stdout, res.stderr, detectedPath || managedDir)
  if (!res.ok) parsed.error = firstLine(res.stderr) || firstLine(res.stdout) || 'Falha ao consultar EOS Overlay.'
  parsed.valid = parsed.valid || valid
  if (!parsed.installPath && detectedPath) parsed.installPath = detectedPath
  if (!parsed.version) parsed.version = detectEosOverlayBinaryVersion(parsed.installPath || detectedPath)
  try {
    if (parsed.installPath && fs.existsSync(parsed.installPath)) parsed.installedAt = fs.statSync(parsed.installPath).mtimeMs
  } catch {
    // ignore
  }
  return parsed
}

function releaseCacheFile(tool: ManagedTool): string {
  return path.join(app.getPath('userData'), 'cache', 'tool-releases', `${tool}.json`)
}

function readReleaseCache(tool: ManagedTool): { releases: ReleaseInfo[]; fetchedAt?: string } | null {
  try {
    const filePath = releaseCacheFile(tool)
    if (!fs.existsSync(filePath)) return null
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(parsed?.releases)) return null
    return {
      releases: parsed.releases.filter((release: any) => release?.tag),
      fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : undefined
    }
  } catch {
    return null
  }
}

function writeReleaseCache(tool: ManagedTool, releases: ReleaseInfo[]) {
  try {
    const filePath = releaseCacheFile(tool)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: new Date().toISOString(), releases }, null, 2), 'utf8')
  } catch {
    // ignore cache write failures
  }
}

function isGithubRateLimitError(err: any): boolean {
  const message = String(err?.message || err || '')
  return /HTTP 403/i.test(message) && /rate limit/i.test(message)
}

function listInstalledProton(provider: ProtonProvider) {
  const root = managedProtonRoot(provider)
  const savedRuntime = getSavedProtonRuntime()
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    entries = []
  }

  return entries
    .filter(e => e.isDirectory())
    .map(e => {
      const runtimePath = path.join(root, e.name)
      const runner = path.join(runtimePath, 'proton')
      if (!fs.existsSync(runner)) return null
      const version = readTextIfExists(path.join(runtimePath, 'VERSION.txt')) || e.name
      let installedAt = 0
      try { installedAt = fs.statSync(runtimePath).mtimeMs } catch {}
      return {
        name: e.name,
        version,
        path: runtimePath,
        runner,
        installedAt,
        isDefault: !!savedRuntime && path.resolve(savedRuntime) === path.resolve(runtimePath)
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => (b.installedAt || 0) - (a.installedAt || 0))
}

function selectAsset(release: any, tool: ManagedTool): { name?: string; url?: string } {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const names = assets.map((asset: any) => ({
    name: String(asset?.name || ''),
    url: String(asset?.browser_download_url || '')
  })).filter((asset: any) => asset.name && asset.url)

  if (tool === 'proton-ge') {
    const asset = names.find((a: any) => /ge-proton.*\.tar\.gz$/i.test(a.name) && !/sha|sum|sig/i.test(a.name))
    return asset || {}
  }

  if (tool === 'proton-cachyos') {
    const asset = names
      .filter((a: any) => /proton-cachyos/i.test(a.name))
      .filter((a: any) => /\.(pkg\.)?tar\.(zst|xz|gz)$|\.tgz$/i.test(a.name))
      .filter((a: any) => !/sha|sum|sig|debug|src/i.test(a.name))
      .sort((a: any, b: any) => {
        const score = (name: string) => {
          const v = name.toLowerCase()
          let s = 0
          if (v.includes('x86_64')) s += 6
          if (!/x86_64_v[234]|znver|arm64|aarch64/.test(v)) s += 4
          if (!v.includes('slr')) s += 3
          return s
        }
        return score(b.name) - score(a.name)
      })[0]
    return asset || {}
  }

  if (tool === 'legendary') {
    const n = (value: string) => value.toLowerCase()
    const platform = process.platform
    const platformScore = (name: string) => {
      const v = n(name)
      if (platform === 'win32' && (v.includes('win') || v.endsWith('.exe'))) return 5
      if (platform === 'linux' && (v.includes('linux') || (!v.includes('win') && !v.includes('mac')))) return 5
      if (platform === 'darwin' && (v.includes('mac') || v.includes('darwin') || v.includes('osx'))) return 5
      return 0
    }
    return names
      .filter((a: any) => /legendary/i.test(a.name) || a.name.toLowerCase() === 'legendary')
      // A build for another architecture is not a candidate at all: scoring it
      // let legendary_linux_arm64 tie with legendary_linux_x64 and win on order.
      .filter((a: any) => assetRunsOnHost(a.name))
      .sort((a: any, b: any) =>
        (platformScore(b.name) + (assetNamesHostArch(b.name) ? 3 : 0)) -
        (platformScore(a.name) + (assetNamesHostArch(a.name) ? 3 : 0)))[0] || {}
  }

  if (tool === 'ludusavi') {
    const platformNeedle = process.platform === 'win32' ? /win|windows/i : process.platform === 'darwin' ? /mac|darwin|osx/i : /linux/i
    return names
      .filter((a: any) => /\.(zip|tar\.gz|tgz)$/i.test(a.name) && platformNeedle.test(a.name))
      .filter((a: any) => assetRunsOnHost(a.name))
      .sort((a: any, b: any) => Number(assetNamesHostArch(b.name)) - Number(assetNamesHostArch(a.name)))[0] || {}
  }

  return {}
}

async function fetchGithubReleases(tool: ManagedTool, limit = 12): Promise<ReleaseInfo[]> {
  if (tool === 'eos-overlay') return []
  const repo = tool === 'proton-ge'
    ? PROTON_GE_REPO
    : tool === 'proton-cachyos'
      ? PROTON_CACHYOS_REPO
      : tool === 'legendary'
        ? LEGENDARY_REPO
        : LUDUSAVI_REPO
  const releases = await httpJson(`https://api.github.com/repos/${repo}/releases?per_page=${Math.max(1, Math.min(30, limit))}`)
  if (!Array.isArray(releases)) return []
  return releases
    .filter((release: any) => !release?.draft)
    .map((release: any) => {
      const asset = selectAsset(release, tool)
      return {
        tag: String(release?.tag_name || ''),
        name: String(release?.name || release?.tag_name || ''),
        publishedAt: String(release?.published_at || ''),
        assetName: asset.name,
        downloadUrl: asset.url
      }
    })
    .filter((release: ReleaseInfo) => release.tag)
}

async function listGithubReleases(tool: ManagedTool, limit = 12, options?: { force?: boolean }): Promise<{ releases: ReleaseInfo[]; fromCache?: boolean; warning?: string }> {
  if (tool === 'eos-overlay') return { releases: [] }
  const cache = readReleaseCache(tool)
  const shouldRefresh = !!options?.force || !releaseRefreshAttempted.has(tool)

  if (!shouldRefresh && cache) {
    return { releases: cache.releases.slice(0, limit), fromCache: true }
  }

  releaseRefreshAttempted.add(tool)
  try {
    const releases = await fetchGithubReleases(tool, limit)
    writeReleaseCache(tool, releases)
    return { releases }
  } catch (err: any) {
    if (cache && isGithubRateLimitError(err)) {
      return { releases: cache.releases.slice(0, limit), fromCache: true, warning: 'GitHub rate limit atingido; usando cache local.' }
    }
    if (cache && !options?.force) {
      return { releases: cache.releases.slice(0, limit), fromCache: true, warning: err?.message || String(err) }
    }
    throw err
  }
}

function releaseVersionForInstaller(tool: ManagedTool, tag: string): string {
  const normalized = String(tag || '').trim()
  if (!normalized || normalized === 'latest') return 'latest'
  if (tool === 'ludusavi') return normalized.replace(/^v/i, '')
  return normalized.replace(/^v/i, '')
}

async function extractProtonArchive(archivePath: string, extractDir: string, timeoutMs: number) {
  const lower = archivePath.toLowerCase()
  const args = lower.endsWith('.tar.zst')
    ? ['--zstd', '-xf', archivePath, '-C', extractDir]
    : lower.endsWith('.tar.xz')
      ? ['-xJf', archivePath, '-C', extractDir]
      : ['-xzf', archivePath, '-C', extractDir]
  const extracted = await spawnCapture('tar', args, { timeoutMs })
  if (extracted.ok) return
  if (lower.endsWith('.tar.zst')) {
    const fallback = await spawnCapture('tar', ['-I', 'zstd', '-xf', archivePath, '-C', extractDir], { timeoutMs })
    if (fallback.ok) return
    throw new Error(fallback.stderr || fallback.stdout || extracted.stderr || extracted.stdout || 'Falha ao extrair runtime Proton.')
  }
  throw new Error(extracted.stderr || extracted.stdout || 'Falha ao extrair runtime Proton.')
}

async function installProtonRuntime(provider: ProtonProvider, version: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!isLinux()) return { success: false, error: 'Proton esta disponivel apenas no Linux.' }

  const listed = await listGithubReleases(provider, 20, { force: false })
  const releases = listed.releases
  const release = releases.find(r => r.tag === version || r.name === version) || releases[0]
  if (!release?.downloadUrl || !release.assetName) return { success: false, error: 'Release do Proton sem asset compativel.' }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `voidlauncher-${provider}-`))
  const archivePath = path.join(tmpRoot, release.assetName)
  const extractDir = path.join(tmpRoot, 'extract')

  try {
    await httpDownload(release.downloadUrl, archivePath, 240_000)
    fs.mkdirSync(extractDir, { recursive: true })
    await extractProtonArchive(archivePath, extractDir, 240_000)

    const stack = [extractDir]
    let protonDir: string | null = null
    while (stack.length && !protonDir) {
      const dir = stack.pop()!
      let entries: fs.Dirent[] = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      if (fs.existsSync(path.join(dir, 'proton'))) {
        protonDir = dir
        break
      }
      for (const entry of entries) {
        if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
      }
    }
    if (!protonDir) throw new Error('Archive do Proton nao contem script proton.')

    const destName = path.basename(protonDir)
    const destDir = path.join(managedProtonRoot(provider), destName)
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(destDir), { recursive: true })
    fs.cpSync(protonDir, destDir, { recursive: true })
    try { fs.chmodSync(path.join(destDir, 'proton'), 0o755) } catch {}
    fs.writeFileSync(path.join(destDir, 'VERSION.txt'), `${release.tag}\n`, 'utf8')
    setSavedProtonRuntime(destDir)
    return { success: true, path: destDir }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

async function getToolsStatus() {
  const legendaryPath = await resolveLegendaryBinary()
  const ludusaviPath = await resolveLudusaviBinary()
  const eosOverlayPath = isLinux() ? findEosOverlayInstallPath(app.getPath('userData')) : null

  return {
    platform: process.platform,
    isLinux: isLinux(),
    userData: app.getPath('userData'),
    protonGe: {
      root: managedProtonRoot('proton-ge'),
      installed: listInstalledProton('proton-ge'),
      defaultRuntime: getSavedProtonRuntime(),
      prefixRoot: getPrefixRootDir(),
      winetricks: isLinux() ? winetricksAvailable() : false
    },
    protonCachyos: {
      root: managedProtonRoot('proton-cachyos'),
      installed: listInstalledProton('proton-cachyos'),
      defaultRuntime: getSavedProtonRuntime(),
      prefixRoot: getPrefixRootDir(),
      winetricks: isLinux() ? winetricksAvailable() : false
    },
    tools: {
      legendary: {
        path: legendaryPath,
        version: await toolVersion('legendary', legendaryPath),
        managedVersion: readManagedVersion('legendary'),
        managedDir: managedToolDir('legendary'),
        auth: await getLegendaryAuthInfo()
      },
      ludusavi: {
        path: ludusaviPath,
        version: await toolVersion('ludusavi', ludusaviPath),
        managedVersion: readManagedVersion('ludusavi'),
        managedDir: managedToolDir('ludusavi')
      },
      eosOverlay: {
        path: eosOverlayPath,
        valid: isEosOverlayPathValid(eosOverlayPath),
        managedDir: managedEosOverlayDir(),
        info: await getEosOverlayInfo()
      }
    }
  }
}

async function installEosOverlay(): Promise<{ success: boolean; path?: string | null; error?: string }> {
  if (!isLinux()) return { success: false, error: 'EOS Overlay automatico esta disponivel apenas no Linux.' }

  const ensured = await ensureLegendaryAvailable({ allowDownload: true, timeoutMs: 120_000 })
  if (!ensured.ok) return { success: false, error: ensured.message || 'Legendary nao encontrado.' }

  const installPath = managedEosOverlayDir()
  fs.mkdirSync(installPath, { recursive: true })
  const res = await runLegendary(['-y', 'eos-overlay', 'install', '--path', installPath], { timeoutMs: 180_000 })
  if (!res.ok) return { success: false, error: firstLine(res.stderr) || firstLine(res.stdout) || 'Falha ao instalar EOS Overlay.' }

  const overlayPath = findEosOverlayInstallPath(app.getPath('userData'))
  if (!isEosOverlayPathValid(overlayPath)) {
    return { success: false, error: 'Legendary terminou, mas o EOS Overlay nao foi encontrado no destino.' }
  }
  return { success: true, path: overlayPath }
}

async function manageEosOverlay(action: 'info' | 'install' | 'update' | 'remove'): Promise<{ success: boolean; status?: any; info?: EosOverlayInfo; path?: string | null; error?: string }> {
  if (!isLinux()) return { success: false, error: 'EOS Overlay automatico esta disponivel apenas no Linux.' }

  if (action === 'info') {
    const info = await getEosOverlayInfo()
    return { success: true, info, status: await getToolsStatus() }
  }

  const ensured = await ensureLegendaryAvailable({ allowDownload: true, timeoutMs: 120_000 })
  if (!ensured.ok) return { success: false, error: ensured.message || 'Legendary nao encontrado.' }

  const installPath = managedEosOverlayDir()
  fs.mkdirSync(installPath, { recursive: true })
  const res = await runLegendary(['-y', 'eos-overlay', action, '--path', installPath], { timeoutMs: action === 'remove' ? 60_000 : 180_000 })
  if (!res.ok) {
    return { success: false, error: firstLine(res.stderr) || firstLine(res.stdout) || `Falha ao executar eos-overlay ${action}.` }
  }

  const overlayPath = findEosOverlayInstallPath(app.getPath('userData'))
  const info = await getEosOverlayInfo()
  return { success: true, info, path: overlayPath, status: await getToolsStatus() }
}

export const registerToolsHandlers: IpcHandlerRegistrar = (_ctx: IpcContext) => {
  ipcMain.handle('tools-status', async () => {
    try {
      return { success: true, status: await getToolsStatus() }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-list-releases', async (_event, payload?: { tool?: ManagedTool; limit?: number; force?: boolean }) => {
    try {
      const tool = String(payload?.tool || '').trim() as ManagedTool
      if (!['proton-ge', 'proton-cachyos', 'legendary', 'ludusavi', 'eos-overlay'].includes(tool)) {
        return { success: false, error: 'Ferramenta desconhecida.' }
      }
      const result = await listGithubReleases(tool, Number(payload?.limit) || 12, { force: !!payload?.force })
      return { success: true, ...result }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-install', async (_event, payload?: { tool?: ManagedTool; version?: string }) => {
    try {
      const tool = String(payload?.tool || '').trim() as ManagedTool
      const version = String(payload?.version || '').trim()

      if (tool === 'proton-ge' || tool === 'proton-cachyos') {
        const res = await installProtonRuntime(tool, version || 'latest')
        return res.success
          ? { success: true, path: res.path, status: await getToolsStatus() }
          : res
      }

      if (tool === 'legendary') {
        const res = await ensureLegendaryAvailable({
          allowDownload: true,
          forceDownload: true,
          version: releaseVersionForInstaller(tool, version || 'latest'),
          timeoutMs: 180_000
        })
        return res.ok
          ? { success: true, path: res.path, downloaded: res.downloaded, status: await getToolsStatus() }
          : { success: false, error: res.message || 'Falha ao instalar Legendary.' }
      }

      if (tool === 'ludusavi') {
        const res = await ensureLudusaviAvailable({
          allowDownload: true,
          forceDownload: true,
          version: releaseVersionForInstaller(tool, version || 'latest'),
          timeoutMs: 180_000
        })
        return res.ok
          ? { success: true, path: res.path, downloaded: res.downloaded, status: await getToolsStatus() }
          : { success: false, error: res.message || 'Falha ao instalar Ludusavi.' }
      }

      if (tool === 'eos-overlay') {
        const res = await installEosOverlay()
        return res.success
          ? { success: true, path: res.path, status: await getToolsStatus() }
          : res
      }

      return { success: false, error: 'Ferramenta desconhecida.' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-legendary-auth', async (_event, payload?: { action?: 'status' | 'login' | 'logout'; credential?: string }) => {
    try {
      const action = String(payload?.action || 'status').trim()

      if (action === 'status') {
        return { success: true, auth: await getLegendaryAuthInfo(), status: await getToolsStatus() }
      }

      const ensured = await ensureLegendaryAvailable({ allowDownload: true, timeoutMs: 120_000 })
      if (!ensured.ok) return { success: false, error: ensured.message || 'Legendary nao encontrado.' }

      if (action === 'logout') {
        const res = await runLegendary(['auth', '--delete'], { timeoutMs: 30_000 })
        if (!res.ok) return { success: false, error: firstLine(res.stderr) || firstLine(res.stdout) || 'Falha ao sair da Epic.' }
        return { success: true, auth: await getLegendaryAuthInfo(), status: await getToolsStatus() }
      }

      if (action === 'login') {
        const credential = parseLegendaryCredentialInput(String(payload?.credential || '')) || await captureLegendaryCredentialFromBrowser()
        const flag = credential.kind === 'token' ? '--token' : credential.kind === 'sid' ? '--sid' : '--code'
        const res = await runLegendary(['auth', flag, credential.value], { timeoutMs: 120_000 })
        if (!res.ok) return { success: false, error: firstLine(res.stderr) || firstLine(res.stdout) || 'Falha ao autenticar na Epic.' }
        return { success: true, auth: await getLegendaryAuthInfo(), status: await getToolsStatus() }
      }

      return { success: false, error: 'Acao de autenticacao desconhecida.' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-eos-overlay-action', async (_event, payload?: { action?: 'info' | 'install' | 'update' | 'remove' }) => {
    try {
      const action = String(payload?.action || 'info').trim() as 'info' | 'install' | 'update' | 'remove'
      if (!['info', 'install', 'update', 'remove'].includes(action)) {
        return { success: false, error: 'Acao do EOS Overlay desconhecida.' }
      }
      return await manageEosOverlay(action)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-set-proton-default', async (_event, runtimePath?: string) => {
    try {
      const value = String(runtimePath || '').trim()
      const roots = [managedProtonRoot('proton-ge'), managedProtonRoot('proton-cachyos')].map(root => path.resolve(root))
      if (value && !roots.some(root => path.resolve(value).startsWith(root))) {
        return { success: false, error: 'Apenas Proton gerenciado pelo launcher pode ser definido nesta aba.' }
      }
      setSavedProtonRuntime(value)
      return { success: true, status: await getToolsStatus() }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-remove-proton-ge', async (_event, runtimePath?: string) => {
    try {
      const value = String(runtimePath || '').trim()
      const roots = [managedProtonRoot('proton-ge'), managedProtonRoot('proton-cachyos')].map(root => path.resolve(root))
      if (!value || !roots.some(root => path.resolve(value).startsWith(root))) {
        return { success: false, error: 'Runtime invalido.' }
      }
      const saved = getSavedProtonRuntime()
      fs.rmSync(value, { recursive: true, force: true })
      if (saved && path.resolve(saved) === path.resolve(value)) setSavedProtonRuntime('')
      return { success: true, status: await getToolsStatus() }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('tools-open-terminal', async (_event, cwd?: string) => {
    try {
      const dir = String(cwd || '').trim() || app.getPath('userData')
      const candidates = process.platform === 'linux'
        ? [['xdg-terminal-exec', []], ['kgx', []], ['gnome-terminal', []], ['konsole', []], ['xterm', []]]
        : []
      for (const [cmd, args] of candidates as Array<[string, string[]]>) {
        try {
          const child = spawn(cmd, args, { cwd: dir, detached: true, stdio: 'ignore' })
          child.unref()
          return { success: true }
        } catch {}
      }
      return { success: false, error: 'Terminal nao encontrado.' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })
}
