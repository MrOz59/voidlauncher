import fs from 'fs'
import path from 'path'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { isAllowedTorrentUrl } from '../shared/allowedHosts'

export {
  downloadTorrent,
  pauseTorrent,
  resumeTorrent,
  cancelTorrent,
  isTorrentActive,
  getActiveTorrentIds,
  getActiveTorrentSnapshots,
  type TorrentProgress
} from './torrentLibtorrentRpc'

export type HttpDownloadProgress = {
  percent: number
  downloaded: number
  total: number
  speed: number
  eta: number
}

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number, details?: HttpDownloadProgress) => void,
  headers?: Record<string, string>
) {
  if (headers?.Cookie && !isAllowedTorrentUrl(url)) throw new Error('Refusing to send store cookies to an untrusted URL')
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const partialPath = `${destPath}.part`
  const startedAt = Date.now()
  let writer: fs.WriteStream | null = null

  try {
    try { fs.rmSync(partialPath, { force: true }) } catch {}

    const res = await axios.get(url, {
      responseType: 'stream',
      headers: headers || {},
      timeout: 30000,
      maxRedirects: headers?.Cookie ? 0 : 5,
      validateStatus: status => status >= 200 && status < 300
    })
    const total = parseInt(String(res.headers['content-length'] || '0'), 10)

    writer = fs.createWriteStream(partialPath)
    let loaded = 0
    let lastEmitAt = 0

    res.data.on('data', (chunk: any) => {
      loaded += chunk.length
      if (!onProgress || total <= 0) return

      const now = Date.now()
      if (now - lastEmitAt < 250 && loaded < total) return
      lastEmitAt = now

      const elapsed = Math.max(0.001, (now - startedAt) / 1000)
      const speed = loaded / elapsed
      const remaining = Math.max(0, total - loaded)
      const eta = speed > 0 ? remaining / speed : 0
      const percent = Math.max(0, Math.min(100, (loaded / total) * 100))
      onProgress(percent, { percent, downloaded: loaded, total, speed, eta })
    })

    await new Promise<void>((resolve, reject) => {
      res.data.on('error', reject)
      writer?.on('finish', resolve)
      writer?.on('error', reject)
      res.data.pipe(writer as fs.WriteStream)
    })

    try { fs.rmSync(destPath, { force: true }) } catch {}
    fs.renameSync(partialPath, destPath)
    if (onProgress && total > 0) {
      onProgress(100, { percent: 100, downloaded: total, total, speed: 0, eta: 0 })
    }
  } catch (err) {
    try { writer?.destroy() } catch {}
    try { fs.rmSync(partialPath, { force: true }) } catch {}
    throw err
  }
}

/**
 * Scrapes torrent directory page and downloads the .torrent file
 * Example URL: https://uploads.online-fix.me:2053/torrents/Ultimate%20Sheep%20Raccoon/
 */
export async function downloadTorrentFromDirectory(directoryUrl: string, cookieHeader?: string): Promise<string> {
  if (cookieHeader && !isAllowedTorrentUrl(directoryUrl)) throw new Error('Untrusted torrent listing URL')
  console.log('[Torrent Downloader] Scraping directory:', directoryUrl)

  // Fetch the directory listing HTML
  const response = await axios.get(directoryUrl, {
    maxRedirects: cookieHeader ? 0 : 5,
    headers: cookieHeader ? { Cookie: cookieHeader } : {}
  })

  const $ = cheerio.load(response.data)

  // Find .torrent file link in the directory listing
  let torrentFileName: string | null = null

  // Try to find <a> tag with .torrent extension
  $('a').each((_, el) => {
    const href = $(el).attr('href')
    if (href && href.endsWith('.torrent')) {
      torrentFileName = href
      return false // break
    }
  })

  if (!torrentFileName) {
    throw new Error('No .torrent file found in directory')
  }

  // Construct full torrent URL
  const torrentUrl = new URL(torrentFileName, directoryUrl).toString()
  if (!isAllowedTorrentUrl(torrentUrl)) throw new Error('Untrusted torrent file URL')
  console.log('[Torrent Downloader] Found torrent file:', torrentUrl)

  // Download .torrent file to temp directory
  const tempDir = path.join(process.cwd(), 'temp-torrents')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const torrentFilePath = path.join(tempDir, path.basename(torrentFileName))

  await downloadFile(torrentUrl, torrentFilePath)
  console.log('[Torrent Downloader] Downloaded .torrent file to:', torrentFilePath)

  return torrentFilePath
}
