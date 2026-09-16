import { app, net } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * Fixes published alongside the launcher, fetched when someone asks for one.
 *
 * They live in the repository rather than in the build because a fix tracks a
 * game and a repack, which change far more often than the launcher ships. The
 * index says what exists for a game; the fix itself is downloaded only when it
 * is wanted.
 *
 * Nothing here trusts what comes back. The base URL is pinned, the file name
 * is checked against the shape a fix id may have, and the caller validates
 * every field through the same normaliser an imported file goes through.
 */
const FIXES_BASE = 'https://raw.githubusercontent.com/MrOz59/voidlauncher/main/fixes'
const INDEX_TTL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12000
const MAX_BYTES = 256 * 1024

export type RemoteFixEntry = {
  id: string
  file: string
  title: string
  description?: string
  game: { id?: string | null; title?: string | null; url?: string | null }
}

type CachedIndex = { fetchedAt: number; fixes: RemoteFixEntry[] }

/** A fix id names a file in a fixed folder; it can never name a path. */
const FIX_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i

function cacheFile(): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'remote-fixes')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'index.json')
}

function readCache(): CachedIndex | null {
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as CachedIndex
    return Array.isArray(value?.fixes) && value.fetchedAt ? value : null
  } catch {
    return null
  }
}

async function getJson(url: string): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { signal: controller.signal, credentials: 'omit' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const body = await response.text()
    if (body.length > MAX_BYTES) throw new Error('Resposta grande demais para um fix')
    return JSON.parse(body)
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeEntries(raw: any): RemoteFixEntry[] {
  const list = Array.isArray(raw?.fixes) ? raw.fixes : []
  const out: RemoteFixEntry[] = []

  for (const entry of list.slice(0, 500)) {
    const id = String(entry?.id || '').trim()
    const file = String(entry?.file || '').trim()
    if (!FIX_ID.test(id) || file !== `${id}.json`) continue

    out.push({
      id,
      file,
      title: String(entry?.title || id).slice(0, 200),
      description: String(entry?.description || '').slice(0, 1000),
      game: {
        id: entry?.game?.id ? String(entry.game.id).slice(0, 80) : null,
        title: entry?.game?.title ? String(entry.game.title).slice(0, 160) : null,
        url: entry?.game?.url ? String(entry.game.url).slice(0, 500) : null
      }
    })
  }

  return out
}

/**
 * The cached index is served while it is fresh, and again as a fallback when
 * the network fails — being offline should cost the newest fixes, not the ones
 * already known.
 */
export async function getRemoteFixIndex(options?: { force?: boolean }): Promise<{ fixes: RemoteFixEntry[]; fromCache: boolean; error?: string }> {
  const cached = readCache()
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY
  if (cached && !options?.force && age < INDEX_TTL_MS) {
    return { fixes: cached.fixes, fromCache: true }
  }

  try {
    const fixes = normalizeEntries(await getJson(`${FIXES_BASE}/index.json`))
    try {
      fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), fixes } satisfies CachedIndex))
    } catch {
      // A cache that cannot be written is not a reason to withhold the answer.
    }
    return { fixes, fromCache: false }
  } catch (err: any) {
    if (cached) return { fixes: cached.fixes, fromCache: true, error: err?.message || String(err) }
    throw err
  }
}

/** Downloads one fix. The id must be one the index actually lists. */
export async function getRemoteFix(id: string): Promise<any> {
  const clean = String(id || '').trim()
  if (!FIX_ID.test(clean)) throw new Error('Identificador de fix inválido')

  const { fixes } = await getRemoteFixIndex()
  const entry = fixes.find((fix) => fix.id === clean)
  if (!entry) throw new Error('Fix não está no índice publicado')

  return getJson(`${FIXES_BASE}/${entry.file}`)
}
