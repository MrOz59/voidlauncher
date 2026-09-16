import { app } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import { getSetting } from '../db'
import { vpnControllerListPeers, vpnControllerListRooms } from '../vpnControllerClient'
import { VpnSession, setActiveVpnSession } from '../vpnSession'
import type { IpcHandlerRegistrar } from './types'

const DEFAULT_LAN_CONTROLLER_URL = 'https://vpn.mroz.dev.br'

export const registerVpnHandlers: IpcHandlerRegistrar = () => {
  const controllerUrl = () => String(getSetting('lan_controller_url') || DEFAULT_LAN_CONTROLLER_URL).trim()
  const session = new VpnSession(() => app.getPath('userData'), controllerUrl)
  setActiveVpnSession(session)
  const handle = (name: string, fn: (payload: any) => Promise<unknown>) => {
    ipcMain.handle(name, async (_event, payload) => {
      try { return await fn(payload) } catch (error: any) {
        return { success: false, error: error?.message || 'Falha na VPN' }
      }
    })
  }

  handle('vpn-status', () => session.status())
  handle('vpn-install', () => session.install())
  handle('vpn-room-create', payload => session.create(payload || {}))
  handle('vpn-room-join', payload => session.join({ ...payload, code: String(payload?.code || '').trim() }))
  handle('vpn-connect', payload => session.connect(String(payload?.config || '').trim()))
  handle('vpn-disconnect', () => session.disconnect())
  handle('vpn-room-leave', payload => session.leave(String(payload?.peerId || '')))
  handle('vpn-room-peers', async payload => {
    const code = String(payload?.code || '').trim().toUpperCase()
    const current = session.snapshot()
    if (current?.code === code) return { success: true, peers: current.peers }
    return vpnControllerListPeers({ controllerUrl: controllerUrl(), code })
  })
  handle('vpn-room-list', payload => vpnControllerListRooms({ controllerUrl: controllerUrl(), gameName: payload?.gameName }))
  // Compatibility with existing renderers. Presence is maintained in main now.
  handle('vpn-heartbeat', async payload => {
    const current = session.snapshot()
    return current?.peerId === payload?.peerId
      ? { success: true, peers: current?.peers || [] }
      : { success: false, error: 'Sessão VPN inválida' }
  })
  app.once('before-quit', () => session.stopOnQuit())
}
