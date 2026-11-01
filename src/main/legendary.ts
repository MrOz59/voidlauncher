import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import https from 'https'
import os from 'os'
import { assetNamesHostArch, assetRunsOnHost } from './utils/releaseAssets'

/**
 * Keep runtime support separate from the platform discriminant so TypeScript
 * still typechecks cross-platform asset extraction below the guard.
 */
function legendaryEnabledOnHost(): boolean {
  return process.platform !== 'win32'
}

export type LegendaryExecResult = {
  ok: boolean
  code?: number | null
  stdout: string
  stderr: string
}

function spawnAndCapture(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<LegendaryExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }, opts.timeoutMs)
      : null

    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8')
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8')
    })

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      resolve({ ok: code === 0, code, stdout, stderr })
    })

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(err) })
    })
  })
}

function tryResolveBinaryFromEnv(): string | null {
  const raw = String(process.env.LEGENDARY_PATH || '').trim()
  if (!raw) return null
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME || '', raw.slice(1)) : raw
  if (fs.existsSync(expanded)) return expanded
  return raw
}

function tryResolveBundledBinary(): string | null {
  const folder = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'legendary.exe' : 'legendary'

  // Downloaded at runtime: userData/tools/legendary/<platform>-<arch>/legendary(.exe)
  // Prefer this over the bundled copy so the launcher can update tools without
  // replacing the app package.
  try {
    const candidate = path.join(app.getPath('userData'), 'tools', 'legendary', folder, exe)
    if (fs.existsSync(candidate)) return candidate
  } catch {
    // ignore
  }

  // Packaged app: bundled under resources/legendary/<platform>-<arch>/legendary(.exe)
  if (app?.isPackaged && process.resourcesPath) {
    const candidate = path.join(process.resourcesPath, 'legendary', folder, exe)
    if (fs.existsSync(candidate)) return candidate
  }

  // Dev: allow a vendored binary downloaded by scripts/fetch-legendary.js
  try {
    const candidate = path.join(process.cwd(), 'vendor', 'legendary', folder, exe)
    if (fs.existsSync(candidate)) return candidate
  } catch {
    // ignore
  }

  return null
}

function httpGetJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'voidlauncher-legendary'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGetJson(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject)
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error('timeout'))
      } catch {
        // ignore
      }
    })
    req.end()
  })
}

function httpDownload(url: string, destFile: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'voidlauncher-legendary'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpDownload(new URL(res.headers.location, url).toString(), destFile, timeoutMs).then(resolve, reject)
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
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error('timeout'))
      } catch {
        // ignore
      }
    })
    req.end()
  })
}

async function normalizeReleaseAssets(release: any, timeoutMs: number): Promise<any[]> {
  let assets: any[] = Array.isArray(release?.assets) ? release.assets : []
  if (!assets.length && release?.assets_url) {
    try {
      const fromUrl = await httpGetJson(String(release.assets_url), timeoutMs)
      if (Array.isArray(fromUrl)) assets = fromUrl
    } catch {
      // ignore
    }
  }
  return assets
}

function mkdirp(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {
    // ignore
  }
}

function rimraf(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function findFileRecursive(root: string, predicate: (p: string) => boolean, maxFiles = 5000): string | null {
  const stack = [root]
  let seen = 0

  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        stack.push(p)
      } else if (ent.isFile()) {
        seen++
        if (predicate(p)) return p
        if (seen > maxFiles) return null
      }
    }
  }
  return null
}

function extractArchive(archivePath: string, extractDir: string, timeoutMs: number): Promise<void> {
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return spawnAndCapture('tar', ['-xzf', archivePath, '-C', extractDir], { timeoutMs }).then((r) => {
      if (!r.ok) throw new Error(r.stderr || r.stdout || 'failed to extract tar')
    })
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    return spawnAndCapture('tar', ['-xJf', archivePath, '-C', extractDir], { timeoutMs }).then((r) => {
      if (!r.ok) throw new Error(r.stderr || r.stdout || 'failed to extract tar.xz')
    })
  }
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    return spawnAndCapture('tar', ['-xjf', archivePath, '-C', extractDir], { timeoutMs }).then((r) => {
      if (!r.ok) throw new Error(r.stderr || r.stdout || 'failed to extract tar.bz2')
    })
  }
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const ps = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ]
      return spawnAndCapture('powershell', ps, { timeoutMs }).then((r) => {
        if (!r.ok) throw new Error(r.stderr || r.stdout || 'failed to extract zip')
      })
    }
    return spawnAndCapture('unzip', ['-o', archivePath, '-d', extractDir], { timeoutMs }).then((r) => {
      if (!r.ok) throw new Error(r.stderr || r.stdout || 'failed to extract zip')
    })
  }
  throw new Error(`unsupported archive type: ${path.basename(archivePath)}`)
}

function selectLegendaryAsset(assets: any[], platform: NodeJS.Platform, arch: string): any | null {
  const candidates = assets
    .filter(a => a?.name)
    .map(a => ({ asset: a, name: String(a.name).toLowerCase() }))
    .filter(c => !c.name.startsWith('source code'))
    // Scoring alone would still rank a foreign build above nothing, and a
    // release that ships only arm64 would install a binary that cannot run.
    .filter(c => assetRunsOnHost(c.name, arch))

  if (!candidates.length) return null

  const isWin = (n: string) => n.includes('windows') || n.includes('win') || n.endsWith('.exe') || n.endsWith('.msi')
  const isMac = (n: string) => n.includes('mac') || n.includes('osx') || n.includes('darwin')
  const isLinux = (n: string) => n.includes('linux')
  const isArchive = (n: string) =>
    n.endsWith('.zip') || n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.tar.xz') || n.endsWith('.txz') || n.endsWith('.tar.bz2') || n.endsWith('.tbz2')
  const isAppImage = (n: string) => n.endsWith('.appimage')

  const platformMatches = candidates.filter(c => {
    if (platform === 'win32') return isWin(c.name)
    if (platform === 'darwin') return isMac(c.name)
    // linux: allow explicit linux OR generic "legendary" binary without platform suffix
    return isLinux(c.name) || (!isWin(c.name) && !isMac(c.name) && (c.name === 'legendary' || c.name.startsWith('legendary-') || c.name.startsWith('legendary_')))
  })

  const pool = platformMatches.length ? platformMatches : candidates

  const score = (n: string) => {
    let s = 0
    if (platform === 'linux' && isLinux(n)) s += 6
    if (platform === 'darwin' && isMac(n)) s += 6
    if (platform === 'win32' && isWin(n)) s += 6
    if (assetNamesHostArch(n, arch)) s += 3
    if (n === 'legendary' || n.startsWith('legendary-') || n.startsWith('legendary_')) s += 2
    if (isArchive(n)) s += 1
    if (isAppImage(n)) s += 1
    if (n.endsWith('.exe')) s += 1
    return s
  }

  pool.sort((a, b) => {
    const sa = score(a.name)
    const sb = score(b.name)
    if (sa !== sb) return sb - sa
    return a.name.length - b.name.length
  })

  return pool[0]?.asset || null
}

async function resolveFromPath(): Promise<string | null> {
  const candidates = process.platform === 'win32' ? ['legendary.exe', 'legendary'] : ['legendary']
  for (const bin of candidates) {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const res = await spawnAndCapture(probe, [bin], { timeoutMs: 2000 })
    if (res.ok) {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      if (first) return first
      return bin
    }
  }
  return null
}

export async function resolveLegendaryBinary(): Promise<string | null> {
  // Do not use previously downloaded or system Legendary binaries on Windows.
  // Epic's native launcher handles authentication and running Epic games.
  if (!legendaryEnabledOnHost()) return null
  const env = tryResolveBinaryFromEnv()
  if (env) return env

  const bundled = tryResolveBundledBinary()
  if (bundled) return bundled

  return await resolveFromPath()
}

export async function ensureLegendaryAvailable(options?: {
  version?: string
  repo?: string
  timeoutMs?: number
  allowDownload?: boolean
  forceDownload?: boolean
}): Promise<{ ok: boolean; path?: string; message?: string; downloaded?: boolean }> {
  if (!legendaryEnabledOnHost()) {
    return { ok: false, message: 'Legendary não é necessário no Windows. Use o Epic Games Launcher nativo.' }
  }
  if (!process.versions?.electron) {
    return { ok: false, message: 'Auto-download do Legendary requer runtime do Electron.' }
  }

  const already = options?.forceDownload ? null : await resolveLegendaryBinary()
  if (already) return { ok: true, path: already, downloaded: false }

  if (options?.allowDownload === false) {
    return { ok: false, message: 'Legendary não encontrado e auto-download desativado.' }
  }

  const repo = String(options?.repo || process.env.LEGENDARY_REPO || 'legendary-gl/legendary')
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? (options!.timeoutMs as number) : 60_000
  const version = String(options?.version || process.env.LEGENDARY_VERSION || 'latest').replace(/^v/, '')

  const folder = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'legendary.exe' : 'legendary'
  const outDir = path.join(app.getPath('userData'), 'tools', 'legendary', folder)
  const destExe = path.join(outDir, exe)
  if (options?.forceDownload) rimraf(outDir)
  if (fs.existsSync(destExe)) return { ok: true, path: destExe, downloaded: false }

  const releaseUrl = version === 'latest'
    ? `https://api.github.com/repos/${repo}/releases/latest`
    : `https://api.github.com/repos/${repo}/releases/tags/${version}`
  let release: any
  try {
    release = await httpGetJson(releaseUrl, timeoutMs)
  } catch (err) {
    if (version === 'latest' || /^v/i.test(version)) throw err
    release = await httpGetJson(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, timeoutMs)
  }
  let assets = await normalizeReleaseAssets(release, timeoutMs)
  if (!assets.length && version === 'latest') {
    try {
      const listUrl = `https://api.github.com/repos/${repo}/releases?per_page=8`
      const releases = await httpGetJson(listUrl, timeoutMs)
      if (Array.isArray(releases)) {
        for (const r of releases) {
          const ra = await normalizeReleaseAssets(r, timeoutMs)
          if (ra.length) {
            release = r
            assets = ra
            break
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const asset = selectLegendaryAsset(assets, process.platform, process.arch)
  if (!asset?.browser_download_url || !asset?.name) {
    const names = assets.map((a: any) => String(a?.name || '')).filter(Boolean)
    const preview = names.slice(0, 8).join(', ')
    const suffix = names.length > 8 ? '…' : ''
    const extra = names.length ? ` Assets: ${preview}${suffix}` : ''
    return { ok: false, message: `Não foi possível encontrar asset do Legendary para ${folder} (${version}).${extra}` }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voidlauncher-legendary-'))
  const archivePath = path.join(tmpRoot, String(asset.name))
  const extractDir = path.join(tmpRoot, 'extract')

  try {
    await httpDownload(String(asset.browser_download_url), archivePath, timeoutMs)

    const lower = String(asset.name).toLowerCase()
    let found: string | null = null
    if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
      await extractArchive(archivePath, extractDir, timeoutMs)
      found = findFileRecursive(extractDir, (p) => path.basename(p).toLowerCase() === exe)
      if (!found && process.platform !== 'win32') {
        found = findFileRecursive(extractDir, (p) => path.basename(p).toLowerCase() === 'legendary')
      }
    } else {
      found = archivePath
    }

    if (!found) return { ok: false, message: `Archive do Legendary não contém ${exe}.` }

    rimraf(outDir)
    mkdirp(outDir)
    fs.copyFileSync(found, destExe)
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(destExe, 0o755)
      } catch {
        // ignore
      }
    }
    fs.writeFileSync(path.join(outDir, 'VERSION.txt'), String(release?.tag_name || version || 'unknown') + '\n', 'utf8')

    return { ok: true, path: destExe, downloaded: true }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) }
  } finally {
    rimraf(tmpRoot)
  }
}

export async function runLegendary(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<LegendaryExecResult> {
  if (!legendaryEnabledOnHost()) {
    return { ok: false, code: null, stdout: '', stderr: 'Legendary desativado no Windows (use o Epic Games Launcher).' }
  }
  const bin = await resolveLegendaryBinary()
  if (!bin) {
    return { ok: false, code: null, stdout: '', stderr: 'Legendary não encontrado no PATH (instale `legendary` ou defina LEGENDARY_PATH).' }
  }
  return await spawnAndCapture(bin, args, opts)
}
