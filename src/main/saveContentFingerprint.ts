import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { extractZipWithPassword } from './zip'
import { saveArchiveFolderName } from './heuristicSaveArchive'

/**
 * Versioned content fingerprint, independent of ZIP metadata, upload dates,
 * local absolute paths, file mtimes and discovery ordering.
 *
 * A null result means "unverified", NEVER "identical".
 */
export const SAVE_CONTENT_FINGERPRINT_VERSION = 'sha256-tree-v1'
const MAX_SAVE_FILES = 25_000
const MAX_SAVE_BYTES = 4 * 1024 * 1024 * 1024

function digestParts(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    const data = Buffer.from(part, 'utf8')
    hash.update(String(data.length) + ':')
    hash.update(data)
  }
  return hash.digest('hex')
}

async function hashFile(file: string): Promise<string> {
  const before = await fs.promises.stat(file)
  if (!before.isFile()) throw new Error('Not a regular save file')
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
  const after = await fs.promises.stat(file)
  // A changing save must not be marked synchronized based on a partial read.
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs) throw new Error('Save changed during verification')
  return digest.digest('hex')
}

async function hashDirectory(root: string): Promise<string> {
  let files = 0
  let bytes = 0
  const entries: string[] = []
  async function walk(folder: string, relative: string, depth: number): Promise<void> {
    if (depth > 48) throw new Error('Save directory nesting is too deep')
    const items = (await fs.promises.readdir(folder, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const item of items) {
      if (item.isSymbolicLink()) throw new Error('Save contains a symbolic link')
      const name = relative ? relative + '/' + item.name : item.name
      const full = path.join(folder, item.name)
      if (item.isDirectory()) {
        entries.push('D:' + name)
        await walk(full, name, depth + 1)
      } else if (item.isFile()) {
        const stat = await fs.promises.lstat(full)
        files++
        bytes += stat.size
        if (files > MAX_SAVE_FILES || bytes > MAX_SAVE_BYTES) {
          throw new Error('Save exceeds safe fingerprint limits')
        }
        entries.push('F:' + name + ':' + stat.size + ':' + await hashFile(full))
      } else {
        throw new Error('Save contains an unsupported file type')
      }
    }
  }
  if (!(await fs.promises.lstat(root)).isDirectory()) throw new Error('Missing save folder')
  await walk(root, '', 0)
  if (files === 0) throw new Error('Empty save folder')
  return digestParts(['root-v1', ...entries])
}

export async function fingerprintSaveRoots(roots: readonly string[]): Promise<string | null> {
  if (!roots.length) return null
  try {
    const hashes: string[] = []
    for (const root of roots) hashes.push(await hashDirectory(root))
    // Preserve repeated roots while ignoring detection order or machine paths.
    return digestParts([SAVE_CONTENT_FINGERPRINT_VERSION, ...hashes.sort()])
  } catch (err) {
    console.warn('[CloudSaves] Cannot verify save contents:', (err as Error)?.message || err)
    return null
  }
}

/** Compare the real files inside Ludusavi ZIP snapshots, not their ZIP bytes. */
export async function fingerprintLudusaviSnapshot(snapshotRoot: string): Promise<string | null> {
  const gameHashes: string[] = []
  try {
    for (const entry of await fs.promises.readdir(snapshotRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const gamePath = path.join(snapshotRoot, entry.name)
      if (!fs.existsSync(path.join(gamePath, 'mapping.yaml'))) continue
      const archives = (await fs.promises.readdir(gamePath, { withFileTypes: true }))
        .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.zip'))
      if (!archives.length) return null
      const backupHashes: string[] = []
      for (const archive of archives) {
        const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'void-save-compare-'))
        try {
          await extractZipWithPassword(path.join(gamePath, archive.name), staging)
          const hash = await fingerprintSaveRoots([staging])
          if (!hash) return null
          backupHashes.push(hash)
        } finally {
          await fs.promises.rm(staging, { recursive: true, force: true })
        }
      }
      gameHashes.push(digestParts(['ludusavi-game-v1', ...backupHashes.sort()]))
    }
    return gameHashes.length
      ? digestParts([SAVE_CONTENT_FINGERPRINT_VERSION, 'ludusavi', ...gameHashes.sort()])
      : null
  } catch (err) {
    console.warn('[CloudSaves] Cannot verify Ludusavi snapshot:', (err as Error)?.message || err)
    return null
  }
}

/** Fingerprint an extracted v2 bundle without trusting remote file names/paths. */
export async function fingerprintExtractedSaveBundle(
  stagingRoot: string,
  bundle: { gameKey?: string; format?: string; platform?: string },
  expected: { gameKey: string; format: string; platform: string }
): Promise<string | null> {
  if (bundle.gameKey !== expected.gameKey || bundle.format !== expected.format ||
      bundle.platform !== expected.platform) return null
  if (expected.format === 'ludusavi-bundle') {
    return fingerprintLudusaviSnapshot(stagingRoot)
  }
  if (expected.format !== 'heuristic-bundle') return null
  try {
    const info = JSON.parse(await fs.promises.readFile(path.join(stagingRoot, 'manifest.json'), 'utf8'))
    if (!Array.isArray(info.locations) || !info.locations.length ||
        info.platform !== expected.platform) return null
    const roots: string[] = []
    for (const [index, location] of info.locations.entries()) {
      const folder = saveArchiveFolderName(location, index)
      if (location.archiveFolder !== folder) return null
      roots.push(path.join(stagingRoot, folder))
    }
    return await fingerprintSaveRoots(roots)
  } catch {
    return null
  }
}
