import { app, type Session } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { matchedPopupRule, shouldBlockRequest } from './easylist-filters'

export type StoreAdBlockMode = 'popups' | 'all'

let storeSession: Session | null = null
let currentMode: StoreAdBlockMode | null = null
let blockerPromise: Promise<ElectronBlocker> | null = null
let blockerInstance: ElectronBlocker | null = null
let popupBlockedCount = 0
let ghosterySwitchSerial = 0

export function normalizeStoreAdBlockMode(value: any): StoreAdBlockMode {
  return String(value || '').trim() === 'all' ? 'all' : 'popups'
}

function getBlocker() {
  if (blockerPromise) return blockerPromise

  const cachePath = path.join(app.getPath('userData'), 'ghostery-engine.bin')
  const fetchImpl = (globalThis as any).fetch
  blockerPromise = ElectronBlocker.fromPrebuiltAdsAndTracking(fetchImpl, {
    path: cachePath,
    read: fs.readFile,
    write: fs.writeFile
  }).then((blocker) => {
    blockerInstance = blocker
    return blocker
  })

  return blockerPromise
}

function clearNetworkHooks(ses: Session) {
  try { ses.webRequest.onBeforeRequest(null) } catch {}
  try { ses.webRequest.onHeadersReceived(null) } catch {}
}

function enablePopupBlocking(ses: Session) {
  clearNetworkHooks(ses)
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const shouldBlock = shouldBlockRequest(details.url, {
      resourceType: details.resourceType
    })
    if (shouldBlock) {
      popupBlockedCount++
      console.log(
        `[PopupBlocker] Network Block #${popupBlockedCount} (${matchedPopupRule(details.url) || 'unknown'}):`,
        details.url.substring(0, 120)
      )
      callback({ cancel: true })
      return
    }
    callback({ cancel: false })
  })
  console.log('[PopupBlocker] Network-level popup blocking enabled')
}

export async function configureStoreAdBlocker(modeInput: any) {
  const mode = normalizeStoreAdBlockMode(modeInput)
  if (!storeSession) {
    currentMode = mode
    return
  }

  const ses = storeSession
  const serial = ++ghosterySwitchSerial

  if (blockerInstance?.isBlockingEnabled(ses)) {
    try {
      blockerInstance.disableBlockingInSession(ses)
    } catch (err: any) {
      console.warn('[StoreAdBlocker] Failed to disable Ghostery blocker:', err?.message || err)
      clearNetworkHooks(ses)
    }
  } else {
    clearNetworkHooks(ses)
  }

  currentMode = mode

  if (mode === 'all') {
    try {
      const blocker = await getBlocker()
      if (serial !== ghosterySwitchSerial || currentMode !== 'all') return
      blocker.enableBlockingInSession(ses)
      console.log('[StoreAdBlocker] Ghostery ad blocker enabled for store session')
    } catch (err: any) {
      console.warn('[StoreAdBlocker] Ghostery failed; falling back to popup blocker:', err?.message || err)
      if (serial === ghosterySwitchSerial) enablePopupBlocking(ses)
    }
    return
  }

  enablePopupBlocking(ses)
}

export function initializeStoreAdBlocker(ses: Session, modeInput: any) {
  storeSession = ses
  storeSession.setPermissionCheckHandler(() => false)
  storeSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  void configureStoreAdBlocker(modeInput)
}
