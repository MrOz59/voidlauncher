/*
  Fetch Ludusavi release asset for the current platform/arch and place the CLI
  binary under:

    vendor/ludusavi/<platform>-<arch>/ludusavi(.exe)

  Why:
  - We want to bundle Ludusavi with the Electron app (extraResources)
  - Keep the repo lean (no binaries committed)

  Environment:
  - LUDUSAVI_VERSION: defaults to 0.30.0
  - LUDUSAVI_REPO: defaults to mtkennerly/ludusavi

  Requirements:
  - `tar` must exist for .tar.gz assets
  - `unzip` must exist for .zip assets
*/

const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const { spawnSync } = require('child_process')

const VERSION = (process.env.LUDUSAVI_VERSION || '0.30.0').replace(/^v/, '')
const REPO = String(process.env.LUDUSAVI_REPO || 'mtkennerly/ludusavi')
const GITHUB_TOKEN = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()

function githubApiHeaders(url) {
  const isGitHubApi = new URL(url).hostname === 'api.github.com'
  return {
    'User-Agent': 'voidlauncher-fetch-ludusavi',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(GITHUB_TOKEN && isGitHubApi ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true })
}

function rimraf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: githubApiHeaders(url)
      },
      (res) => {
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
    req.end()
  })
}

function httpDownload(url, destFile) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'voidlauncher-fetch-ludusavi'
        }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpDownload(res.headers.location, destFile).then(resolve, reject)
          return
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`download failed: HTTP ${res.statusCode}`))
          return
        }
        const out = fs.createWriteStream(destFile)
        res.pipe(out)
        out.on('finish', () => out.close(resolve))
        out.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
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

function ensureToolExists(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' })
  return r.status === 0
}

function selectAsset(assets, { platform, arch }) {
  const name = (a) => String(a?.name || '').toLowerCase()

  const platformNeedles =
    platform === 'win32'
      ? ['windows', 'win']
      : platform === 'darwin'
        ? ['macos', 'mac', 'osx']
        : ['linux']

  const archNeedles =
    arch === 'x64'
      ? ['x86_64', 'x64', 'amd64', 'win64', 'win-x64']
      : arch === 'arm64'
        ? ['aarch64', 'arm64']
        : [arch]

  const isArchive = (n) => n.endsWith('.zip') || n.endsWith('.tar.gz') || n.endsWith('.tgz')

  const scored = assets
    .filter((a) => isArchive(name(a)))
    .map((a) => {
      const n = name(a)
      let score = 0

      const hasPlatform = platformNeedles.some((p) => n.includes(p))
      const hasArch = archNeedles.some((r) => n.includes(r))

      if (hasPlatform) score += 10
      if (hasArch) score += 10

      // Ludusavi Linux asset sometimes omits arch (e.g. "...-linux.tar.gz").
      // Treat that as x64 unless it explicitly mentions ARM.
      if (!hasArch && platform === 'linux' && arch === 'x64' && hasPlatform) {
        const looksArm = n.includes('arm') || n.includes('aarch64')
        if (!looksArm) score += 10
      }

      // Ludusavi Windows assets use names like "...-win64.zip".
      if (!hasArch && platform === 'win32' && arch === 'x64' && hasPlatform) {
        const looksArm = n.includes('arm') || n.includes('aarch64')
        const looks64 = n.includes('64')
        if (looks64 && !looksArm) score += 10
      }

      if (n.includes('cli')) score += 2
      if (n.includes('gui')) score -= 1
      // Prefer tar.gz on Linux (usually preserves exec bit) when available.
      if (platform === 'linux' && (n.endsWith('.tar.gz') || n.endsWith('.tgz'))) score += 1
      if (platform === 'win32' && n.endsWith('.zip')) score += 1
      return { a, score, n }
    })
    .sort((x, y) => y.score - x.score)

  const best = scored[0]
  if (!best || best.score < 20) return null
  return best.a
}

async function main() {
  const platform = process.platform
  const arch = process.arch
  const folder = `${platform}-${arch}`

  const outDir = path.join(process.cwd(), 'vendor', 'ludusavi', folder)
  const downloadsDir = path.join(process.cwd(), 'vendor', 'ludusavi', '_downloads')

  mkdirp(downloadsDir)

  console.log(`[ludusavi] Fetching Ludusavi v${VERSION} for ${folder}...`)

  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}`
  const release = await httpGetJson(releaseUrl)
  const assets = Array.isArray(release?.assets) ? release.assets : []

  const asset = selectAsset(assets, { platform, arch })
  if (!asset) {
    const names = assets.map((a) => a?.name).filter(Boolean)
    throw new Error(`No suitable Ludusavi asset found for ${folder}. Assets: ${names.join(', ')}`)
  }

  const assetName = String(asset.name)
  const downloadUrl = String(asset.browser_download_url)
  if (!downloadUrl) throw new Error('asset missing browser_download_url')

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'of-ludusavi-'))
  const archivePath = path.join(tmpRoot, assetName)
  const extractDir = path.join(tmpRoot, 'extract')
  mkdirp(extractDir)

  console.log('[ludusavi] Downloading:', assetName)
  await httpDownload(downloadUrl, archivePath)

  const lower = assetName.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    if (!ensureToolExists('tar', ['--version'])) {
      throw new Error('`tar` not found; cannot extract Ludusavi .tar.gz')
    }
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract tar.gz')
  } else if (lower.endsWith('.zip')) {
    if (!ensureToolExists('unzip', ['-v'])) {
      throw new Error('`unzip` not found; cannot extract Ludusavi .zip')
    }
    const r = spawnSync('unzip', ['-o', archivePath, '-d', extractDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('failed to extract zip')
  } else {
    throw new Error(`unsupported archive type: ${assetName}`)
  }

  const exeName = platform === 'win32' ? 'ludusavi.exe' : 'ludusavi'
  const found = findFileRecursive(extractDir, (p) => path.basename(p).toLowerCase() === exeName)
  if (!found) {
    throw new Error(`extracted archive did not contain ${exeName}`)
  }

  // Clean output and copy just the executable.
  rimraf(outDir)
  mkdirp(outDir)
  const destExe = path.join(outDir, exeName)
  fs.copyFileSync(found, destExe)

  if (platform !== 'win32') {
    try {
      fs.chmodSync(destExe, 0o755)
    } catch {}
  }

  fs.writeFileSync(path.join(outDir, 'VERSION.txt'), `v${VERSION}\n`, 'utf8')
  console.log('[ludusavi] ✓ Installed to:', destExe)

  // Keep a copy of the archive for debugging (optional).
  try {
    const kept = path.join(downloadsDir, assetName)
    fs.copyFileSync(archivePath, kept)
  } catch {}

  // Best-effort cleanup.
  try {
    rimraf(tmpRoot)
  } catch {}
}

main().catch((e) => {
  console.error('[ludusavi] ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
