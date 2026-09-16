/**
 * IPC for the native store.
 *
 * The classic store tab keeps browsing the site inside a webview; these
 * handlers back the new tab, which reads the same pages through the store
 * session and renders them natively.
 */
import { type IpcMainInvokeEvent } from 'electron'
import { trustedIpcMain as ipcMain } from './trustedIpc'
import { captureStoreFixture, clearStoreCache, getStoreGame, getStoreListing } from '../store/catalog'
import { getStoreGameComments, postStoreGameComment } from '../store/comments'
import { clearStoreImageCache } from '../store/imageProxy'
import { clearStoreInstructionTranslationCache, translateStoreInstructions } from '../store/instructionTranslation'
import { getStoreGameMetadata } from '../store/metadata'
import type { IpcContext, IpcHandlerRegistrar } from './types'

export const registerStoreHandlers: IpcHandlerRegistrar = (_ctx: IpcContext) => {
  ipcMain.handle(
    'store-listing',
    async (_event: IpcMainInvokeEvent, payload?: { page?: number; query?: string; force?: boolean }) => {
      try {
        const listing = await getStoreListing({
          page: payload?.page,
          query: payload?.query,
          force: payload?.force === true
        })
        return { success: true, listing }
      } catch (err: any) {
        console.error('[Store] Listing failed:', err?.message || err)
        return { success: false, error: err?.message || String(err), errorCode: err?.code || 'store-listing-failed' }
      }
    }
  )

  ipcMain.handle('store-game', async (_event: IpcMainInvokeEvent, payload: { url: string; force?: boolean }) => {
    try {
      const game = await getStoreGame(String(payload?.url || ''), { force: payload?.force === true })
      return { success: true, game }
    } catch (err: any) {
      console.error('[Store] Game page failed:', err?.message || err)
      return { success: false, error: err?.message || String(err), errorCode: err?.code || 'store-game-failed' }
    }
  })

  ipcMain.handle(
    'store-translate-instructions',
    async (_event: IpcMainInvokeEvent, payload: { url: string; instructions: string[]; language?: string; force?: boolean }) => {
      try {
        const result = await translateStoreInstructions({
          url: String(payload?.url || ''),
          instructions: payload?.instructions,
          language: payload?.language,
          force: payload?.force === true
        })
        return { success: true, ...result }
      } catch (err: any) {
        console.warn('[Store] Instruction translation failed:', err?.message || err)
        return {
          success: false,
          error: err?.message || String(err),
          errorCode: err?.code || 'store-translation-unavailable'
        }
      }
    }
  )

  // The comment thread of a game page. With no page asked for, the last one
  // comes back: that is where the site keeps what was said most recently.
  ipcMain.handle(
    'store-game-comments',
    async (_event: IpcMainInvokeEvent, payload: { url: string; page?: number; force?: boolean }) => {
      try {
        const thread = await getStoreGameComments({
          url: String(payload?.url || ''),
          page: payload?.page,
          force: payload?.force === true
        })
        return { success: true, thread }
      } catch (err: any) {
        console.warn('[Store] Comments failed:', err?.message || err)
        return { success: false, error: err?.message || String(err), errorCode: err?.code || 'store-comments-failed' }
      }
    }
  )

  // Posts as the signed-in account, through the site's own comment endpoint.
  ipcMain.handle(
    'store-post-comment',
    async (_event: IpcMainInvokeEvent, payload: { url: string; text: string }) => {
      try {
        const result = await postStoreGameComment({ url: String(payload?.url || ''), text: String(payload?.text || '') })
        return { success: true, ...result }
      } catch (err: any) {
        console.warn('[Store] Posting a comment failed:', err?.message || err)
        return { success: false, error: err?.message || String(err), errorCode: err?.code || 'store-comment-failed' }
      }
    }
  )

  // Saves a real page for the parser tests; see scripts/test-store-parser.js.
  ipcMain.handle(
    'store-capture-fixture',
    async (_event: IpcMainInvokeEvent, payload: { url: string; name?: string }) => {
      try {
        const result = await captureStoreFixture(String(payload?.url || ''), payload?.name)
        return { success: true, ...result }
      } catch (err: any) {
        return { success: false, error: err?.message || String(err), errorCode: 'store-capture-failed' }
      }
    }
  )

  // Artwork, description and screenshots for the game page: the site provides
  // none of that, so it comes from Steam.
  ipcMain.handle(
    'store-game-metadata',
    async (_event: IpcMainInvokeEvent, payload: { url: string; title: string; steamAppId?: string }) => {
      try {
        const metadata = await getStoreGameMetadata({
          gameUrl: String(payload?.url || ''),
          title: String(payload?.title || ''),
          steamAppId: payload?.steamAppId
        })
        return { success: true, metadata }
      } catch (err: any) {
        console.warn('[Store] Metadata failed:', err?.message || err)
        return { success: false, error: err?.message || String(err), errorCode: 'store-metadata-failed' }
      }
    }
  )

  ipcMain.handle('store-clear-cache', async () => {
    clearStoreCache()
    clearStoreImageCache()
    clearStoreInstructionTranslationCache()
    return { success: true }
  })
}
