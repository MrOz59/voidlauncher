import fs from 'fs'
import path from 'path'
import archiver from 'archiver'
import { isValidBackupZip } from './backupIntegrity'

export type HeuristicSaveSource = {
  path: string
  type: string
  confidence: string
  steamAppId?: string
  gameName?: string
  saveFileCount?: number
  totalSize?: number
  lastModified?: Date
}

/**
 * Each selected save root has a stable top-level name in the archive. Its
 * ENTIRE contents are archived recursively; a Stellaris empire directory and
 * its .sav files must never be flattened.
 */
export function saveArchiveFolderName(location: Pick<HeuristicSaveSource, 'type' | 'steamAppId' | 'gameName'>, index: number): string {
  return `${index}_${location.type}_${location.steamAppId || location.gameName || 'saves'}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
}

export async function writeHeuristicSaveArchive(options: {
  locations: HeuristicSaveSource[]
  zipPath: string
  gameKey: string
  gameTitle?: string
  platform: string
}): Promise<void> {
  const { locations, zipPath, gameKey, gameTitle, platform } = options
  if (locations.length === 0) throw new Error('Nenhuma pasta de saves para empacotar.')
  const manifest = {
    created: new Date().toISOString(),
    gameTitle,
    platform,
    locations: locations.map((location, index) => ({
      path: location.path,
      type: location.type,
      confidence: location.confidence,
      steamAppId: location.steamAppId,
      gameName: location.gameName,
      saveFileCount: location.saveFileCount,
      totalSize: location.totalSize,
      lastModified: location.lastModified?.toISOString(),
      archiveFolder: saveArchiveFolderName(location, index)
    }))
  }

  // This is an exact directory-root backup, not a list of *.sav files.
  for (const loc of locations) {
    if (!fs.statSync(loc.path).isDirectory()) {
      throw new Error(`A origem dos saves não é uma pasta: ${loc.path}`)
    }
  }

  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  const partial = `${zipPath}.${process.pid}.part`
  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(partial)
      const archive = archiver('zip', { zlib: { level: 9 } })
      let settled = false

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        try { archive.abort() } catch {}
        try { output.destroy() } catch {}
        reject(error)
      }

      output.on('error', fail)
      archive.on('error', fail)
      // Missing or inaccessible files are not a successful backup.
      archive.on('warning', fail)
      output.on('close', () => {
        if (settled) return
        settled = true
        resolve()
      })

      archive.pipe(output)
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
      archive.append(JSON.stringify({
        version: 2,
        format: 'heuristic-bundle',
        gameTitle,
        gameKey,
        platform,
        hierarchy: 'preserve-relative-tree'
      }, null, 2), { name: '.void-save-bundle.json' })

      for (let index = 0; index < locations.length; index++) {
        const location = locations[index]
        // e.g. 0_unknown_saves/unitednationsofearth_-15512622/2200.01.01.sav
        archive.directory(location.path, saveArchiveFolderName(location, index))
      }
      void archive.finalize().catch(fail)
    })

    if (!isValidBackupZip(partial)) {
      throw new Error('ZIP de saves incompleto ou inválido; backup não enviado.')
    }
    fs.renameSync(partial, zipPath)
  } catch (error) {
    try { fs.rmSync(partial, { force: true }) } catch {}
    throw error
  }
}

/** Copy children of the archived root, never an extra folder wrapper. */
export function restoreSaveDirectoryContents(archiveRoot: string, destinationRoot: string): void {
  if (!fs.statSync(archiveRoot).isDirectory()) throw new Error('Pasta de backup inválida.')
  fs.mkdirSync(destinationRoot, { recursive: true })
  for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error('Backup contém entrada não segura.')
    }
    fs.cpSync(path.join(archiveRoot, entry.name), path.join(destinationRoot, entry.name), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      errorOnExist: false
    })
  }
}
