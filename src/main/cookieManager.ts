import { app, session } from 'electron'
import fs from 'fs'
import path from 'path'
import { isOnlineFixHost } from '../shared/allowedHosts'

const STORE_PARTITION = 'persist:online-fix'
const MAX_LEGACY_FILE_BYTES = 4 * 1024 * 1024

function cookieFilePath(): string {
  return path.join(app.getPath('userData'), 'cookies.json')
}

function isStoreCookie(cookie: unknown): cookie is Electron.Cookie & { domain: string } {
  if (!cookie || typeof cookie !== 'object') return false
  const value = cookie as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name || typeof value.value !== 'string') return false
  if (typeof value.domain !== 'string') return false
  return isOnlineFixHost(value.domain.replace(/^\./, ''))
}

function cookieUrl(cookie: Electron.Cookie & { domain: string }): string {
  const host = cookie.domain.replace(/^\./, '')
  const cookiePath = cookie.path?.startsWith('/') ? cookie.path : '/'
  return `https://${host}${cookiePath}`
}

/** Migrate the old plaintext export into Electron's persistent store partition. */
export async function migrateLegacyCookies(): Promise<void> {
  const file = cookieFilePath()
  let legacy: unknown
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_LEGACY_FILE_BYTES) {
      console.warn('[Cookies] Legacy cookie file is not a regular, supported file')
      return
    }
    legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(legacy)) throw new Error('Invalid legacy cookie format')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.warn('[Cookies] Could not read legacy cookie file:', error?.message || error)
    return
  }

  const store = session.fromPartition(STORE_PARTITION)
  try {
    const existing = await store.cookies.get({})
    const keys = new Set(existing.map((cookie) => `${cookie.name}|${cookie.domain}|${cookie.path}`))
    for (const cookie of legacy.filter(isStoreCookie)) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`
      if (keys.has(key)) continue
      if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) continue
      await store.cookies.set({
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate
      })
      keys.add(key)
    }
    await store.cookies.flushStore()
    fs.unlinkSync(file)
    console.log('[Cookies] Legacy plaintext cookie file migrated and removed')
  } catch (error: any) {
    console.warn('[Cookies] Migration incomplete; keeping legacy file:', error?.message || error)
  }
}

/** Used only by main-process requests to the store. */
export async function getCookieHeaderForUrl(rawUrl: string): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid store URL')
  }
  if (url.protocol !== 'https:' || !isOnlineFixHost(url.hostname)) {
    throw new Error('Cookie header is restricted to HTTPS store URLs')
  }
  const cookies = await session.fromPartition(STORE_PARTITION).cookies.get({ url: url.toString() })
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

export async function clearCookiesAndFile(): Promise<void> {
  const store = session.fromPartition(STORE_PARTITION)
  await store.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
  // Older versions also copied store cookies into the default session.
  const oldCookies = await session.defaultSession.cookies.get({})
  for (const cookie of oldCookies.filter(isStoreCookie)) {
    await session.defaultSession.cookies.remove(cookieUrl(cookie), cookie.name)
  }
  try {
    fs.unlinkSync(cookieFilePath())
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
}
