/**
 * IPC Handlers for Downloads
 */
import { type IpcMainInvokeEvent } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import fs from 'fs'
import path from 'path'
import { downloadFile, downloadTorrent } from '../downloader'
import {
  getActiveDownloads,
  getCompletedDownloads,
  getDownloadById,
  getDownloadByUrl,
  deleteDownload,
  addOrUpdateGame,
  markGameInstalled,
  updateGameInfo
} from '../db'
import {
  pauseDownloadByTorrentId,
  resumeDownloadByTorrentId,
  cancelDownloadByTorrentId,
  readOnlineFixIni,
  writeOnlineFixIni,
  processUpdateExtraction,
  normalizeGameInstallDir,
  getDownloadQueueStatus,
  reconcileDownloadState,
  prioritizeDownload,
  removeFromQueue,
  swapActiveDownload,
  hasExistingGameInstall
} from '../downloadManager'
import { extractZipWithPassword } from '../zip'
import { getStoreGame } from '../store/catalog'
import { bareExecutableName, findArchive, findExecutableInDir } from '../utils'
import { sanitizeVersionText, isKnownUnknownVersion } from '../utils/versionUtils'
import type { IpcContext, IpcHandlerRegistrar } from './types'

// Helper to resolve game version
async function resolveGameVersion(options: {
  providedVersion?: string | null
  filename?: string | null
  title?: string | null
  gameUrl?: string | null
}): Promise<string> {
  const { providedVersion, filename, title } = options
  const { parseVersionFromName } = await import('../downloadManager')

  if (!isKnownUnknownVersion(providedVersion)) {
    const sanitized = sanitizeVersionText(providedVersion)
    if (sanitized) return sanitized
  }

  if (filename) {
    const fromFilename = parseVersionFromName(filename)
    if (fromFilename) return fromFilename
  }

  if (title) {
    const fromTitle = parseVersionFromName(title)
    if (fromTitle) return fromTitle
  }

  return 'unknown'
}

export const registerDownloadHandlers: IpcHandlerRegistrar = (ctx: IpcContext) => {
  ipcMain.handle('download-http', async (_event: IpcMainInvokeEvent, url: string, destPath: string) => {
    try {
      await downloadFile(url, destPath, (p, details) => {
        ctx.sendDownloadProgress({
          url,
          progress: p,
          speed: details?.speed,
          downloaded: details?.downloaded,
          total: details?.total,
          eta: details?.eta,
          stage: 'download'
        })
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('download-torrent', async (_event: IpcMainInvokeEvent, magnet: string, destPath: string) => {
    try {
      await downloadTorrent(magnet, destPath, (p, details) => {
        ctx.sendDownloadProgress({
          magnet,
          progress: p,
          speed: details?.downloadSpeed || 0,
          downloaded: details?.downloaded || 0,
          total: details?.total || 0,
          eta: details?.timeRemaining || 0,
          peers: details?.peers,
          seeds: details?.seeds,
          statusMessage: details?.statusMessage,
          agentState: details?.state,
          hasMetadata: details?.hasMetadata,
          infoHash: details?.infoHash || magnet,
          stage: 'download'
        })
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('pause-download', async (_event: IpcMainInvokeEvent, torrentId: string) => {
    try {
      const success = await pauseDownloadByTorrentId(torrentId)
      return { success }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('resume-download', async (_event: IpcMainInvokeEvent, torrentId: string) => {
    try {
      const success = await resumeDownloadByTorrentId(torrentId)
      return { success }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('cancel-download', async (_event: IpcMainInvokeEvent, torrentId: string) => {
    try {
      const success = await cancelDownloadByTorrentId(torrentId)
      return { success }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-active-downloads', async () => {
    try {
      reconcileDownloadState('get-active-downloads')
      const downloads = getActiveDownloads()
      return { success: true, downloads }
    } catch (err: any) {
      return { success: false, error: err.message, downloads: [] }
    }
  })

  ipcMain.handle('get-completed-downloads', async () => {
    try {
      const downloads = getCompletedDownloads()
      return { success: true, downloads }
    } catch (err: any) {
      return { success: false, error: err.message, downloads: [] }
    }
  })

  ipcMain.handle('delete-download', async (_event, downloadId: number) => {
    try {
      deleteDownload(downloadId)
      ctx.getMainWindow()?.webContents.send('download-deleted')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('get-onlinefix-ini', async (_event, gameUrl: string) => {
    try {
      return await readOnlineFixIni(gameUrl)
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao ler OnlineFix.ini' }
    }
  })

  ipcMain.handle('save-onlinefix-ini', async (_event, gameUrl: string, content: string) => {
    try {
      return await writeOnlineFixIni(gameUrl, content)
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao salvar OnlineFix.ini' }
    }
  })

  ipcMain.handle('extract-download', async (_event, downloadId: number | string, providedPath?: string) => {
    try {
      const asNumber = Number(downloadId)
      const record = !Number.isNaN(asNumber) ? getDownloadById(asNumber) as any : getDownloadByUrl(String(downloadId)) as any
      const candidatePath = providedPath || record?.install_path || record?.dest_path
      if (!candidatePath) return { success: false, error: 'Path not provided', errorCode: 'path-missing' }

      const infoHash = record?.info_hash
      const idKey = infoHash || record?.download_url || String(downloadId)
      const gameUrl = record?.game_url || record?.download_url || idKey

      // Resolve base dir/filename
      const target = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(process.cwd(), candidatePath)

      // For torrent downloads (type === 'torrent'), use processUpdateExtraction
      if (record?.type === 'torrent') {
        console.log('[Extract] Using processUpdateExtraction for torrent:', target)
        const firstInstall = !hasExistingGameInstall(gameUrl, target)

        // Notify start
        ctx.sendDownloadProgress({
          magnet: idKey,
          url: idKey,
          progress: 0,
          stage: 'extract',
          extractProgress: 0,
          destPath: target
        })

        const result = await processUpdateExtraction(target, gameUrl, (percent, details) => {
          ctx.sendDownloadProgress({
            magnet: idKey,
            url: idKey,
            progress: percent,
            stage: 'extract',
            extractProgress: percent,
            eta: details?.etaSeconds,
            destPath: target
          })
        })

        if (!result.success) {
          return { success: false, error: result.error || 'Extraction failed' }
        }

        ctx.getMainWindow()?.webContents.send('download-complete', {
          magnet: idKey,
          infoHash: infoHash || undefined,
          destPath: target
        })

        // Update game info
        if (gameUrl) {
          const version = await resolveGameVersion({
            filename: candidatePath,
            title: record?.title,
            gameUrl
          })
          addOrUpdateGame(gameUrl, record?.title)
          markGameInstalled(gameUrl, target, version, result.executablePath || undefined)
          try {
            const markerPath = path.join(target, '.of_game.json')
            const next = {
              url: gameUrl,
              title: record?.title || undefined,
              status: 'installed',
              showInLibrary: true,
              installPath: target,
              version,
              executablePath: result.executablePath || null,
              updatedAt: Date.now()
            }
            fs.writeFileSync(markerPath, JSON.stringify(next, null, 2))
          } catch {
            // ignore
          }
          // Auto-fetch banner once installed
          ctx.fetchAndPersistBanner(gameUrl, String(record?.title || gameUrl)).catch(() => {})
          ctx.notifyGameReadyAfterInstall(gameUrl, String(record?.title || gameUrl), target, firstInstall).catch(() => {})
        }

        // Clean up download record from database
        if (record?.id) {
          try {
            deleteDownload(Number(record.id))
            ctx.getMainWindow()?.webContents.send('download-deleted')
            console.log('[Extract] Cleaned up download record after successful torrent extraction')
          } catch {}
        }

        return { success: true, destPath: target }
      }

      // For HTTP downloads, use the standard extraction flow
      const { archivePath, destDir } = findArchive(target)
      if (!archivePath) {
        return { success: false, error: 'Nenhum arquivo .zip/.rar/.7z encontrado para extrair', errorCode: 'no-archive-to-extract' }
      }
      const firstInstall = !hasExistingGameInstall(gameUrl, destDir)

      // Prevent deletion while extracting
      const extractionLockFile = path.join(destDir, '.extracting')
      try { fs.writeFileSync(extractionLockFile, 'extracting') } catch {}

      // Notify start
      ctx.sendDownloadProgress({
        magnet: idKey,
        url: idKey,
        progress: 0,
        stage: 'extract',
        extractProgress: 0,
        destPath: destDir
      })

      console.log('[Extract] Dispatching extraction for', archivePath, '->', destDir)

      try {
        await extractZipWithPassword(
          archivePath,
          destDir,
          undefined,
          (percent) => {
            ctx.sendDownloadProgress({
              magnet: idKey,
              url: idKey,
              progress: percent,
              stage: 'extract',
              extractProgress: percent,
              destPath: destDir
            })
          }
        )
      } catch (extractErr: any) {
        console.error('[Extract] Failed extraction', extractErr)
        try { fs.unlinkSync(extractionLockFile) } catch {}
        return { success: false, error: extractErr?.message || String(extractErr) }
      }

      console.log('[Extract] Extraction finished, deleting archive')
      // Delete archive after extraction
      try {
        fs.unlinkSync(archivePath)
      } catch {
        // ignore
      }

      // Normalize extracted content
      try {
        normalizeGameInstallDir(destDir)
      } catch {
        // ignore
      }

      try { fs.unlinkSync(extractionLockFile) } catch {}

      ctx.getMainWindow()?.webContents.send('download-complete', {
        magnet: idKey,
        infoHash: infoHash || undefined,
        destPath: destDir
      })

      // Add to library after extraction
      if (gameUrl) {
        // The page's own steps name the binary to run, and for these fixes that
        // is the patched one — which the folder scan, going by size and naming,
        // regularly passes over. Best-effort: a cold page cache or a rate limit
        // must never hold up an install that has already finished.
        const launchHint = await getStoreGame(gameUrl)
          .then((game) => bareExecutableName(game.launchExecutable))
          .catch(() => null)

        const exePath = findExecutableInDir(destDir, { prefer: launchHint })
        const version = await resolveGameVersion({
          filename: archivePath,
          title: record?.title,
          gameUrl
        })
        addOrUpdateGame(gameUrl, record?.title)
        markGameInstalled(gameUrl, destDir, version, exePath || undefined)
        // Kept for the repair and launch paths, which run long after this and
        // often with no network to ask the page again.
        if (launchHint) updateGameInfo(gameUrl, { launch_executable: launchHint })
        try {
          const markerPath = path.join(destDir, '.of_game.json')
          const next = {
            url: gameUrl,
            title: record?.title || undefined,
            status: 'installed',
            showInLibrary: true,
            installPath: destDir,
            version,
            executablePath: exePath || null,
            updatedAt: Date.now()
          }
          fs.writeFileSync(markerPath, JSON.stringify(next, null, 2))
        } catch {
          // ignore
        }
        // Auto-fetch banner once installed
        ctx.fetchAndPersistBanner(gameUrl, String(record?.title || gameUrl)).catch(() => {})
        ctx.notifyGameReadyAfterInstall(gameUrl, String(record?.title || gameUrl), destDir, firstInstall).catch(() => {})
      }

      // Clean up download record from database
      if (record?.id) {
        try {
          deleteDownload(Number(record.id))
          ctx.getMainWindow()?.webContents.send('download-deleted')
          console.log('[Extract] Cleaned up download record after successful HTTP extraction')
        } catch {}
      }

      return { success: true, destPath: destDir }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ============================================================================
  // DOWNLOAD QUEUE HANDLERS
  // ============================================================================

  ipcMain.handle('get-download-queue-status', async () => {
    try {
      reconcileDownloadState('get-download-queue-status')
      const status = getDownloadQueueStatus()
      return { success: true, status }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reconcile-downloads', async () => {
    try {
      const result = reconcileDownloadState('ipc')
      return { success: true, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('prioritize-download', async (_event: IpcMainInvokeEvent, queueId: string) => {
    try {
      const result = prioritizeDownload(queueId)
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remove-from-queue', async (_event: IpcMainInvokeEvent, queueId: string) => {
    try {
      const result = removeFromQueue(queueId)
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('swap-active-download', async (_event: IpcMainInvokeEvent, queueId: string) => {
    try {
      const result = swapActiveDownload(queueId)
      return result
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
