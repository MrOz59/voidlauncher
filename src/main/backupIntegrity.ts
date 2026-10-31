import fs from 'fs'

/** Never allow a remote Drive filename to escape the per-game backup folder. */
export function safeRemoteZipFilename(fileName: string): string | null {
  const name = String(fileName || '').trim()
  if (!name || !name.toLowerCase().endsWith('.zip') ||
      name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null
  return name
}

/**
 * A tiny structural ZIP check for local backup creation and remote download.
 * It does not replace a full CRC integrity scan, but catches empty, truncated,
 * renamed HTML/error responses and missing EOCD records.
 */
export function isValidBackupZip(filePath: string): boolean {
  let handle: number | undefined
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size < 22) return false
    handle = fs.openSync(filePath, 'r')
    const signature = Buffer.alloc(4)
    if (fs.readSync(handle, signature, 0, 4, 0) !== 4 ||
        !signature.subarray(0, 2).equals(Buffer.from('PK'))) return false
    const tailSize = Math.min(st.size, 65557)
    const tail = Buffer.alloc(tailSize)
    fs.readSync(handle, tail, 0, tailSize, st.size - tailSize)
    return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  } catch {
    return false
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle) } catch {}
  }
}
