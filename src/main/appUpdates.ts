import { app } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import https from 'https'
import path from 'path'

const DEFAULT_REPO = 'MrOz59/voidlauncher'
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

export type LauncherUpdateStatus = {
  currentVersion: string
  latestVersion?: string
  latestTag?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  canAutoUpdate?: boolean
  updatePackage?: 'appimage' | 'manual'
  appImageAsset?: {
    name: string
    downloadUrl: string
    size?: number
  }
  updateAvailable: boolean
  fromCache?: boolean
  checkedAt?: string
  error?: string
}

type CachedUpdateStatus = {
  checkedAt?: string
  status?: LauncherUpdateStatus
}

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'cache', 'launcher-update.json')
}

function appImagePath(): string | null {
  if (process.platform !== 'linux') return null
  const raw = String(process.env.APPIMAGE || '').trim()
  if (!raw || !/\.appimage$/i.test(raw)) return null
  try {
    const st = fs.statSync(raw)
    if (!st.isFile()) return null
    return raw
  } catch {
    return null
  }
}

function canWriteAppImageDir(filePath: string | null): boolean {
  if (!filePath) return false
  try {
    fs.accessSync(path.dirname(filePath), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function getAppImageAutoUpdateSupport(): boolean {
  const current = appImagePath()
  return Boolean(current && canWriteAppImageDir(current))
}

function normalizeVersion(value: string | undefined | null): string {
  return String(value || '').trim().replace(/^v/i, '')
}

type ParsedVersion = {
  parts: number[]
  prerelease: string[]
}

function readPackageVersion(filePath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const version = normalizeVersion(parsed?.version)
    return version && version !== '0.0.0' ? version : null
  } catch {
    return null
  }
}

export function getLauncherVersion(): string {
  const candidates = [
    path.join(app.getAppPath(), 'package.json'),
    path.join(process.cwd(), 'package.json'),
    path.join(__dirname, '..', '..', 'package.json')
  ]

  for (const candidate of candidates) {
    const version = readPackageVersion(candidate)
    if (version) return version
  }

  const electronVersion = normalizeVersion(app.getVersion())
  return electronVersion && electronVersion !== '0.0.0' ? electronVersion : '0.0.0'
}

function parseVersion(value: string): ParsedVersion {
  const [withoutBuild] = normalizeVersion(value).split('+')
  const [core, prereleaseRaw = ''] = withoutBuild.split('-', 2)
  const parts = core.split('.').map(part => {
    const n = Number.parseInt(part.replace(/\D.*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })

  return {
    parts,
    prerelease: prereleaseRaw ? prereleaseRaw.split('.').filter(Boolean) : []
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const left = a[i]
    const right = b[i]
    if (left == null) return -1
    if (right == null) return 1

    const leftNum = /^\d+$/.test(left) ? Number.parseInt(left, 10) : null
    const rightNum = /^\d+$/.test(right) ? Number.parseInt(right, 10) : null

    if (leftNum != null && rightNum != null) {
      if (leftNum > rightNum) return 1
      if (leftNum < rightNum) return -1
      continue
    }

    if (leftNum != null) return -1
    if (rightNum != null) return 1

    const cmp = left.localeCompare(right)
    if (cmp > 0) return 1
    if (cmp < 0) return -1
  }

  return 0
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const len = Math.max(left.parts.length, right.parts.length, 3)

  for (let i = 0; i < len; i++) {
    const x = left.parts[i] || 0
    const y = right.parts[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }

  return comparePrerelease(left.prerelease, right.prerelease)
}

function httpGetJson(url: string, timeoutMs = 12_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': `VoidLauncher/${getLauncherVersion()}`
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGetJson(res.headers.location, timeoutMs).then(resolve, reject)
          return
        }

        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (data += chunk))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(err)
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Tempo esgotado ao verificar atualização.'))
    })
    req.on('error', reject)
    req.end()
  })
}

function httpDownload(url: string, destFile: string, timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': `VoidLauncher/${getLauncherVersion()}`
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpDownload(res.headers.location, destFile, timeoutMs).then(resolve, reject)
          return
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`download failed: HTTP ${res.statusCode}`))
          return
        }

        const out = fs.createWriteStream(destFile)
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
        out.on('error', reject)
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Tempo esgotado ao baixar atualização.'))
    })
    req.on('error', reject)
    req.end()
  })
}

function readCache(): CachedUpdateStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.status || typeof parsed.status !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(status: LauncherUpdateStatus) {
  try {
    const filePath = cacheFile()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ checkedAt: status.checkedAt, status }, null, 2), 'utf8')
  } catch (err: any) {
    console.warn('[updates] Failed to write launcher update cache:', err?.message || err)
  }
}

function cachedStatusIsFresh(cache: CachedUpdateStatus | null): boolean {
  const checkedAt = cache?.checkedAt || cache?.status?.checkedAt
  if (!checkedAt) return false
  const t = Date.parse(checkedAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < CACHE_MAX_AGE_MS
}

function selectAppImageAsset(release: any): LauncherUpdateStatus['appImageAsset'] {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const candidates = assets
    .map((asset: any) => ({
      name: String(asset?.name || ''),
      downloadUrl: String(asset?.browser_download_url || ''),
      size: Number(asset?.size || 0)
    }))
    .filter((asset: any) => /\.appimage$/i.test(asset.name) && asset.downloadUrl)
    .sort((a: any, b: any) => {
      const ax64 = /x64|x86_64|amd64/i.test(a.name) ? 1 : 0
      const bx64 = /x64|x86_64|amd64/i.test(b.name) ? 1 : 0
      if (ax64 !== bx64) return bx64 - ax64
      return (b.size || 0) - (a.size || 0)
    })

  return candidates[0] || undefined
}

function statusFromRelease(release: any): LauncherUpdateStatus {
  const currentVersion = getLauncherVersion()
  const latestTag = String(release?.tag_name || '').trim()
  const latestVersion = normalizeVersion(latestTag)
  const releaseUrl = String(release?.html_url || '').trim() || (latestTag ? `https://github.com/${DEFAULT_REPO}/releases/tag/${latestTag}` : `https://github.com/${DEFAULT_REPO}/releases`)
  const appImageAsset = selectAppImageAsset(release)
  const canAutoUpdate = Boolean(appImageAsset && getAppImageAutoUpdateSupport())

  return {
    currentVersion,
    latestVersion,
    latestTag,
    releaseName: String(release?.name || latestTag || '').trim(),
    releaseUrl,
    publishedAt: String(release?.published_at || '').trim(),
    canAutoUpdate,
    updatePackage: canAutoUpdate ? 'appimage' : 'manual',
    appImageAsset,
    updateAvailable: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0,
    checkedAt: new Date().toISOString()
  }
}

function withRuntimeSupport(status: LauncherUpdateStatus): LauncherUpdateStatus {
  const canAutoUpdate = Boolean(status.appImageAsset && getAppImageAutoUpdateSupport())
  return {
    ...status,
    canAutoUpdate,
    updatePackage: canAutoUpdate ? 'appimage' : 'manual'
  }
}

export async function checkLauncherUpdate(options?: { force?: boolean }): Promise<LauncherUpdateStatus> {
  const currentVersion = getLauncherVersion()
  const cache = readCache()
  const cachedLatestVersion = cache?.status?.latestVersion || ''

  if (!options?.force && cachedStatusIsFresh(cache) && cache?.status) {
    return withRuntimeSupport({
      ...cache.status,
      currentVersion,
      updateAvailable: Boolean(cachedLatestVersion) && compareVersions(cachedLatestVersion, currentVersion) > 0,
      fromCache: true
    })
  }

  const repo = String(process.env.VOIDLAUNCHER_UPDATE_REPO || DEFAULT_REPO).trim() || DEFAULT_REPO
  const url = `https://api.github.com/repos/${repo}/releases/latest`

  try {
    const release = await httpGetJson(url)
    const status = statusFromRelease(release)
    writeCache(status)
    return status
  } catch (err: any) {
    if (cache?.status) {
      return withRuntimeSupport({
        ...cache.status,
        currentVersion,
        updateAvailable: Boolean(cachedLatestVersion) && compareVersions(cachedLatestVersion, currentVersion) > 0,
        fromCache: true,
        error: err?.message || String(err)
      })
    }

    return {
      currentVersion,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      error: err?.message || String(err)
    }
  }
}

function assertAppImageFile(filePath: string) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const magic = Buffer.alloc(4)
    fs.readSync(fd, magic, 0, 4, 0)
    if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) {
      throw new Error('Arquivo baixado não parece ser um AppImage válido.')
    }
  } finally {
    fs.closeSync(fd)
  }
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function writeAppImageSwapScript(options: {
  scriptPath: string
  currentPath: string
  downloadPath: string
  backupPath: string
  pid: number
}) {
  const script = `#!/usr/bin/env sh
set -eu

pid=${options.pid}
current=${shellQuote(options.currentPath)}
download=${shellQuote(options.downloadPath)}
backup=${shellQuote(options.backupPath)}

i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 200 ]; then
    exit 1
  fi
  sleep 0.1
done

sleep 0.5

if [ ! -f "$download" ]; then
  exit 1
fi

chmod 755 "$download"

if [ -f "$current" ]; then
  mv -f "$current" "$backup"
fi

if ! mv -f "$download" "$current"; then
  if [ -f "$backup" ] && [ ! -f "$current" ]; then
    mv -f "$backup" "$current"
    chmod 755 "$current" || true
  fi
  exit 1
fi

chmod 755 "$current"
nohup "$current" >/dev/null 2>&1 &
`

  fs.writeFileSync(options.scriptPath, script, 'utf8')
  fs.chmodSync(options.scriptPath, 0o755)
}

export async function installAppImageUpdate(): Promise<{ success: boolean; message?: string; error?: string }> {
  const currentPath = appImagePath()
  if (!currentPath) return { success: false, error: 'Auto atualização só está disponível quando o launcher roda como AppImage.' }
  if (!canWriteAppImageDir(currentPath)) return { success: false, error: 'A pasta do AppImage atual não permite escrita.' }

  const status = await checkLauncherUpdate({ force: true })
  if (!status.updateAvailable) return { success: false, error: 'Nenhuma atualização disponível.' }
  if (!status.appImageAsset?.downloadUrl) return { success: false, error: 'A release mais recente não possui AppImage compatível.' }

  const dir = path.dirname(currentPath)
  const base = path.basename(currentPath)
  const stamp = `${Date.now()}-${process.pid}`
  const updateDir = path.join(app.getPath('userData'), 'updates')
  const downloadPath = path.join(updateDir, `${base}.${stamp}.download`)
  const scriptPath = path.join(updateDir, `apply-appimage-update-${stamp}.sh`)
  const backupPath = path.join(dir, `.${base}.${stamp}.old`)

  try {
    fs.mkdirSync(updateDir, { recursive: true })
    await httpDownload(status.appImageAsset.downloadUrl, downloadPath)

    const stat = fs.statSync(downloadPath)
    if (status.appImageAsset.size && stat.size !== status.appImageAsset.size) {
      throw new Error('O tamanho do AppImage baixado não confere com o asset da release.')
    }
    if (stat.size < 1024 * 1024) {
      throw new Error('O AppImage baixado é menor que o esperado.')
    }

    assertAppImageFile(downloadPath)
    fs.chmodSync(downloadPath, 0o755)
    writeAppImageSwapScript({
      scriptPath,
      currentPath,
      downloadPath,
      backupPath,
      pid: process.pid
    })

    try {
      const child = spawn('/bin/sh', [scriptPath], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
    } catch (err: any) {
      throw new Error(`Falha ao iniciar aplicador da atualização: ${err?.message || String(err)}`)
    }

    setTimeout(() => app.exit(0), 250)
    return { success: true, message: 'Atualização instalada. Reiniciando o launcher...' }
  } catch (err: any) {
    try {
      if (fs.existsSync(downloadPath)) fs.rmSync(downloadPath, { force: true })
    } catch {}
    try {
      if (fs.existsSync(scriptPath)) fs.rmSync(scriptPath, { force: true })
    } catch {}

    return { success: false, error: err?.message || String(err) }
  }
}
