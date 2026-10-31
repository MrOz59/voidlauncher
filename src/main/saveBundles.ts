import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { extractZipWithPassword } from './zip'
import { isValidBackupZip } from './backupIntegrity'

/**
 * Ludusavi needs the game's mapping.yaml AND all snapshot files, not a loose
 * ZIP inside the game folder. Bundle the complete layout as one cloud object.
 */
export async function makeSaveBundle(sourceDirectory: string, outputZip: string, manifest: Record<string, unknown>): Promise<string> {
  if (!fs.statSync(sourceDirectory).isDirectory()) throw new Error('Snapshot source is not a directory')
  fs.mkdirSync(path.dirname(outputZip), { recursive: true })
  const partial = outputZip + '.part'
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const out = fs.createWriteStream(partial)
      const archive = archiver('zip', { zlib: { level: 6 } })
      const failed = (err: Error) => {
        if (settled) return
        settled = true
        try { archive.abort() } catch {}
        try { out.destroy() } catch {}
        reject(err)
      }
      out.on('error', failed)
      archive.on('error', failed)
      archive.on('warning', failed)
      out.on('close', () => {
        if (settled) return
        settled = true
        resolve()
      })
      archive.pipe(out)
      archive.directory(sourceDirectory, false)
      archive.append(JSON.stringify(manifest, null, 2), { name: '.void-save-bundle.json' })
      void archive.finalize().catch(failed)
    })
    if (!isValidBackupZip(partial)) throw new Error('Backup ZIP generated with invalid structure')
    fs.renameSync(partial, outputZip)
    return outputZip
  } catch (err) {
    try { fs.rmSync(partial, { force: true }) } catch {}
    throw err
  }
}

/** Unpack to a fresh private folder; never unpack a cloud archive over live saves. */
export async function unpackSaveBundle(archivePath: string, stagingDir: string): Promise<any> {
  if (!isValidBackupZip(archivePath)) throw new Error('Backup archive corrupted or incomplete')
  fs.mkdirSync(stagingDir, { recursive: true })
  await extractZipWithPassword(archivePath, stagingDir)
  const manifestPath = path.join(stagingDir, '.void-save-bundle.json')
  if (!fs.existsSync(manifestPath)) throw new Error('Legacy or unrecognized backup format; automatic restore disabled')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest || manifest.version !== 2 ||
      !['ludusavi-bundle', 'heuristic-bundle'].includes(manifest.format)) {
    throw new Error('Unsupported save bundle version')
  }
  // No symlinks or unsafe file types inside the downloaded archive.
  const pending = [stagingDir]
  while (pending.length) {
    const dir = pending.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('Unsafe entry in save archive')
      }
      if (entry.isDirectory()) pending.push(full)
    }
  }
  return manifest
}

export function hasLudusaviMapping(root: string): boolean {
  try {
    for (const name of fs.readdirSync(root)) {
      const gamePath = path.join(root, name)
      if (!fs.statSync(gamePath).isDirectory()) continue
      if (fs.existsSync(path.join(gamePath, 'mapping.yaml'))) {
        return fs.readdirSync(gamePath).some(file => file.endsWith('.zip'))
      }
    }
  } catch {}
  return false
}
