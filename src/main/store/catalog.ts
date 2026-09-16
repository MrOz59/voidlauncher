import { app, session } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { STORE_HOME_URL, isOnlineFixHost } from '../../shared/allowedHosts'
import { parseGamePage, parseListing, type StoreGameDetails, type StoreListing } from './parser'
import { toStoreImageUrl } from './imageProxy'
import { getStoreCooldownMs, noteStoreRateLimit, reserveStoreRequestSlot, StoreRequestError } from './requestPolicy'

/**
 * Data layer for the native store.
 *
 * Requests go through the same session partition as the store webview, so the
 * user's login cookies apply and pages that require an account come back
 * complete. Responses use a persistent, identity-scoped cache and a shared
 * request gate: opening a grid must never turn one interaction into a burst of
 * requests against the site.
 */

const STORE_PARTITION = 'persist:online-fix'
const LISTING_CACHE_TTL_MS = 30 * 60 * 1000
const GAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const LISTING_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GAME_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FORCE_REVALIDATE_COOLDOWN_MS = 30 * 1000
const MIN_REQUEST_INTERVAL_MS = 900
const REQUEST_TIMEOUT_MS = 20000
const MAX_MEMORY_CACHE_ENTRIES = 80
const MAX_DISK_CACHE_ENTRIES = 160

type CacheEntry = { url: string; html: string; fetchedAt: number }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<string>>()

function storeSession() {
  return session.fromPartition(STORE_PARTITION)
}

function decodeBody(buffer: Buffer, contentType: string | null): string {
  const declared = /charset=([^;]+)/i.exec(String(contentType || ''))?.[1]?.trim().toLowerCase()
  const utf8 = buffer.toString('utf8')
  const meta = /charset=["']?([\w-]+)/i.exec(utf8.slice(0, 2048))?.[1]?.toLowerCase()
  const charset = declared || meta

  if (!charset || charset === 'utf-8' || charset === 'utf8') return utf8

  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return utf8
  }
}

function isListingUrl(target: string): boolean {
  const url = new URL(target)
  return url.pathname === '/' || /^\/page\/\d+\/?$/i.test(url.pathname) || url.searchParams.get('do') === 'search'
}

function cachePolicy(target: string) {
  return isListingUrl(target)
    ? { freshFor: LISTING_CACHE_TTL_MS, staleFor: LISTING_STALE_TTL_MS }
    : { freshFor: GAME_CACHE_TTL_MS, staleFor: GAME_STALE_TTL_MS }
}

async function cacheScope(): Promise<string> {
  try {
    const cookies = await storeSession().cookies.get({ url: STORE_HOME_URL })
    const identity = cookies
      .filter((cookie) => /^(dle_user_id|dle_password)$/i.test(cookie.name))
      .map((cookie) => `${cookie.name.toLowerCase()}=${cookie.value}`)
      .sort()
      .join('&')
    if (!identity) return 'guest'
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)
  } catch {
    return 'guest'
  }
}

function cacheKey(scope: string, target: string): string {
  return crypto.createHash('sha256').update(`${scope}\n${target}`).digest('hex')
}

function cacheDirectory(create = true): string {
  const dir = path.join(app.getPath('userData'), 'cache', 'store-pages')
  if (create) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readCache(key: string, target: string): CacheEntry | null {
  const memoryEntry = cache.get(key)
  if (memoryEntry?.url === target) {
    cache.delete(key)
    cache.set(key, memoryEntry)
    return memoryEntry
  }

  try {
    const entry = JSON.parse(fs.readFileSync(path.join(cacheDirectory(), `${key}.json`), 'utf8')) as CacheEntry
    if (!entry?.html || !entry?.fetchedAt || entry.url !== target) return null
    rememberCache(key, entry)
    return entry
  } catch {
    return null
  }
}

function rememberCache(key: string, entry: CacheEntry) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_MEMORY_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value as string)
  }
}

function pruneDiskCache(dir: string) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, modified: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified)

    for (const file of files.slice(MAX_DISK_CACHE_ENTRIES)) {
      fs.unlinkSync(path.join(dir, file.name))
    }
  } catch {
    // Cache pruning is best-effort and must never break the store.
  }
}

function writeCache(key: string, entry: CacheEntry, persist: boolean) {
  rememberCache(key, entry)
  if (!persist) return
  try {
    const dir = cacheDirectory()
    const file = path.join(dir, `${key}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(entry), 'utf8')
    fs.renameSync(temporary, file)
    pruneDiskCache(dir)
  } catch (err) {
    console.warn('[Store] Failed to persist page cache:', err)
  }
}

function staleValue(entry: CacheEntry | null, staleFor: number): string | null {
  return entry && Date.now() - entry.fetchedAt <= staleFor ? entry.html : null
}

export async function fetchStoreHtml(url: string, options?: { force?: boolean }): Promise<string> {
  const target = new URL(url, STORE_HOME_URL).toString()
  if (new URL(target).protocol !== 'https:' || !isOnlineFixHost(new URL(target).hostname)) {
    throw new Error(`Refusing to fetch a host outside the store: ${target}`)
  }

  const scope = await cacheScope()
  const key = cacheKey(scope, target)
  const cached = readCache(key, target)
  const policy = cachePolicy(target)
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY

  if (cached && ((!options?.force && age < policy.freshFor) || (options?.force && age < FORCE_REVALIDATE_COOLDOWN_MS))) {
    return cached.html
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    const stale = staleValue(cached, policy.staleFor)
    const initialCooldown = getStoreCooldownMs()
    if (initialCooldown > 0) {
      if (stale) return stale
      const seconds = Math.max(1, Math.ceil(initialCooldown / 1000))
      throw new StoreRequestError('store-rate-limited', `Store rate limit is active; retry in ${seconds}s`)
    }

    await reserveStoreRequestSlot(MIN_REQUEST_INTERVAL_MS)

    if (getStoreCooldownMs() > 0) {
      if (stale) return stale
      throw new StoreRequestError('store-rate-limited', 'Store rate limit is active')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      // Session.fetch (not net.fetch) so the store's cookies ride along.
      const response = await storeSession().fetch(target, {
        signal: controller.signal,
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' }
      })

      if (response.status === 429) {
        noteStoreRateLimit(response.headers.get('retry-after'))
        throw new StoreRequestError('store-rate-limited', '429 Too Many Requests')
      }

      if (!response.ok) {
        throw new StoreRequestError('store-http-error', `${response.status} ${response.statusText}`)
      }

      const finalUrl = new URL(response.url || target)
      if (finalUrl.protocol !== 'https:' || !isOnlineFixHost(finalUrl.hostname)) {
        throw new StoreRequestError('store-unavailable', 'Store redirected to an untrusted host')
      }
      const html = decodeBody(Buffer.from(await response.arrayBuffer()), response.headers.get('content-type'))
      writeCache(key, { url: target, html, fetchedAt: Date.now() }, scope === 'guest')
      return html
    } catch (err: any) {
      if (stale) {
        console.warn('[Store] Serving stale cached page after upstream failure:', err?.message || err)
        return stale
      }
      if (err instanceof StoreRequestError) throw err
      throw new StoreRequestError('store-unavailable', err?.message || String(err))
    } finally {
      clearTimeout(timer)
    }
  })()

  inFlight.set(key, request)
  try {
    return await request
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key)
  }
}

/**
 * An uncached store request. Comment threads use a full document so the form
 * reflects the current login; DLE's comment endpoints use AJAX. Both share
 * the store session, request gate and charset decoding.
 */
export async function requestStoreText(
  url: string,
  options?: { method?: 'GET' | 'POST'; body?: string; referer?: string; document?: boolean }
): Promise<string> {
  const target = new URL(url, STORE_HOME_URL).toString()
  if (new URL(target).protocol !== 'https:' || !isOnlineFixHost(new URL(target).hostname)) {
    throw new StoreRequestError('store-unavailable', `Refusing to fetch a host outside the store: ${target}`)
  }

  const cooldown = getStoreCooldownMs()
  if (cooldown > 0) {
    const seconds = Math.max(1, Math.ceil(cooldown / 1000))
    throw new StoreRequestError('store-rate-limited', `Store rate limit is active; retry in ${seconds}s`)
  }

  await reserveStoreRequestSlot(MIN_REQUEST_INTERVAL_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await storeSession().fetch(target, {
      method: options?.method || 'GET',
      body: options?.body,
      signal: controller.signal,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: options?.document ? 'text/html,application/xhtml+xml' : 'application/json, text/html, */*',
        // A full article is a normal navigation; only the comment endpoints are AJAX.
        ...(!options?.document ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        ...(options?.body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...(options?.referer ? { Referer: options.referer } : {})
      }
    })

    if (response.status === 429) {
      noteStoreRateLimit(response.headers.get('retry-after'))
      throw new StoreRequestError('store-rate-limited', '429 Too Many Requests')
    }

    if (!response.ok) {
      throw new StoreRequestError('store-http-error', `${response.status} ${response.statusText}`)
    }

    const finalUrl = new URL(response.url || target)
    if (finalUrl.protocol !== 'https:' || !isOnlineFixHost(finalUrl.hostname)) {
      throw new StoreRequestError('store-unavailable', 'Store redirected to an untrusted host')
    }

    return decodeBody(Buffer.from(await response.arrayBuffer()), response.headers.get('content-type'))
  } catch (err: any) {
    if (err instanceof StoreRequestError) throw err
    throw new StoreRequestError('store-unavailable', err?.message || String(err))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Drops one page from the cache.
 *
 * Used when the launcher itself is what changed that page — posting a comment —
 * so the next read shows the thread as it is now instead of the copy from
 * before, which the six-hour page cache would otherwise keep serving.
 */
export async function invalidateStorePage(url: string): Promise<void> {
  try {
    const target = new URL(url, STORE_HOME_URL).toString()
    const key = cacheKey(await cacheScope(), target)
    cache.delete(key)
    fs.rmSync(path.join(cacheDirectory(false), `${key}.json`), { force: true })
  } catch (err) {
    console.warn('[Store] Failed to invalidate cached page:', err)
  }
}

function listingUrl(page: number, query?: string): string {
  const trimmed = String(query || '').trim()
  if (trimmed) {
    // DLE search; results reuse the listing markup.
    const search = new URL('/index.php', STORE_HOME_URL)
    search.searchParams.set('do', 'search')
    search.searchParams.set('subaction', 'search')
    search.searchParams.set('story', trimmed)
    if (page > 1) search.searchParams.set('search_start', String(page))
    return search.toString()
  }

  return page > 1 ? new URL(`/page/${page}/`, STORE_HOME_URL).toString() : STORE_HOME_URL
}

export type StoreListingResult = StoreListing & {
  page: number
  query?: string
  sourceUrl: string
}

export async function getStoreListing(options?: {
  page?: number
  query?: string
  force?: boolean
}): Promise<StoreListingResult> {
  const page = Math.max(1, Number(options?.page) || 1)
  const query = String(options?.query || '').trim() || undefined
  const sourceUrl = listingUrl(page, query)

  const html = await fetchStoreHtml(sourceUrl, { force: options?.force })
  const listing = parseListing(html, sourceUrl)

  // The renderer cannot load these directly (see store/imageProxy).
  const items = listing.items.map((item) => ({ ...item, imageUrl: toStoreImageUrl(item.imageUrl) }))

  return { ...listing, items, page, query, sourceUrl }
}

export async function getStoreGame(url: string, options?: { force?: boolean }): Promise<StoreGameDetails> {
  const html = await fetchStoreHtml(url, { force: options?.force })
  return parseGamePage(html, new URL(url, STORE_HOME_URL).toString())
}

/**
 * Saves a page exactly as the site served it, so the parser can be developed
 * and tested against real markup. In development it lands in scripts/fixtures
 * (where the test script reads from); in a packaged build it goes to userData.
 */
export async function captureStoreFixture(url: string, name?: string): Promise<{ path: string; bytes: number }> {
  if (await cacheScope() !== 'guest') throw new Error('Sign out before capturing store fixtures')
  const html = await fetchStoreHtml(url, { force: true })

  const safeName = String(name || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  const fileName = `${safeName || `capture-${Date.now()}`}.html`
  const dir = app.isPackaged
    ? path.join(app.getPath('userData'), 'store-fixtures')
    : path.join(app.getAppPath(), 'scripts', 'fixtures')

  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, fileName)
  fs.writeFileSync(target, html, 'utf8')

  return { path: target, bytes: Buffer.byteLength(html, 'utf8') }
}

export function clearStoreCache() {
  cache.clear()
  try {
    fs.rmSync(cacheDirectory(false), { recursive: true, force: true })
  } catch (err) {
    console.warn('[Store] Failed to clear persistent page cache:', err)
  }
}
