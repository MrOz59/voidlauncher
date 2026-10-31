import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { app } from 'electron'
import http from 'http'

// Minimal JSON-RPC-ish line protocol over stdin/stdout.
// This is intentionally small: start/pause/resume/remove/status.

export interface TorrentProgress {
  progress: number
  downloadSpeed: number
  downloaded: number
  total: number
  timeRemaining: number
  infoHash?: string
  peers?: number
  seeds?: number
  state?: string
  statusMessage?: string
  hasMetadata?: boolean
  paused?: boolean
  errorMessage?: string | null
}

type RpcRequest = { id: number; method: string; params?: any }
type RpcResponse = { id: number; result?: any; error?: { message: string; code?: string } }

class LibtorrentUnavailableError extends Error {
  code = 'LIBTORRENT_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'LibtorrentUnavailableError'
  }
}

type RpcClient = {
  start(): Promise<void>
  call(method: string, params?: any, timeoutMs?: number): Promise<any>
}

type ActiveTorrent = {
  aliases: Set<string>
  infoHash?: string
  source: string
  destPath: string
  finish?: (err?: Error) => void
  pausedRequested?: boolean
  pollTimer?: NodeJS.Timeout
  mode?: TorrentDownloadMode
}

export type TorrentDownloadMode = 'all' | 'updates'

const activeTorrents = new Map<string, ActiveTorrent>()

function shouldForcePythonTorrentAgent(): boolean {
  return String(process.env.OF_FORCE_PYTHON_TORRENT_AGENT || '').trim() === '1'
}

function shouldSkipDevStandaloneBinary(candidate: string): boolean {
  if (app?.isPackaged) return false

  if (shouldForcePythonTorrentAgent()) {
    console.log('[torrent-agent] OF_FORCE_PYTHON_TORRENT_AGENT=1, skipping dev standalone binary')
    return true
  }

  const sourceScript = path.join(process.cwd(), 'services', 'torrent-agent', 'libtorrent_rpc.py')
  try {
    if (!fs.existsSync(sourceScript)) return false
    const sourceStat = fs.statSync(sourceScript)
    const binaryStat = fs.statSync(candidate)
    if (sourceStat.mtimeMs > binaryStat.mtimeMs) {
      console.log('[torrent-agent] Dev source script is newer than standalone binary, using Python sidecar')
      return true
    }
  } catch {
    return false
  }

  return false
}

function registerActive(record: ActiveTorrent) {
  for (const key of record.aliases) activeTorrents.set(key, record)
}

function unregisterActive(record: ActiveTorrent) {
  for (const key of record.aliases) activeTorrents.delete(key)
}

function hasActiveAlias(ids: string[]): boolean {
  return ids.some(id => activeTorrents.has(id))
}

/**
 * Get the path to the standalone torrent-agent binary.
 * Returns null if not found (fallback to Python mode).
 */
function getStandaloneBinaryPath(): string | null {
  // On Windows, cx_Freeze may create with or without .exe extension
  const possibleNames = process.platform === 'win32' 
    ? ['torrent-agent.exe', 'torrent-agent'] 
    : ['torrent-agent']

  console.log('[torrent-agent] Looking for standalone binary...')
  console.log('[torrent-agent] Platform:', process.platform, 'Arch:', process.arch)
  console.log('[torrent-agent] app.isPackaged:', app?.isPackaged)
  console.log('[torrent-agent] process.resourcesPath:', process.resourcesPath)

  // Packaged app: look in resources/torrent-agent/
  if (app?.isPackaged && process.resourcesPath) {
    const resources = process.resourcesPath
    
    for (const exeName of possibleNames) {
      const candidate = path.join(resources, 'torrent-agent', exeName)
      console.log('[torrent-agent] Checking packaged path:', candidate)
      
      if (fs.existsSync(candidate)) {
        console.log('[torrent-agent] ✓ Found binary at:', candidate)
        return candidate
      }
    }
    
    // List what's actually in resources/torrent-agent to help debug
    const torrentAgentDir = path.join(resources, 'torrent-agent')
    if (fs.existsSync(torrentAgentDir)) {
      const contents = fs.readdirSync(torrentAgentDir)
      console.log('[torrent-agent] Directory exists. Contents:', contents.slice(0, 15).join(', '), contents.length > 15 ? `... (${contents.length} total)` : '')
    } else {
      console.log('[torrent-agent] Directory does not exist:', torrentAgentDir)
      // List resources root
      const resourcesContents = fs.readdirSync(resources)
      console.log('[torrent-agent] Resources root contents:', resourcesContents.join(', '))
    }
  }

  // Dev mode: look in services/torrent-agent/torrent-agent/ (cx_Freeze output)
  for (const exeName of possibleNames) {
    const devPath = path.join(process.cwd(), 'services', 'torrent-agent', 'torrent-agent', exeName)
    console.log('[torrent-agent] Checking dev path:', devPath)
    if (fs.existsSync(devPath)) {
      if (shouldSkipDevStandaloneBinary(devPath)) continue
      console.log('[torrent-agent] ✓ Found dev binary at:', devPath)
      return devPath
    }
  }

  // Legacy dev path (older builds)
  for (const exeName of possibleNames) {
    const devPath = path.join(process.cwd(), 'services', 'torrent-agent', 'dist', exeName)
    console.log('[torrent-agent] Checking legacy dev path:', devPath)
    if (fs.existsSync(devPath)) {
      if (shouldSkipDevStandaloneBinary(devPath)) continue
      console.log('[torrent-agent] ✓ Found dev binary at:', devPath)
      return devPath
    }
  }

  console.log('[torrent-agent] No standalone binary found, will fallback to Python')
  return null
}

function getPythonExecutable(): string {
  const env = String(process.env.OF_PYTHON_PATH || '').trim()
  if (env) return env

  // If we ship an embedded python in resources, prefer it.
  // Layout: resources/torrent-agent/python/<platform>-<arch>/python(.exe)
  if (app?.isPackaged && process.resourcesPath) {
    const resources = process.resourcesPath
    const folder = `${process.platform}-${process.arch}`
    const base = path.join(resources, 'torrent-agent', 'python', folder)
    const exe = process.platform === 'win32' ? 'python.exe' : 'python'
    const candidate = path.join(base, exe)
    if (fs.existsSync(candidate)) return candidate
  }

  return process.platform === 'win32' ? 'python' : 'python3'
}

function getSidecarScriptPath(): string {
  const override = String(process.env.OF_SIDECAR_PATH || '').trim()
  if (override) return override

  // Dev path
  const devPath = path.join(process.cwd(), 'services', 'torrent-agent', 'libtorrent_rpc.py')
  if (fs.existsSync(devPath)) return devPath

  // Packaged path (electron-builder extraResources)
  if (app?.isPackaged && process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'torrent-agent', 'libtorrent_rpc.py')
    if (fs.existsSync(packaged)) return packaged
  }

  // Last resort: legacy writable location (backwards compatibility)
  const baseDir = process.env.OF_SIDECAR_DIR
    ? path.resolve(process.env.OF_SIDECAR_DIR)
    : path.join(process.cwd(), '.of-sidecar')
  fs.mkdirSync(baseDir, { recursive: true })
  return path.join(baseDir, 'libtorrent_rpc.py')
}

class LibtorrentRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private starting: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.proc) return
    if (this.starting) return this.starting

    this.starting = new Promise<void>((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env }

      // Try standalone binary first (preferred - no Python needed)
      const standaloneBinary = getStandaloneBinaryPath()
      let spawnCmd: string
      let spawnArgs: string[]

      if (standaloneBinary) {
        console.log('[torrent-agent] Using standalone binary:', standaloneBinary)
        spawnCmd = standaloneBinary
        spawnArgs = []
      } else {
        // Fallback to Python mode
        console.log('[torrent-agent] Standalone binary not found, falling back to Python mode')
        const python = getPythonExecutable()
        const scriptPath = getSidecarScriptPath()
        spawnCmd = python
        spawnArgs = ['-u', scriptPath]

        // Dev: if deps were installed into services/torrent-agent/pydeps, use them.
        const devDeps = path.join(process.cwd(), 'services', 'torrent-agent', 'pydeps')
        if (fs.existsSync(devDeps)) {
          const prev = String(childEnv.PYTHONPATH || '').trim()
          childEnv.PYTHONPATH = prev ? `${devDeps}${path.delimiter}${prev}` : devDeps
        }

        // When packaged, dependencies are expected at: resources/torrent-agent/pydeps
        if (app?.isPackaged && process.resourcesPath) {
          const deps = path.join(process.resourcesPath, 'torrent-agent', 'pydeps')
          const prev = String(childEnv.PYTHONPATH || '').trim()
          childEnv.PYTHONPATH = prev ? `${deps}${path.delimiter}${prev}` : deps
        }
      }

      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn(spawnCmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
      } catch (e: any) {
        reject(new LibtorrentUnavailableError(e?.message || 'failed to spawn torrent-agent'))
        return
      }

      this.proc = proc

      const rl = readline.createInterface({ input: proc.stdout })
      rl.on('line', (line) => {
        const text = String(line || '').trim()
        if (!text) return
        try {
          const msg = JSON.parse(text)

          // fatal early message (missing libtorrent)
          if (msg && msg.event === 'fatal') {
            console.error('[torrent-agent] Fatal error from binary:', msg.message)
            console.error('[torrent-agent] Detail:', msg.detail)
            if (msg.traceback) {
              console.error('[torrent-agent] Traceback:', msg.traceback)
            }
            const err = new LibtorrentUnavailableError(msg.message || 'libtorrent unavailable')
            ;(err as any).detail = msg.detail
            ;(err as any).traceback = msg.traceback
            reject(err)
            try { proc.kill() } catch {}
            return
          }

          const res = msg as RpcResponse
          if (!res || typeof res.id !== 'number') return
          const pending = this.pending.get(res.id)
          if (!pending) return
          this.pending.delete(res.id)
          if (res.error) {
            const err = new Error(res.error.message || 'RPC error')
            ;(err as any).code = res.error.code
            pending.reject(err)
          } else {
            pending.resolve(res.result)
          }
        } catch {
          // ignore non-JSON output
        }
      })

      proc.on('exit', (code) => {
        const err = new Error(`libtorrent sidecar exited (${code ?? 'unknown'})`)
        for (const [, p] of this.pending) p.reject(err)
        this.pending.clear()
        this.proc = null
      })

      // Any stderr output is treated as availability hint but not fatal (some distros warn).
      let stderr = ''
      proc.stderr.on('data', (b) => { stderr += String(b || '') })

      // Probe the sidecar.
      this.call('ping', {}).then(() => {
        resolve()
      }).catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e))
        // If python ran but libtorrent is missing, stderr often contains details.
        ;(err as any).stderr = stderr
        reject(err)
        try { proc.kill() } catch {}
      })
    }).finally(() => {
      this.starting = null
    })

    return this.starting
  }

  async call(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    await this.start()
    if (!this.proc) throw new LibtorrentUnavailableError('sidecar not running')

    const id = this.nextId++
    const req: RpcRequest = { id, method, params: params || {} }

    const payload = JSON.stringify(req)

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null }
        this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: (v: any) => { cleanup(); resolve(v) },
        reject: (e: any) => { cleanup(); reject(e) }
      })

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timer = null
          this.pending.delete(id)
          reject(new Error(`RPC call '${method}' timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      try {
        this.proc!.stdin.write(payload + '\n')
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
  }
}

class TransmissionRpcClient {
  private daemon: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private rpcPort: number | null = null
  private sessionId: string | null = null

  private getRpcUrl(): string {
    const port = this.rpcPort || 9091
    return `http://127.0.0.1:${port}/transmission/rpc`
  }

  private request(body: any): Promise<any> {
    const payload = JSON.stringify(body)
    const url = new URL(this.getRpcUrl())

    const doReq = (sessionId: string | null): Promise<{ statusCode?: number; headers: http.IncomingHttpHeaders; text: string }> => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: Number(url.port),
            path: url.pathname,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              ...(sessionId ? { 'X-Transmission-Session-Id': sessionId } : {})
            }
          },
          (res) => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { data += String(chunk || '') })
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, text: data }))
          }
        )
        req.on('error', reject)
        req.write(payload)
        req.end()
      })
    }

    return doReq(this.sessionId).then(async (res) => {
      // Transmission uses 409 to indicate missing/invalid session id.
      if (res.statusCode === 409) {
        const sid = String(res.headers['x-transmission-session-id'] || '').trim()
        if (sid) {
          this.sessionId = sid
          const retry = await doReq(this.sessionId)
          if (retry.statusCode && retry.statusCode >= 400) {
            throw new Error(`transmission rpc error (${retry.statusCode}): ${retry.text || ''}`)
          }
          return JSON.parse(retry.text || '{}')
        }
      }

      if (res.statusCode && res.statusCode >= 400) {
        throw new Error(`transmission rpc error (${res.statusCode}): ${res.text || ''}`)
      }

      return JSON.parse(res.text || '{}')
    })
  }

  async start(): Promise<void> {
    if (this.daemon) return
    if (this.starting) return this.starting

    this.starting = new Promise<void>((resolve, reject) => {
      const hasDaemon = spawnSync('transmission-daemon', ['--version'], { encoding: 'utf8' })
      if (hasDaemon.status !== 0) {
        reject(new LibtorrentUnavailableError('transmission-daemon not available'))
        return
      }

      const userData = app?.getPath ? app.getPath('userData') : process.cwd()
      const cfgDir = path.join(userData, 'transmission')
      try { fs.mkdirSync(cfgDir, { recursive: true }) } catch {}

      // Transmission logs an error if settings.json is missing; create a minimal one.
      try {
        const settingsPath = path.join(cfgDir, 'settings.json')
        if (!fs.existsSync(settingsPath)) {
          fs.writeFileSync(settingsPath, '{}', 'utf8')
        }
      } catch {}

      // Try a couple ports to avoid collisions.
      const basePort = Number(process.env.OF_TRANSMISSION_RPC_PORT || 9091)
      const portsToTry = [basePort, basePort + 1, basePort + 2]

      let lastErr: Error | null = null
      let lastStderr = ''

      const tryStart = async (idx: number) => {
        if (idx >= portsToTry.length) {
          const msg = lastErr?.message || 'failed to start transmission-daemon'
          const err = new Error(lastStderr ? `${msg}\n${lastStderr}` : msg)
          reject(err)
          return
        }

        const port = portsToTry[idx]
        this.rpcPort = port
        this.sessionId = null

        console.log('[torrent-agent] Starting Transmission daemon (RPC port):', port)

        // Foreground daemon so we keep it attached to the app lifecycle.
        // Transmission 4.x flags: RPC port is "--port"; auth is "--no-auth".
        const args = [
          '--foreground',
          '--config-dir', cfgDir,
          '--rpc-bind-address', '127.0.0.1',
          '--port', String(port),
          '--no-auth',
          '--allowed', '127.0.0.1',
          '--log-level', 'error'
        ]

        let proc: ChildProcess
        try {
          proc = spawn('transmission-daemon', args, { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          reject(e as any)
          return
        }

        this.daemon = proc

        // Best-effort: log stderr if something is wrong.
        let stderr = ''
        proc.stderr?.on('data', (b) => { stderr += String(b || '') })

        // Probe RPC.
        let probeAttempts = 0
        const maxProbeAttempts = 30 // ~9s at 300ms

        const probe = async () => {
          try {
            const res = await this.request({ method: 'session-get' })
            if (res?.result && String(res.result).toLowerCase() !== 'success') {
              throw new Error(`transmission rpc not ready: ${JSON.stringify(res)}`)
            }

            console.log('[torrent-agent] ✓ Transmission RPC ready at:', this.getRpcUrl())
            resolve()
          } catch (err) {
            // If daemon died quickly or RPC refused, retry with another port.
            if (proc.exitCode !== null) {
              const e = new Error(`transmission-daemon exited (${proc.exitCode})${stderr ? `: ${stderr}` : ''}`)
              lastErr = e
              lastStderr = stderr
              this.daemon = null
              tryStart(idx + 1)
              return
            }

            probeAttempts++
            if (probeAttempts >= maxProbeAttempts) {
              const e = new Error(`transmission-daemon did not become ready on port ${port}`)
              lastErr = e
              lastStderr = stderr
              try { proc.kill() } catch {}
              this.daemon = null
              tryStart(idx + 1)
              return
            }

            // Retry probe a few times before failing over to next port.
            setTimeout(() => probe(), 300)
          }
        }

        probe()
      }

      tryStart(0)
    }).finally(() => {
      this.starting = null
    })

    return this.starting
  }

  async call(method: string, params?: any, _timeoutMs?: number): Promise<any> {
    await this.start()

    const p = params || {}

    if (method === 'ping') {
      const res = await this.request({ method: 'session-get' })
      if (String(res?.result || '').toLowerCase() !== 'success') {
        throw new Error('transmission ping failed')
      }
      return { ok: true }
    }

    if (method === 'add') {
      const source = String(p.source || '').trim()
      const savePath = String(p.savePath || '').trim()
      const mode = String(p.mode || '').trim()
      if (!source) throw new Error('source required')
      if (!savePath) throw new Error('savePath required')

      const filename = source.toLowerCase().endsWith('.torrent') && fs.existsSync(source)
        ? source
        : source

      const res = await this.request({
        method: 'torrent-add',
        arguments: {
          filename,
          'download-dir': savePath
        }
      })

      const added = res?.arguments?.['torrent-added'] || res?.arguments?.['torrent-duplicate']
      const infoHash = String(added?.hashString || '').trim()
      if (!infoHash) throw new Error('transmission: missing hashString')

      if (mode === 'updates') {
        try {
          const filesRes = await this.request({
            method: 'torrent-get',
            arguments: {
              ids: [infoHash],
              fields: ['files']
            }
          })
          const torrent = (filesRes?.arguments?.torrents || [])[0]
          const files = Array.isArray(torrent?.files) ? torrent.files : []
          const wanted: number[] = []
          const unwanted: number[] = []
          files.forEach((file: any, index: number) => {
            const filePath = String(file?.name || '').replace(/\\/g, '/').toLowerCase()
            const parts = filePath.split('/').filter(Boolean)
            const name = parts[parts.length - 1] || filePath
            const isUpdate =
              parts.includes('updates') ||
              filePath.includes('/updates/') ||
              name.startsWith('update') ||
              name.includes('.update.') ||
              name.includes('_update_') ||
              name.includes('-update-')
            if (isUpdate) wanted.push(index)
            else unwanted.push(index)
          })
          if (wanted.length > 0) {
            await this.request({
              method: 'torrent-set',
              arguments: {
                ids: [infoHash],
                'files-wanted': wanted,
                'files-unwanted': unwanted,
                'priority-high': wanted,
                'priority-low': unwanted
              }
            })
            console.log('[torrent-agent] Transmission selected update files:', wanted.length, 'of', files.length)
          } else {
            console.log('[torrent-agent] Transmission found no Updates files; downloading full torrent')
          }
        } catch (err) {
          console.warn('[torrent-agent] Transmission update-only file selection failed:', err)
        }
      }
      return { infoHash }
    }

    if (method === 'pause') {
      const torrentId = String(p.torrentId || '').trim()
      await this.request({ method: 'torrent-stop', arguments: { ids: [torrentId] } })
      return { ok: true }
    }

    if (method === 'resume') {
      const torrentId = String(p.torrentId || '').trim()
      await this.request({ method: 'torrent-start', arguments: { ids: [torrentId] } })
      return { ok: true }
    }

    if (method === 'remove') {
      const torrentId = String(p.torrentId || '').trim()
      const deleteFiles = Boolean(p.deleteFiles)
      await this.request({ method: 'torrent-remove', arguments: { ids: [torrentId], 'delete-local-data': deleteFiles } })
      return { ok: true }
    }

    if (method === 'status') {
      const torrentId = String(p.torrentId || '').trim()
      const res = await this.request({
        method: 'torrent-get',
        arguments: {
          ids: [torrentId],
          fields: [
            'hashString',
            'percentDone',
            'rateDownload',
            'downloadedEver',
            'sizeWhenDone',
            'eta',
            'isFinished',
            'status',
            'errorString',
            'peersConnected',
            'seeders',
            'leechers'
          ]
        }
      })
      const t = (res?.arguments?.torrents || [])[0]
      if (!t) throw new Error('torrent not found')

      const percentDone = Number(t.percentDone ?? 0)
      const totalWanted = Number(t.sizeWhenDone ?? 0)
      const totalDone = Number(t.downloadedEver ?? 0)
      const downloadRate = Number(t.rateDownload ?? 0)
      const eta = Number(t.eta ?? 0)
      const peers = Number(t.leechers ?? t.peersConnected ?? 0)
      const seeds = Number(t.seeders ?? 0)
      const isFinished = Boolean(t.isFinished)
      const statusCode = Number(t.status ?? 0)
      const stateNames: Record<number, string> = {
        0: 'stopped',
        1: 'check_wait',
        2: 'checking',
        3: 'download_wait',
        4: 'downloading',
        5: 'seed_wait',
        6: 'seeding'
      }
      const state = stateNames[statusCode] || String(statusCode)
      const errorMessage = String(t.errorString || '').trim()
      const statusMessage = errorMessage
        ? `Erro: ${errorMessage}`
        : isFinished
          ? 'Concluído'
          : statusCode === 0
            ? 'Pausado'
            : peers <= 0 && downloadRate <= 0
              ? 'Conectando aos peers'
              : downloadRate <= 0
                ? 'Aguardando peças'
                : 'Baixando'

      return {
        progress: percentDone * 100,
        totalWanted,
        totalDone,
        downloadRate,
        eta,
        peers,
        seeds,
        isFinished,
        state,
        statusMessage,
        paused: statusCode === 0,
        hasMetadata: totalWanted > 0,
        errorMessage: errorMessage || null
      }
    }

    throw new Error(`unsupported method: ${method}`)
  }
}

class FallbackRpcClient implements RpcClient {
  private primary = new LibtorrentRpcClient()
  private fallback = new TransmissionRpcClient()
  private selected: RpcClient | null = null

  async start(): Promise<void> {
    if (this.selected) return this.selected.start()

    try {
      await this.primary.start()
      this.selected = this.primary
      return
    } catch (e: any) {
      const stderr = (e as any)?.stderr
      console.error('[torrent-agent] libtorrent unavailable; trying Transmission fallback')
      if (stderr) console.error('[torrent-agent] libtorrent stderr:', String(stderr).slice(0, 1200))
    }

    const allowFallback = String(process.env.OF_ALLOW_TORRENT_FALLBACK || '').trim() === '1'
    if (!allowFallback) {
      throw new LibtorrentUnavailableError('libtorrent sidecar unavailable (fallback disabled)')
    }

    await this.fallback.start()
    this.selected = this.fallback
  }

  async call(method: string, params?: any, timeoutMs?: number): Promise<any> {
    await this.start()
    return this.selected!.call(method, params, timeoutMs)
  }
}

const rpc: RpcClient = new FallbackRpcClient()

export function isTorrentActive(torrentId: string): boolean {
  return activeTorrents.has(torrentId)
}

export function getActiveTorrentIds(): string[] {
  return Array.from(new Set([...activeTorrents.values()].flatMap(r => Array.from(r.aliases))))
}

export function getActiveTorrentSnapshots() {
  const seen = new Set<ActiveTorrent>()
  const out: Array<{ aliases: string[]; infoHash?: string; source: string; destPath: string; pausedRequested?: boolean }> = []
  for (const record of activeTorrents.values()) {
    if (seen.has(record)) continue
    seen.add(record)
    out.push({
      aliases: Array.from(record.aliases),
      infoHash: record.infoHash,
      source: record.source,
      destPath: record.destPath,
      pausedRequested: !!record.pausedRequested
    })
  }
  return out
}

export async function downloadTorrent(
  magnetOrTorrent: string,
  destPath: string,
  onProgress?: (progress: number, details?: TorrentProgress & { infoHash: string }) => void,
  aliases: string[] = [],
  shouldCancel?: () => boolean,
  mode: TorrentDownloadMode = 'all'
): Promise<void> {
  const lookupIds = Array.from(new Set([magnetOrTorrent, ...aliases].filter(Boolean)))
  if (hasActiveAlias(lookupIds)) throw new Error('Torrent already in progress')

  const record: ActiveTorrent = {
    aliases: new Set(lookupIds),
    source: magnetOrTorrent,
    destPath,
    pausedRequested: false,
    mode
  }

  let cleaned = false
  let finished = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (record.pollTimer) clearInterval(record.pollTimer)
    unregisterActive(record)
  }

  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
  }

  registerActive(record)

  const rejectIfCancelled = async (): Promise<boolean> => {
    if (shouldCancel && shouldCancel()) {
      try {
        if (record.infoHash) await rpc.call('remove', { torrentId: record.infoHash, deleteFiles: false })
      } catch {
        // ignore
      }
      cleanup()
      throw new Error('cancelled')
    }
    return false
  }

  try {
    await rpc.start()
  } catch (e: any) {
    const err = e instanceof Error ? e : new Error(String(e))
    ;(err as any).code = (e as any)?.code || 'LIBTORRENT_UNAVAILABLE'
    throw err
  }

  await rejectIfCancelled()

  const addRes = await rpc.call('add', { source: magnetOrTorrent, savePath: destPath, mode })
  const infoHash = String(addRes?.infoHash || '').trim()
  if (!infoHash) throw new Error('libtorrent: missing infoHash')

  record.infoHash = infoHash
  record.aliases.add(infoHash)
  registerActive(record)

  // Poll status and emit progress.
  await new Promise<void>((resolve, reject) => {
    const settle = (err?: Error) => {
      if (finished) return
      finished = true
      cleanup()
      if (err) reject(err)
      else resolve()
    }

    record.finish = settle

    const tick = async () => {
      try {
        await rejectIfCancelled()

        if (record.pausedRequested) {
          // keep status ticking (UI wants speed=0), but do not auto-resume.
        }

        const st = await rpc.call('status', { torrentId: infoHash })
        const progress = Number(st?.progress ?? 0)
        const downloaded = Number(st?.totalDone ?? 0)
        const total = Number(st?.totalWanted ?? 0)
        const normalizedProgress =
          total > 0 && Number.isFinite(downloaded)
            ? Math.max(0, Math.min(100, (downloaded / total) * 100))
            : Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0))
        const downloadSpeed = Number(st?.downloadRate ?? 0)
        const timeRemaining = Number(st?.eta ?? 0)
        const peers = Number(st?.peers ?? 0)
        const seeds = Number(st?.seeds ?? 0)

        const details = {
          progress: normalizedProgress,
          downloaded,
          total,
          downloadSpeed: Number.isFinite(downloadSpeed) ? Math.max(0, downloadSpeed) : 0,
          timeRemaining: Number.isFinite(timeRemaining) ? Math.max(0, timeRemaining) : 0,
          infoHash,
          peers: Number.isFinite(peers) ? peers : 0,
          seeds: Number.isFinite(seeds) ? seeds : 0,
          state: typeof st?.state === 'string' ? st.state : undefined,
          statusMessage: typeof st?.statusMessage === 'string' ? st.statusMessage : undefined,
          hasMetadata: typeof st?.hasMetadata === 'boolean' ? st.hasMetadata : undefined,
          paused: typeof st?.paused === 'boolean' ? st.paused : undefined,
          errorMessage: typeof st?.errorMessage === 'string' ? st.errorMessage : undefined
        }
        onProgress?.(normalizedProgress, details)

        // The agent can report 100% while also reporting an I/O or disk error.
        const agentError = String(st?.errorMessage || '').trim()
        if (agentError) {
          settle(new Error(`Torrent agent error: ${agentError}`))
          return
        }

        const done = Boolean(st?.isFinished) || (total > 0 && downloaded >= total)
        if (done) {
          try { await rpc.call('pause', { torrentId: infoHash }) } catch {}
          settle()
        }
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)))
      }
    }

    // Kick once immediately, then interval.
    tick()
    record.pollTimer = setInterval(tick, 800)
  })

  try {
    finish()
  } catch (e: any) {
    throw e
  }
}

export function pauseTorrent(torrentId: string): boolean {
  const active = activeTorrents.get(torrentId)
  if (!active) return false
  active.pausedRequested = true

  const ih = active.infoHash
  if (!ih) return true

  rpc.call('pause', { torrentId: ih }).catch(() => {})
  return true
}

export function resumeTorrent(torrentId: string): boolean {
  const active = activeTorrents.get(torrentId)
  if (!active) return false
  active.pausedRequested = false

  const ih = active.infoHash
  if (!ih) return true

  rpc.call('resume', { torrentId: ih }).catch(() => {})
  return true
}

export function cancelTorrent(torrentId: string): boolean {
  const active = activeTorrents.get(torrentId)
  if (!active) return false

  const ih = active.infoHash
  // Best-effort remove from session; DownloadManager already deletes files/dirs.
  if (ih) rpc.call('remove', { torrentId: ih, deleteFiles: false }).catch(() => {})

  if (active.finish) {
    try { active.finish(new Error('cancelled')) } catch {}
  }

  if (active.pollTimer) clearInterval(active.pollTimer)
  unregisterActive(active)
  return true
}
