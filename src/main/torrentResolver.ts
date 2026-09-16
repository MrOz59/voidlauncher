import axios from 'axios'
import * as cheerio from 'cheerio'
import path from 'path'
import { session } from 'electron'
import { isAllowedTorrentUrl } from '../shared/allowedHosts'

function cookiesToHeader(cookies: Electron.Cookie[]) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * Given a page that lists torrent files, return the first .torrent file URL (absolute).
 */
export async function resolveTorrentFileUrl(listingUrl: string, partition = 'persist:online-fix'): Promise<string> {
  console.log('[TorrentResolver] Resolving torrent from:', listingUrl)

  const base = new URL(listingUrl)
  if (!isAllowedTorrentUrl(listingUrl)) throw new Error('Untrusted torrent listing URL')
  const ses = session.fromPartition(partition)

  // Get cookies from both the torrent domain and main domain
  const torrentCookies = await ses.cookies.get({ url: base.origin })
  const mainCookies = await ses.cookies.get({ url: 'https://online-fix.me' })

  console.log('[TorrentResolver] Torrent domain cookies:', torrentCookies.map(c => c.name))
  console.log('[TorrentResolver] Main domain cookies:', mainCookies.map(c => c.name))

  // Combine cookies, preferring torrent domain cookies
  const allCookies = [...torrentCookies, ...mainCookies]
  const uniqueCookies = Array.from(new Map(allCookies.map(c => [c.name, c])).values())

  const cookieHeader = cookiesToHeader(uniqueCookies)

  console.log('[TorrentResolver] Using cookies from domains:', {
    torrentDomain: base.origin,
    mainDomain: 'https://online-fix.me',
    cookieCount: uniqueCookies.length,
    cookieNames: uniqueCookies.map(c => c.name)
  })
  console.log('[TorrentResolver] Cookie header length:', cookieHeader.length)

  if (uniqueCookies.length === 0) {
    throw new Error('Nenhum cookie encontrado. Voce precisa fazer login primeiro usando a janela de autenticacao.')
  }

  const resp = await axios.get(listingUrl, {
    maxRedirects: 0,
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://online-fix.me/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  })

  console.log('[TorrentResolver] Response status:', resp.status)

  const $ = cheerio.load(resp.data)
  // Pick first link that ends with .torrent
  const link = $('a[href$=".torrent"]').attr('href')
  if (!link) {
    console.error('[TorrentResolver] No .torrent file found. HTML:', resp.data.substring(0, 500))
    throw new Error('Nenhum arquivo .torrent encontrado na pagina de download')
  }

  const resolved = new URL(link, listingUrl).toString()
  if (!isAllowedTorrentUrl(resolved)) throw new Error('Untrusted torrent file URL')
  console.log('[TorrentResolver] Resolved torrent URL:', resolved)
  return resolved
}

export function deriveTitleFromTorrentUrl(torrentUrl: string): string {
  const parsed = new URL(torrentUrl)
  const baseName = path.basename(parsed.pathname)
  return baseName.replace(/\.torrent$/i, '').replace(/[_-]+/g, ' ')
}
