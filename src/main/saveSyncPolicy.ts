export type SaveSyncChoice = 'restore' | 'local' | 'ask' | 'none'
export type SaveSnapshot = { exists: boolean; modifiedMs: number | null }
export const SAVE_TIMESTAMP_TOLERANCE_MS = 30_000

/**
 * Upload timestamps are not save timestamps. Unknown dates must never cause
 * an automatic overwrite of existing saves. Manual conflict resolution may
 * override this policy only after explicitly choosing the remote copy.
 */
export function chooseSafeSaveAction(
  local: SaveSnapshot,
  remote: SaveSnapshot
): SaveSyncChoice {
  if (!remote.exists) return local.exists ? 'local' : 'none'
  if (!local.exists) return 'restore'
  if (local.modifiedMs == null || remote.modifiedMs == null) return 'ask'
  if (local.modifiedMs > remote.modifiedMs + SAVE_TIMESTAMP_TOLERANCE_MS) return 'local'
  if (remote.modifiedMs > local.modifiedMs + SAVE_TIMESTAMP_TOLERANCE_MS) return 'ask'
  return 'ask' // Equal timestamps do not establish equal contents.
}
