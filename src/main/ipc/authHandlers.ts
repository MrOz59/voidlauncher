/**
 * IPC Handlers for Authentication and Cookies
 */
import { session } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import { fetchUserProfile, fetchGameUpdateInfo } from '../scraper'
import { updateGameInfo } from '../db'
import { STORE_HOME_URL } from '../../shared/allowedHosts'
import type { IpcContext, IpcHandlerRegistrar } from './types'

const TORRENT_PARTITION = 'persist:online-fix'

export const registerAuthHandlers: IpcHandlerRegistrar = (ctx: IpcContext) => {
  // Note: open-auth-window handler needs to be registered in main.ts
  // because it requires access to createAuthWindow function

  ipcMain.handle('get-user-profile', async () => {
    const profile = await fetchUserProfile()
    if (profile.name || profile.avatar) return { success: true, ...profile }
    return { success: false, error: 'Perfil não encontrado', ...profile }
  })

  ipcMain.handle('get-store-login-status', async () => {
    const cookies = await session.fromPartition(TORRENT_PARTITION).cookies.get({ url: STORE_HOME_URL })
    const names = new Set(cookies.filter((cookie) => cookie.value).map((cookie) => cookie.name.toLowerCase()))
    return names.has('dle_user_id') && names.has('dle_password')
  })

  ipcMain.handle('clear-cookies', async () => {
    try {
      const cm = await import('../cookieManager')
      await cm.clearCookiesAndFile()

      ctx.getMainWindow()?.webContents.send('cookies-cleared')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao limpar cookies' }
    }
  })

  ipcMain.handle('check-game-version', async (_event, url: string) => {
    try {
      const info = await fetchGameUpdateInfo(url)
      if (!info.version) throw new Error('Versao nao encontrada na pagina')
      return { success: true, version: info.version, torrentUrl: info.torrentUrl }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('fetch-game-update-info', async (_event, url: string) => {
    try {
      const info = await fetchGameUpdateInfo(url)
      if (info.version) updateGameInfo(url, { latest_version: info.version })
      if (info.torrentUrl) {
        updateGameInfo(url, { torrent_magnet: info.torrentUrl, download_url: info.torrentUrl })
      }
      return { success: true, latest: info.version || null, torrentUrl: info.torrentUrl || null }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Falha ao obter dados de atualização' }
    }
  })
}
