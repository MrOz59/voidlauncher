/**
 * IPC Handlers for Google Drive and Cloud Saves
 */
import { shell, dialog } from 'electron'
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

      // A skipped/newer/conflicted snapshot must NOT be restored again through
      // the legacy path, which cannot compare authoritative save timestamps.
      return restoreRes
    } catch (e: any) {
      return { success: false, message: e?.message || String(e) }
    }
  })

  const gameSaveOptions = (gameUrl: unknown) => {
    if (typeof gameUrl !== 'string' || !gameUrl.trim()) throw new Error('Jogo inválido.')
    const game = getGame(gameUrl.trim()) as any
    if (!game) throw new Error('Jogo não encontrado na biblioteca.')
    return {
      gameUrl: gameUrl.trim(),
      title: String(game.title || ''),
      steamAppId: game.steam_app_id || null,
      protonPrefix: game.proton_prefix || null,
      gameInstallPath: game.install_path || null
    }
  }

  ipcMain.handle('cloud-saves-game-overview', async (_event, gameUrl: string) => {
    try {
      const overview = await cloudSaves.getGameSaveOverview(gameSaveOptions(gameUrl))
      return { success: true, overview }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-add-folder', async (_event, gameUrl: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      const selected = await dialog.showOpenDialog({
        title: 'Selecione a pasta específica dos saves deste jogo',
        properties: ['openDirectory']
      })
      if (selected.canceled || !selected.filePaths?.[0]) return { success: true, canceled: true }
      cloudSaves.addCustomSaveLocation(cloudSaves.computeCloudSavesGameKey(options), selected.filePaths[0])
      return { success: true, message: 'Pasta de saves adicionada para este jogo.' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-remove-folder', async (_event, gameUrl: string, folder: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      const gameKey = cloudSaves.computeCloudSavesGameKey(options)
      if (typeof folder !== 'string' || !cloudSaves.getCustomSaveLocations(gameKey).includes(folder)) {
        return { success: false, error: 'Esta pasta não está configurada para o jogo.' }
      }
      cloudSaves.removeCustomSaveLocation(gameKey, folder)
      return { success: true, message: 'Pasta removida da detecção. Nenhum arquivo foi apagado.' }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-backup', async (_event, gameUrl: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      if (ctx.runningGames.has(gameUrl)) return { success: false, error: 'Feche o jogo antes de criar um backup consistente.' }
      if (!drive.isCloudSavesEnabled()) return { success: false, error: 'Conecte o Drive e ative Cloud Saves nas configurações.' }
      const result = await cloudSaves.backupCloudSavesAfterExit(options)
      return { success: result.success, message: result.message, error: result.success ? undefined : result.message }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-restore', async (_event, gameUrl: string, fileId: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      if (ctx.runningGames.has(gameUrl)) return { success: false, error: 'Feche o jogo antes de restaurar saves.' }
      if (typeof fileId !== 'string' || !fileId.trim()) return { success: false, error: 'Backup inválido.' }
      const backup = await cloudSaves.getGameBackupById(options, fileId)
      if (!backup || !backup.restorable) return { success: false, error: 'Este backup não é restaurável ou pertence a outro jogo.' }
      const result = await cloudSaves.restoreCloudSavesBeforeLaunch(options, fileId)
      if (result.success && !result.skipped) {
        const gameKey = cloudSaves.computeCloudSavesGameKey(options)
        const entry = { at: Date.now(), gameKey, gameUrl, stage: 'restore' as const,
          level: 'success' as const, message: result.message || 'Save restaurado pelo usuário.' }
        recordCloudSaves(entry)
        ctx.sendCloudSavesStatus(entry)
      }
      return { success: result.success, skipped: result.skipped, message: result.message, error: result.success ? undefined : result.message }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-export', async (_event, gameUrl: string, fileId: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      const backup = await cloudSaves.getGameBackupById(options, fileId)
      if (!backup) return { success: false, error: 'Backup não encontrado para este jogo.' }
      const choice = await dialog.showSaveDialog({
        title: 'Salvar cópia do backup',
        defaultPath: backup.name,
        filters: [{ name: 'Backup ZIP', extensions: ['zip'] }]
      })
      if (choice.canceled || !choice.filePath) return { success: true, canceled: true }
      const result = await drive.downloadSave(fileId, choice.filePath)
      return { success: result.success, error: result.success ? undefined : result.message, path: result.success ? choice.filePath : undefined }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('cloud-saves-game-delete-backup', async (_event, gameUrl: string, fileId: string) => {
    try {
      const options = gameSaveOptions(gameUrl)
      const backup = await cloudSaves.getGameBackupById(options, fileId)
      if (!backup) return { success: false, error: 'Backup não encontrado para este jogo.' }
      const overview = await cloudSaves.getGameSaveOverview(options)
      if (backup.restorable && backup.role === 'main' &&
        overview.backups.filter(b => b.restorable && b.role === 'main').length <= 1) {
        return { success: false, error: 'O último backup principal deste jogo foi preservado. Exporte uma cópia antes de removê-lo.' }
      }
      const choice = await dialog.showMessageBox({
        type: 'warning', title: 'Excluir backup do Drive?',
        message: `Excluir definitivamente "${backup.name}"?`,
        detail: 'O arquivo será removido do Google Drive. Saves locais não serão alterados.',
        buttons: ['Cancelar', 'Excluir backup'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (choice.response !== 1) return { success: true, canceled: true }
      // Recheck ownership immediately before deletion.
      if (!await cloudSaves.getGameBackupById(options, fileId)) {
        return { success: false, error: 'Backup não pertence mais a este jogo.' }
      }
      const removed = await drive.deleteFile(fileId)
      return { success: removed.success, error: removed.success ? undefined : removed.message }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
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

      // Versioned cloud-save sync is authoritative. No legacy overwrite fallback.
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

      return { success: false, message: 'Cloud Saves não conseguiu sincronizar. Saves locais preservados.' }
    } catch (e: any) {
      console.error('[DRIVE-SYNC] Erro inesperado na chamada principal:', e)
      return { success: false, message: e?.message || String(e) }
    }
  })

  ipcMain.handle('drive-save-credentials', async (_event, rawJson: string) => {
    return { success: false, message: 'Credenciais oficiais via PKCE. Não é necessário salvar JSON.' }
  })
}
