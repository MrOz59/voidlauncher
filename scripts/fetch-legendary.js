#!/usr/bin/env node
/*
 * Fetch Legendary binary from GitHub releases.
 * Layout:
 *   vendor/legendary/<platform>-<arch>/legendary(.exe)
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const { spawnSync } = require('child_process')

const REPO = String(process.env.LEGENDARY_REPO || 'legendary-gl/legendary')
const VERSION = String(process.env.LEGENDARY_VERSION || 'latest').replace(/^v/, '')
const TIMEOUT_MS = Number(process.env.LEGENDARY_TIMEOUT_MS || 120000)
const GITHUB_TOKEN = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()

function githubApiHeaders(url) {
  const isGitHubApi = new URL(url).hostname === 'api.github.com'
  return {
    'User-Agent': 'voidlauncher-legendary-fetch',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(GITHUB_TOKEN && isGitHubApi ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
  }
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: githubApiHeaders(url)
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpGetJson(res.headers.location, timeoutMs).then(resolve, reject)
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
      } catch {}
    })
    req.end()
  })
}

function httpDownload(url, destFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'voidlauncher-legendary-fetch'
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
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error('timeout'))
      } catch {}
    })
    req.end()
  })
}

async function normalizeReleaseAssets(release, timeoutMs) {
  let assets = Array.isArray(release && release.assets) ? release.assets : []
  if (!assets.length && release && release.assets_url) {
    try {
      const fromUrl = await httpGetJson(String(release.assets_url), timeoutMs)
      if (Array.isArray(fromUrl)) assets = fromUrl
    } catch {}
  }
  return assets
}

function mkdirp(p) {
  try {
    fs.mkdirSync(p, { recursive: true })
  } catch {}
}

function rimraf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}

function extractArchive(archivePath, extractDir) {
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract tar')
    return
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    const r = spawnSync('tar', ['-xJf', archivePath, '-C', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract tar.xz')
    return
  }
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    const r = spawnSync('tar', ['-xjf', archivePath, '-C', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract tar.bz2')
    return
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
      const r = spawnSync('powershell', ps, { stdio: 'inherit' })
      if (r.status !== 0) throw new Error('failed to extract zip')
      return
    }
    const r = spawnSync('unzip', ['-o', archivePath, '-d', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract zip')
    return
  }
  throw new Error(`unsupported archive type: ${path.basename(archivePath)}`)
}

function findFileRecursive(root, predicate, maxFiles = 5000) {
  const stack = [root]
  let seen = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
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

/**
 * Mirrors src/main/utils/releaseAssets.ts, which this script cannot import: it
 * runs before the TypeScript build. ARM is tested first because `aarch64` ends
 * in "64", and nothing matches a bare "64" — that is what let an arm build pass
 * for an x86 one in the launcher.
 */
function declaredArch(name) {
  if (/(?:^|[^a-z0-9])(arm64|aarch64|armv8)(?:[^a-z0-9]|$)/i.test(name)) return 'arm64'
  if (/(?:^|[^a-z0-9])(x86[-_]?64|amd64|x64|win64|linux64)(?:[^a-z0-9]|$)/i.test(name)) return 'x64'
  return null
}

function hostArchFamily(arch) {
  return arch === 'arm64' || arch === 'arm' ? 'arm64' : 'x64'
}

function selectLegendaryAsset(assets, platform, arch) {
  const family = hostArchFamily(arch)

  const candidates = assets
    .filter(a => a && a.name)
    .map(a => ({ asset: a, name: String(a.name).toLowerCase() }))
    .filter(c => !c.name.startsWith('source code'))
    // A build for another architecture is never a candidate: bundling one would
    // ship a binary that cannot run, instead of failing here where it is seen.
    .filter(c => declaredArch(c.name) === null || declaredArch(c.name) === family)

  if (!candidates.length) return null

  const isWin = (n) => n.includes('windows') || n.includes('win') || n.endsWith('.exe') || n.endsWith('.msi')
  const isMac = (n) => n.includes('mac') || n.includes('osx') || n.includes('darwin')
  const isLinux = (n) => n.includes('linux')
  const isArchive = (n) => n.endsWith('.zip') || n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.tar.xz') || n.endsWith('.txz') || n.endsWith('.tar.bz2') || n.endsWith('.tbz2')
  const isAppImage = (n) => n.endsWith('.appimage')

  const platformMatches = candidates.filter(c => {
    if (platform === 'win32') return isWin(c.name)
    if (platform === 'darwin') return isMac(c.name)
    return isLinux(c.name) || (!isWin(c.name) && !isMac(c.name) && (c.name === 'legendary' || c.name.startsWith('legendary-') || c.name.startsWith('legendary_')))
  })

  const pool = platformMatches.length ? platformMatches : candidates

  const score = (n) => {
    let s = 0
    if (platform === 'linux' && isLinux(n)) s += 6
    if (platform === 'darwin' && isMac(n)) s += 6
    if (platform === 'win32' && isWin(n)) s += 6
    if (declaredArch(n) === family) s += 3
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

  return pool[0] ? pool[0].asset : null
}

async function main() {
  const platform = process.platform
  const arch = process.arch
  const folder = `${platform}-${arch}`
  const exe = platform === 'win32' ? 'legendary.exe' : 'legendary'

  const outDir = path.join(process.cwd(), 'vendor', 'legendary', folder)
  const destExe = path.join(outDir, exe)
  if (fs.existsSync(destExe)) {
    console.log('[legendary] Already present at:', destExe)
    return
  }

  const releaseUrl = VERSION === 'latest'
    ? `https://api.github.com/repos/${REPO}/releases/latest`
    : `https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}`

  let release = await httpGetJson(releaseUrl, TIMEOUT_MS)
  let assets = await normalizeReleaseAssets(release, TIMEOUT_MS)
  if (!assets.length && VERSION === 'latest') {
    try {
      const listUrl = `https://api.github.com/repos/${REPO}/releases?per_page=8`
      const releases = await httpGetJson(listUrl, TIMEOUT_MS)
      if (Array.isArray(releases)) {
        for (const r of releases) {
          const ra = await normalizeReleaseAssets(r, TIMEOUT_MS)
          if (ra.length) {
            release = r
            assets = ra
            break
          }
        }
      }
    } catch {}
  }
  const asset = selectLegendaryAsset(assets, platform, arch)
  if (!asset || !asset.browser_download_url || !asset.name) {
    const names = assets.map(a => String((a && a.name) || '')).filter(Boolean)
    const preview = names.slice(0, 8).join(', ')
    const suffix = names.length > 8 ? '…' : ''
    const extra = names.length ? ` Assets: ${preview}${suffix}` : ''
    throw new Error(`No Legendary asset found for ${folder}.${extra}`)
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voidlauncher-legendary-'))
  const archivePath = path.join(tmpRoot, String(asset.name))
  const extractDir = path.join(tmpRoot, 'extract')

  try {
    console.log('[legendary] Downloading:', asset.name)
    await httpDownload(String(asset.browser_download_url), archivePath, TIMEOUT_MS)

    const lower = String(asset.name).toLowerCase()
    let found = null
    if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
      extractArchive(archivePath, extractDir)
      found = findFileRecursive(extractDir, (p) => path.basename(p).toLowerCase() === exe)
      if (!found && platform !== 'win32') {
        found = findFileRecursive(extractDir, (p) => path.basename(p).toLowerCase() === 'legendary')
      }
    } else {
      found = archivePath
    }

    if (!found) throw new Error(`Archive does not contain ${exe}`)

    rimraf(outDir)
    mkdirp(outDir)
    fs.copyFileSync(found, destExe)
    if (platform !== 'win32') {
      try { fs.chmodSync(destExe, 0o755) } catch {}
    }
    fs.writeFileSync(path.join(outDir, 'VERSION.txt'), String(release.tag_name || VERSION) + '\n', 'utf8')
    console.log('[legendary] ✓ Installed to:', destExe)
  } finally {
    rimraf(tmpRoot)
  }
}

main().catch((err) => {
  console.error('[legendary] ERROR:', err && err.stack ? err.stack : String(err))
  process.exit(1)
})
