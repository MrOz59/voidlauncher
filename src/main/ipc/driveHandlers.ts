/**
 * IPC Handlers for Google Drive and Cloud Saves
 */
import { shell } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import fs from 'fs'
import path from 'path'
import * as drive from '../drive'
import * as cloudSaves from '../cloudSaves'
import { appendCloudSavesHistory, listCloudSavesHistory, type CloudSavesHistoryEntry } from '../cloudSavesHistory'
import { ensureLudusaviAvailable } from '../ludusavi'
import { getGame } from '../db'
import type { IpcContext, IpcHandlerRegistrar, CloudSavesStatusPayload } from './types'

function recordCloudSaves(entry: CloudSavesHistoryEntry) {
  try {
    appendCloudSavesHistory(entry)
  } catch {
    // ignore
  }
}

export const registerDriveHandlers: IpcHandlerRegistrar = (ctx: IpcContext) => {
  ipcMain.handle('drive-auth', async () => {
    const res = await drive.authenticateWithDrive()

    // After Drive is configured, proactively ensure Ludusavi is available so
    // cloud-saves can work immediately without user installing anything.
    if ((res as any)?.success) {
      try {
        const ensured = await ensureLudusaviAvailable({ allowDownload: true, timeoutMs: 120_000 })
        if (!ensured.ok) {
          console.warn('[LUDUSAVI] prepare failed after drive-auth:', ensured.message)
          return { ...(res as any), ludusaviPrepared: false, ludusaviError: ensured.message }
        }
        return { ...(res as any), ludusaviPrepared: true, ludusaviPath: ensured.path, ludusaviDownloaded: ensured.downloaded }
      } catch (e: any) {
        console.warn('[LUDUSAVI] prepare error after drive-auth:', e)
        return { ...(res as any), ludusaviPrepared: false, ludusaviError: e?.message || String(e) }
      }
    }

    return res
  })

  ipcMain.handle('drive-status', async () => {
    try {
      const connected = drive.isDriveConfigured()
      return { success: true, connected }
    } catch (e: any) {
      return { success: false, connected: false, message: e?.message || String(e) }
    }
  })

  ipcMain.handle('drive-disconnect', async () => {
    const res = drive.clearToken()
    if (res.success) return { success: true }
    return { success: false, message: res.message || 'Falha ao desconectar' }
  })

  ipcMain.handle('drive-list-saves', async () => {
    const res = await drive.listSaves()
    return res
  })

  ipcMain.handle('drive-list-saves-for-game', async (_event, realAppId?: string) => {
    const res = await drive.listSaves(realAppId)
    return res
  })

  ipcMain.handle('drive-get-credentials', async () => {
    return { success: false, message: 'Credenciais oficiais via PKCE. Não há arquivo local.' }
  })

  ipcMain.handle('drive-open-credentials', async () => {
    return { success: false, message: 'Credenciais oficiais via PKCE. Não há arquivo local.' }
  })

  ipcMain.handle('drive-upload-save', async (_event, localPath: string, remoteName?: string) => {
    const res = await drive.uploadSave(localPath, remoteName)
    return res
  })

  ipcMain.handle('drive-download-save', async (_event, fileId: string, destPath: string) => {
    const res = await drive.downloadSave(fileId, destPath)
    return res
  })

  ipcMain.handle('drive-backup-saves', async (_event, options: any) => {
    try {
      const gameUrl = String(options?.gameUrl || '').trim()
      const game = gameUrl ? (getGame(gameUrl) as any) : null
      const res = await cloudSaves.backupCloudSavesAfterExit({
        gameUrl: gameUrl || undefined,
        title: String(options?.title || game?.title || ''),
        steamAppId: (options?.steamAppId || game?.steam_app_id || null) as any,
        protonPrefix: (options?.protonPrefix || game?.proton_prefix || null) as any
      })
      if (res?.success && !(res as any)?.skipped) return { success: true }

      // Fallback: legacy OnlineFix folder backup
      return await drive.backupLocalSavesToDrive(options || {})
    } catch (e: any) {
      return { success: false, message: e?.message || String(e) }
    }
  })

  ipcMain.handle('drive-sync-saves-on-playstart', async (_event, options: any) => {
    try {
      const gameUrl = String(options?.gameUrl || '').trim()
      const game = gameUrl ? (getGame(gameUrl) as any) : null
      const gameKey = cloudSaves.computeCloudSavesGameKey({
        gameUrl: gameUrl || undefined,
        title: String(options?.title || game?.title || ''),
        steamAppId: (options?.steamAppId || game?.steam_app_id || null) as any,
        protonPrefix: (options?.protonPrefix || game?.proton_prefix || null) as any
      })
      ctx.sendCloudSavesStatus({ at: Date.now(), gameUrl: gameUrl || undefined, gameKey, stage: 'restore', level: 'info', message: 'Verificando saves na nuvem...' })
      const restoreRes = await cloudSaves.restoreCloudSavesBeforeLaunch({
        gameUrl: gameUrl || undefined,
        title: String(options?.title || game?.title || ''),
        steamAppId: (options?.steamAppId || game?.steam_app_id || null) as any,
        protonPrefix: (options?.protonPrefix || game?.proton_prefix || null) as any
      })
      if (restoreRes?.success && !(restoreRes as any)?.skipped) {
        const msg = String(restoreRes?.message || 'Saves restaurados da nuvem.')
        recordCloudSaves({ at: Date.now(), gameKey, gameUrl: gameUrl || undefined, stage: 'restore', level: 'success', message: msg })
        ctx.sendCloudSavesStatus({ at: Date.now(), gameUrl: gameUrl || undefined, gameKey, stage: 'restore', level: 'success', message: msg })
        return { success: true, message: restoreRes.message }
      }

      if (restoreRes?.success && (restoreRes as any)?.skipped) {
        const msg = String(restoreRes?.message || 'Saves locais já estão atualizados.')
        recordCloudSaves({ at: Date.now(), gameKey, gameUrl: gameUrl || undefined, stage: 'restore', level: 'info', message: msg })
        ctx.sendCloudSavesStatus({ at: Date.now(), gameUrl: gameUrl || undefined, gameKey, stage: 'restore', level: 'info', message: msg })
      }

      // Fallback: legacy OnlineFix folder sync
      return await drive.syncSavesOnPlayStart(options || {})
    } catch (e: any) {
      return { success: false, message: e?.message || String(e) }
    }
  })

  ipcMain.handle('cloud-saves-get-history', async (_event, payload?: { gameUrl?: string; limit?: number }) => {
    try {
      const gameUrl = String(payload?.gameUrl || '').trim()
      const game = gameUrl ? (getGame(gameUrl) as any) : null
      const gameKey = cloudSaves.computeCloudSavesGameKey({
        gameUrl: gameUrl || undefined,
        title: String(game?.title || ''),
        steamAppId: (game?.steam_app_id || null) as any,
        protonPrefix: (game?.proton_prefix || null) as any
      })
      const list = listCloudSavesHistory({ gameKey, limit: payload?.limit })
      return { success: true, gameKey, history: list }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('cloud-saves-open-backups', async (_event, payload?: { gameUrl?: string }) => {
    try {
      const gameUrl = String(payload?.gameUrl || '').trim()
      const game = gameUrl ? (getGame(gameUrl) as any) : null
      const dir = cloudSaves.getLocalLudusaviBackupDir({
        gameUrl: gameUrl || undefined,
        title: String(game?.title || ''),
        steamAppId: (game?.steam_app_id || null) as any,
        protonPrefix: (game?.proton_prefix || null) as any
      })
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      const r = await shell.openPath(dir)
      if (r) return { success: false, error: r }
      return { success: true, path: dir }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  })

  // Synchronous trigger for a manual per-game save sync (compare remote vs local and download/upload)
  ipcMain.handle('drive-sync-game-saves', async (_event, arg: any) => {
    console.log('[DRIVE-SYNC] Chamada recebida. Argumento:', arg)
    try {
      let options = arg

      // Se o frontend enviou apenas a URL (string), hidratamos os dados
      if (typeof arg === 'string') {
        const gameUrl = arg
        console.log(`[DRIVE-SYNC] Argumento é URL. Buscando jogo: ${gameUrl}`)

        const game = getGame(gameUrl) as any

        if (!game) {
          console.error(`[DRIVE-SYNC] Jogo não encontrado para URL: ${gameUrl}`)
          return { success: false, message: 'Jogo não encontrado no banco de dados.' }
        }

        // Resolve the absolute path if needed.
        let installPath = game.install_path
        if (installPath && !path.isAbsolute(installPath)) {
          installPath = path.resolve(process.cwd(), installPath)
        }

        options = {
          installPath: installPath,
          protonPrefix: game.proton_prefix,
          realAppId: game.steam_app_id || undefined
        }

        console.log('[DRIVE-SYNC] Dados do jogo resolvidos (RealAppId agora é steam_app_id ou undefined):', options)
      }

      // Prefer Ludusavi-based sync; fallback to legacy OnlineFix sync.
      try {
        const gameUrl = typeof arg === 'string' ? arg : String(options?.gameUrl || '').trim()
        const game = gameUrl ? (getGame(gameUrl) as any) : null
        const res = await cloudSaves.syncCloudSavesManual({
          gameUrl: gameUrl || undefined,
          title: String(options?.title || game?.title || ''),
          steamAppId: (options?.steamAppId || game?.steam_app_id || null) as any,
          protonPrefix: (options?.protonPrefix || game?.proton_prefix || null) as any
        })
        console.log('[DRIVE-SYNC] Resultado final (Ludusavi):', res)
        if (res?.success) return res
      } catch (e) {
        console.warn('[DRIVE-SYNC] Ludusavi sync failed; falling back:', e)
      }

      const legacy = await drive.syncSavesOnPlayStart(options || {})
      console.log('[DRIVE-SYNC] Resultado final (legacy):', legacy)
      return legacy
    } catch (e: any) {
      console.error('[DRIVE-SYNC] Erro inesperado na chamada principal:', e)
      return { success: false, message: e?.message || String(e) }
    }
  })

  ipcMain.handle('drive-save-credentials', async (_event, rawJson: string) => {
    return { success: false, message: 'Credenciais oficiais via PKCE. Não é necessário salvar JSON.' }
  })
}
