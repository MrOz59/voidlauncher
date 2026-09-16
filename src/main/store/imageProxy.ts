import { app, protocol, session } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { isOnlineFixHost, STORE_HOME_URL } from '../../shared/allowedHosts'
import { getStoreCooldownMs, noteStoreRateLimit, reserveStoreRequestSlot, StoreRequestError } from './requestPolicy'

/**
 * Serves store artwork through the main process.
 *
 * The renderer runs from file://, so an <img> pointing straight at the site
 * sends a cross-site, referer-less request that hotlink protection drops — the
 * grid ends up with broken covers even though the same URL answers fine from a
 * plain request. Fetching here instead lets the launcher send a proper referer
 * and reuse the store session, and keeps the artwork on one code path.
 */

const SCHEME = 'ofimg'
const STORE_PARTITION = 'persist:online-fix'
const REQUEST_TIMEOUT_MS = 20000
const REQUEST_INTERVAL_MS = 250
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const IMAGE_STALE_TTL_MS = 120 * 24 * 60 * 60 * 1000
const MAX_MEMORY_ENTRIES = 120
const MAX_DISK_ENTRIES = 500

type ImageCacheEntry = {
  target: string
  contentType: string
  fetchedAt: number
  data: Buffer
}

type ImageCacheMetadata = Omit<ImageCacheEntry, 'data'>

const imageCache = new Map<string, ImageCacheEntry>()
const imageInFlight = new Map<string, Promise<ImageCacheEntry>>()
let writesSincePrune = 0

/** Must run before the app is ready. */
export function registerStoreImageScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Wraps a store image URL so the renderer can load it. */
export function toStoreImageUrl(url: string | undefined | null): string | undefined {
  const value = String(url || '').trim()
  if (!value) return undefined

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || !isOnlineFixHost(parsed.hostname)) return value
  } catch {
    return value
  }

  return `${SCHEME}://i/${Buffer.from(value, 'utf8').toString('base64url')}`
}

function decodeTarget(requestUrl: string): string | null {
  try {
    const encoded = new URL(requestUrl).pathname.replace(/^\/+/, '')
    if (!encoded) return null

    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed = new URL(decoded)
    return parsed.protocol === 'https:' && isOnlineFixHost(parsed.hostname) ? decoded : null
  } catch {
    return null
  }
}

function imageCacheKey(target: string): string {
  return crypto.createHash('sha256').update(target).digest('hex')
}

function imageCacheDirectory(create = true): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'store-images')
  if (create) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function rememberImage(key: string, entry: ImageCacheEntry) {
  imageCache.delete(key)
  imageCache.set(key, entry)
  while (imageCache.size > MAX_MEMORY_ENTRIES) {
    imageCache.delete(imageCache.keys().next().value as string)
  }
}

function readImageCache(key: string, target: string): ImageCacheEntry | null {
  const memoryEntry = imageCache.get(key)
  if (memoryEntry?.target === target) {
    rememberImage(key, memoryEntry)
    return memoryEntry
  }

  try {
    const dir = imageCacheDirectory()
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as ImageCacheMetadata
    if (metadata?.target !== target || !metadata?.fetchedAt || !metadata?.contentType) return null
    const entry: ImageCacheEntry = {
      ...metadata,
      data: fs.readFileSync(path.join(dir, `${key}.bin`))
    }
    rememberImage(key, entry)
    return entry
  } catch {
    return null
  }
}

function pruneImageCache(dir: string) {
  writesSincePrune += 1
  if (writesSincePrune < 25) return
  writesSincePrune = 0

  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, modified: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified)

    for (const file of files.slice(MAX_DISK_ENTRIES)) {
      const key = file.name.slice(0, -5)
      try { fs.unlinkSync(path.join(dir, `${key}.json`)) } catch {}
      try { fs.unlinkSync(path.join(dir, `${key}.bin`)) } catch {}
    }
  } catch {
    // Best-effort cache maintenance.
  }
}

function writeImageCache(key: string, entry: ImageCacheEntry) {
  rememberImage(key, entry)
  try {
    const dir = imageCacheDirectory()
    fs.writeFileSync(path.join(dir, `${key}.bin`), entry.data)
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ target: entry.target, contentType: entry.contentType, fetchedAt: entry.fetchedAt } satisfies ImageCacheMetadata),
      'utf8'
    )
    pruneImageCache(dir)
  } catch (err) {
    console.warn('[Store] Failed to persist artwork cache:', err)
  }
}

async function fetchStoreImage(target: string): Promise<ImageCacheEntry> {
  const key = imageCacheKey(target)
  const cached = readImageCache(key, target)
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY
  if (cached && age < IMAGE_CACHE_TTL_MS) return cached

  const pending = imageInFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    const stale = cached && age < IMAGE_STALE_TTL_MS ? cached : null
    if (getStoreCooldownMs() > 0) {
      if (stale) return stale
      throw new StoreRequestError('store-rate-limited', 'Store rate limit is active')
    }

    await reserveStoreRequestSlot(REQUEST_INTERVAL_MS)

    if (getStoreCooldownMs() > 0) {
      if (stale) return stale
      throw new StoreRequestError('store-rate-limited', 'Store rate limit is active')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await session.fromPartition(STORE_PARTITION).fetch(target, {
        signal: controller.signal,
        credentials: 'include',
        headers: { Referer: STORE_HOME_URL, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
      })

      if (response.status === 429) {
        noteStoreRateLimit(response.headers.get('retry-after'))
        throw new StoreRequestError('store-rate-limited', '429 Too Many Requests')
      }
      if (!response.ok) throw new StoreRequestError('store-http-error', `${response.status} ${response.statusText}`)

      const entry: ImageCacheEntry = {
        target,
        contentType: response.headers.get('content-type') || 'image/jpeg',
        fetchedAt: Date.now(),
        data: Buffer.from(await response.arrayBuffer())
      }
      writeImageCache(key, entry)
      return entry
    } catch (err) {
      if (stale) return stale
      throw err
    } finally {
      clearTimeout(timer)
    }
  })()

  imageInFlight.set(key, request)
  try {
    return await request
  } finally {
    if (imageInFlight.get(key) === request) imageInFlight.delete(key)
  }
}

export function registerStoreImageProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const target = decodeTarget(request.url)
    if (!target) return new Response('bad image request', { status: 400 })

    try {
      const image = await fetchStoreImage(target)

      const body = image.data.buffer.slice(
        image.data.byteOffset,
        image.data.byteOffset + image.data.byteLength
      ) as ArrayBuffer

      return new Response(body, {
        status: 200,
        headers: {
          'content-type': image.contentType,
          // Artwork barely changes; both Chromium and the main process cache it.
          'cache-control': 'public, max-age=2592000, immutable'
        }
      })
    } catch (err: any) {
      console.warn('[Store] Image proxy failed:', err?.message || err)
      return new Response('image fetch failed', { status: err?.code === 'store-rate-limited' ? 429 : 502 })
    }
  })
}

export function clearStoreImageCache() {
  imageCache.clear()
  try {
    fs.rmSync(imageCacheDirectory(false), { recursive: true, force: true })
  } catch (err) {
    console.warn('[Store] Failed to clear persistent artwork cache:', err)
  }
}
