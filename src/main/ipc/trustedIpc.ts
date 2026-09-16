import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import electronIsDev from 'electron-is-dev'
import path from 'path'
import { pathToFileURL } from 'url'

let getMainWindow: (() => BrowserWindow | null) | null = null

export function setTrustedIpcWindowProvider(provider: () => BrowserWindow | null): void {
  getMainWindow = provider
}

export function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === 'development' || electronIsDev
}

export function isTrustedRendererUrl(rawUrl: string): boolean {
  if (isDevelopmentMode()) {
    try {
      const url = new URL(rawUrl)
      return url.origin === 'http://localhost:5173' && url.pathname === '/'
    } catch {
      return false
    }
  }
  const rendererUrl = pathToFileURL(path.join(__dirname, '../../renderer/index.html')).href
  return rawUrl === rendererUrl
}

export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const mainWindow = getMainWindow?.()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isTrustedRendererUrl(event.senderFrame?.url || '')
}

export const trustedIpcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event)) throw new Error('Untrusted IPC sender')
      return listener(event, ...args)
    })
  }
}
