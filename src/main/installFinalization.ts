import fs from 'fs'
import path from 'path'

export type FinalizedInstallCheck = {
  downloadId: number
  gameUrl?: string | null
  installDir: string
  hasPayload: boolean
  hasExecutable: boolean
  requireWindowsExecutable: boolean
}

/**
 * Disk state is authoritative only after the current download has finalized.
 * A legacy .of_extracted marker, an existing EXE or a stale completed game
 * cannot complete a new download or update.
 */
export function isValidFinalizedInstall(check: FinalizedInstallCheck): boolean {
  const { downloadId, gameUrl, installDir, hasPayload, hasExecutable, requireWindowsExecutable } = check
  if (!Number.isSafeInteger(downloadId) || downloadId <= 0 || !installDir || !hasPayload) return false
  if (requireWindowsExecutable && !hasExecutable) return false

  try {
    if (!fs.statSync(installDir).isDirectory()) return false
    if (['.of_extracting.json', '.of_update_extracting.json', '.extracting'].some(
      marker => fs.existsSync(path.join(installDir, marker))
    )) return false

    const meta = JSON.parse(fs.readFileSync(path.join(installDir, '.of_game.json'), 'utf8'))
    if (meta?.status !== 'installed' || Number(meta.downloadId) !== downloadId) return false
    if (gameUrl && String(meta.url || '') !== gameUrl) return false
    if (meta.installPath && path.resolve(String(meta.installPath)) !== path.resolve(installDir)) return false
    return true
  } catch {
    return false
  }
}
