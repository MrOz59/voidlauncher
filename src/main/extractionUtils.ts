/**
 * Extraction utilities that can run in worker threads (no Electron imports).
 * IMPORTANT: Do not add any imports that depend on 'electron' module.
 */
import { extractZipWithPassword } from './zip'
import path from 'path'
import fs from 'fs'

function mergeMoveEntry(srcPath: string, destPath: string) {
  try {
    const srcStat = fs.existsSync(srcPath) ? fs.statSync(srcPath) : null
    if (!srcStat) return

    if (srcStat.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      const entries = fs.readdirSync(srcPath, { withFileTypes: true })
      for (const entry of entries) {
        const s = path.join(srcPath, entry.name)
        const d = path.join(destPath, entry.name)
        mergeMoveEntry(s, d)
      }
      try { fs.rmSync(srcPath, { recursive: true, force: true }) } catch {}
      return
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    try {
      if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
        fs.rmSync(destPath, { recursive: true, force: true })
      } else if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { force: true })
      }
    } catch {
      // ignore
    }

    try {
      fs.renameSync(srcPath, destPath)
    } catch {
      try {
        fs.cpSync(srcPath, destPath, { force: true })
        try { fs.rmSync(srcPath, { force: true }) } catch {}
      } catch (err) {
        console.warn('[mergeMoveEntry] Failed to move', srcPath, '->', destPath, err)
        throw err
      }
    }
  } catch (err) {
    console.warn('[mergeMoveEntry] Error', srcPath, '->', destPath, err)
    throw err
  }
}

function flattenSingleSubdir(basePath: string) {
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.name !== '.DS_Store' && e.name !== 'Thumbs.db')

    if (entries.length !== 1 || !entries[0].isDirectory()) return

    // Never flatten Unity _Data folders - they must stay next to the executable
    if (entries[0].name.endsWith('_Data') ||
        /^(Engine|Content|Binaries|Plugins|Data|Resources|StreamingAssets|Managed|MonoBleedingEdge)$/i.test(entries[0].name)) return

    const subDir = path.join(basePath, entries[0].name)
    const subEntries = fs.readdirSync(subDir, { withFileTypes: true })

    subEntries.forEach(entry => {
      const src = path.join(subDir, entry.name)
      const dest = path.join(basePath, entry.name)
      mergeMoveEntry(src, dest)
    })

    try {
      fs.rmdirSync(subDir)
    } catch (err) {
      console.warn('[flattenSingleSubdir] Failed to remove subdir', subDir, err)
    }

    console.log('[flattenSingleSubdir] Flattened nested folder:', subDir)
  } catch (err) {
    console.warn('[flattenSingleSubdir] Error while flattening', basePath, err)
    throw err
  }
}

function countFilesRecursive(dir: string, max = 5000): number {
  let count = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop() as string
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name))
        } else {
          count++
          if (count >= max) return count
        }
      }
    } catch {
      // ignore
    }
  }
  return count
}

function flattenDominantSubdir(basePath: string) {
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.name !== '.DS_Store' && e.name !== 'Thumbs.db')
    const subdirs = entries.filter(e => e.isDirectory())
    if (!subdirs.length) return

    const filesAtRoot = entries.filter(e => e.isFile()).length
    let bestDir: string | null = null
    let bestCount = 0

    for (const dir of subdirs) {
      const full = path.join(basePath, dir.name)
      const count = countFilesRecursive(full, 10000)
      if (count > bestCount) {
        bestCount = count
        bestDir = full
      }
    }

    if (!bestDir) return

    if (bestCount < Math.max(5, filesAtRoot * 2)) return

    // Never flatten Unity _Data folders - they must stay next to the executable
    if (path.basename(bestDir).endsWith('_Data')) {
      console.log('[flattenDominantSubdir] Skipping Unity _Data folder:', bestDir)
      return
    }

    console.log('[flattenDominantSubdir] Flattening dominant folder:', bestDir, 'files:', bestCount, 'rootFiles:', filesAtRoot)

    const subEntries = fs.readdirSync(bestDir, { withFileTypes: true })
    subEntries.forEach(entry => {
      const src = path.join(bestDir, entry.name)
      const dest = path.join(basePath, entry.name)
      mergeMoveEntry(src, dest)
    })

    removeFolderIfExists(bestDir)
  } catch (err) {
    console.warn('[flattenDominantSubdir] Error while flattening', basePath, err)
  }
}

function removeFolderIfExists(target: string) {
  if (!target || target === '/' || target === '.' || target === '..') return
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('[removeFolderIfExists] Failed to remove', target, err)
  }
}

export function findFilesRecursive(dir: string, pattern: RegExp): string[] {
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findFilesRecursive(fullPath, pattern))
      } else if (pattern.test(entry.name)) {
        results.push(fullPath)
      }
    }
  } catch (err) {
    console.warn('[findFilesRecursive] Error reading directory:', dir, err)
  }
  return results
}

function findOnlineFixIni(gameDir: string): string | null {
  const files = findFilesRecursive(gameDir, /^OnlineFix\.ini$/i)
  return files.length > 0 ? files[0] : null
}

function findExecutable(gameDir: string): string | null {
  console.log('[findExecutable] Searching in:', gameDir)
  try {
    const exeFiles: Array<{ name: string; path: string; depth: number; size: number }> = []

    function scanDir(dir: string, depth: number = 0) {
      if (depth > 4) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            const skipDirs = ['__macosx', 'redist', 'directx', '_commonredist', 'vcredist', 'support', 'dotnet']
            if (!skipDirs.includes(entry.name.toLowerCase())) {
              scanDir(fullPath, depth + 1)
            }
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
            try {
              const stat = fs.statSync(fullPath)
              exeFiles.push({ name: entry.name, path: fullPath, depth, size: stat.size })
            } catch {
              exeFiles.push({ name: entry.name, path: fullPath, depth, size: 0 })
            }
          }
        }
      } catch (err) {
        // Ignore permission errors
      }
    }

    scanDir(gameDir)

    if (exeFiles.length === 0) {
      console.log('[findExecutable] No exe files found')
      return null
    }

    console.log('[findExecutable] Found', exeFiles.length, 'exe files')

    const scoreExe = (exe: { name: string; path: string; depth: number; size: number }): number => {
      const nameLower = exe.name.toLowerCase()
      const pathLower = exe.path.toLowerCase()
      let score = 0

      // Negative scores for non-game executables
      if (nameLower.includes('uninstall')) score -= 100
      if (nameLower.includes('uninst')) score -= 100
      if (nameLower.includes('setup')) score -= 50
      if (nameLower.includes('install')) score -= 50
      if (nameLower.includes('redist')) score -= 50
      if (nameLower.includes('vcredist')) score -= 100
      if (nameLower.includes('dxsetup')) score -= 100
      if (nameLower.includes('directx')) score -= 100
      if (nameLower.includes('dotnet')) score -= 100
      if (nameLower.includes('crash')) score -= 30
      if (nameLower.includes('report')) score -= 30
      if (nameLower.includes('helper')) score -= 20
      if (nameLower.includes('update')) score -= 20
      if (nameLower.includes('patch')) score -= 20
      if (nameLower.includes('ueprereq')) score -= 100  // Unreal Engine prerequisites

      // Positive scores for game-like names
      if (nameLower.includes('game')) score += 30
      if (nameLower.includes('launcher')) score += 20
      if (nameLower.includes('play')) score += 20
      if (nameLower.includes('start')) score += 15

      // Unreal Engine: prefer -Win64-Shipping.exe in Binaries/Win64
      if (nameLower.includes('-win64-shipping')) score += 100
      if (pathLower.includes('binaries/win64') || pathLower.includes('binaries\\win64')) score += 80

      // Unity: prefer .exe in *_Data parent folder pattern
      if (pathLower.includes('_data')) score += 30

      // Size scoring: larger executables are more likely to be the real game
      // Small stubs (< 1MB) are penalized, large executables (> 10MB) are rewarded
      const sizeMB = exe.size / (1024 * 1024)
      if (sizeMB < 0.5) score -= 50      // Very small, likely a stub/launcher
      else if (sizeMB < 1) score -= 20   // Small, possibly a launcher
      else if (sizeMB > 50) score += 60  // Large, likely the real game
      else if (sizeMB > 20) score += 40  // Medium-large
      else if (sizeMB > 10) score += 20  // Medium

      // Depth scoring (prefer shallower, but not as much as before since UE games have deep exes)
      score += (4 - exe.depth) * 5

      if (exe.name.length > 10) score += 5

      return score
    }

    exeFiles.sort((a, b) => scoreExe(b) - scoreExe(a))

    console.log('[findExecutable] Top candidates:')
    exeFiles.slice(0, 5).forEach((exe, i) => {
      const sizeMB = (exe.size / (1024 * 1024)).toFixed(1)
      console.log(`  ${i + 1}. ${exe.name} (score: ${scoreExe(exe)}, depth: ${exe.depth}, size: ${sizeMB}MB)`)
    })

    const best = exeFiles[0]
    console.log('[findExecutable] Selected:', best.path)
    return best.path
  } catch (error) {
    console.error('[findExecutable] Error:', error)
    return null
  }
}

function isUpdateArchivePath(filePath: string): boolean {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/').filter(Boolean)
  const name = parts[parts.length - 1] || normalized
  return (
    parts.includes('updates') ||
    normalized.includes('/updates/') ||
    name.startsWith('update') ||
    name.includes('.update.') ||
    name.includes('_update_') ||
    name.includes('-update-')
  )
}

function archiveOrderKey(filePath: string): number {
  const name = path.basename(filePath).toLowerCase()

  const leading = name.match(/^(\d{1,3})[-_. ]/)
  if (leading) return Number(leading[1])

  const updateVersion = name.match(/(?:update|upd|patch)[-_. ]*v?(\d+(?:[._-]\d+)*)/i)
  if (updateVersion) {
    return Number(updateVersion[1].replace(/[^0-9]/g, '').slice(0, 12)) || 0
  }

  const version = name.match(/\bv?(\d+(?:[._-]\d+){1,6})\b/i)
  if (version) {
    return Number(version[1].replace(/[^0-9]/g, '').slice(0, 12)) || 0
  }

  return Number.MAX_SAFE_INTEGER
}

function compareArchiveGroups(
  a: { first: string; all: string[] },
  b: { first: string; all: string[] }
): number {
  const aIsUpdate = isUpdateArchivePath(a.first)
  const bIsUpdate = isUpdateArchivePath(b.first)
  if (aIsUpdate !== bIsUpdate) return aIsUpdate ? 1 : -1

  const orderDelta = archiveOrderKey(a.first) - archiveOrderKey(b.first)
  if (orderDelta !== 0) return orderDelta

  return a.first.localeCompare(b.first, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Process torrent update - extract RAR, cleanup, restore configs.
 * This handles the case where a torrent downloads an update with a .rar file
 * that needs to be extracted over the existing game installation.
 *
 * NOTE: This function is designed to run in a Worker thread and has no Electron imports.
 * The previousExePath should be passed from the caller (main process) since we can't
 * access the database from a worker thread.
 */
export async function processUpdateExtraction(
  installPath: string,
  _gameUrl: string,
  onProgress?: (percent: number, details?: { etaSeconds?: number }) => void,
  previousExePath?: string | null
): Promise<{ success: boolean; error?: string; executablePath?: string; warnings?: string[] }> {
  const warnings: string[] = []

  console.log('[UpdateProcessor] Starting update processing for:', installPath)

  // Validate install path
  if (!installPath) {
    return { success: false, error: 'Install path is required' }
  }

  if (!fs.existsSync(installPath)) {
    return { success: false, error: `Install path does not exist: ${installPath}` }
  }

  // Check disk space before extraction (best effort)
  try {
    const stats = fs.statfsSync ? fs.statfsSync(installPath) : null
    if (stats) {
      const availableGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024)
      console.log(`[UpdateProcessor] Available disk space: ${availableGB.toFixed(2)} GB`)
      if (availableGB < 1) {
        warnings.push('Low disk space warning: less than 1 GB available')
      }
    }
  } catch {
    // statfsSync may not be available on all platforms
  }

  // Find RAR files but exclude those in "Fix Repair" folders (these are optional repair tools, not game content)
  const allRarFiles = findFilesRecursive(installPath, /\.rar$/i)
  const rarFiles = allRarFiles.filter(f => {
    const lowerPath = f.toLowerCase()
    // Skip RARs inside "Fix Repair" folders
    if (lowerPath.includes('fix repair') || lowerPath.includes('fix_repair') || lowerPath.includes('fixrepair')) {
      console.log('[UpdateProcessor] Skipping Fix Repair RAR:', f)
      return false
    }
    return true
  })

  if (rarFiles.length === 0) {
    console.log('[UpdateProcessor] No RAR files found (excluding Fix Repair), skipping update processing')
    return { success: true }
  }

  console.log('[UpdateProcessor] Found RAR files to extract:', rarFiles)
  console.log('[UpdateProcessor] Previous executable path:', previousExePath)

  const onlineFixPath = findOnlineFixIni(installPath)
  let onlineFixBackup: string | null = null

  if (onlineFixPath) {
    console.log('[UpdateProcessor] Found OnlineFix.ini at:', onlineFixPath)
    try {
      onlineFixBackup = fs.readFileSync(onlineFixPath, 'utf-8')
      console.log('[UpdateProcessor] Backed up OnlineFix.ini')
    } catch (err) {
      console.warn('[UpdateProcessor] Failed to backup OnlineFix.ini:', err)
    }
  }

  const partRe = /^(.*)\.part(\d+)\.rar$/i
  const groups = new Map<string, { all: string[]; first: string }>()

  for (const rarFile of rarFiles) {
    const baseName = path.basename(rarFile)
    const m = baseName.match(partRe)
    const key = m ? path.join(path.dirname(rarFile), m[1]) : rarFile
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { all: [rarFile], first: rarFile })
    } else {
      existing.all.push(rarFile)
    }
  }

  for (const [key, group] of groups.entries()) {
    const candidates = group.all.slice().sort((a, b) => a.localeCompare(b))
    const part01 = candidates.find(f => /\.part0*1\.rar$/i.test(path.basename(f)))
    group.first = part01 || candidates[0]
    groups.set(key, group)
  }

  const orderedGroups = Array.from(groups.values()).sort(compareArchiveGroups)
  console.log('[UpdateProcessor] Extraction order:', orderedGroups.map(g => path.basename(g.first)))

  for (const group of orderedGroups) {
    const rarFile = group.first
    console.log('[UpdateProcessor] Extracting:', rarFile, 'to:', installPath)
    try {
      await extractZipWithPassword(rarFile, installPath, undefined, (percent, details) => {
        onProgress?.(percent, { etaSeconds: details?.etaSeconds })
      })
      console.log('[UpdateProcessor] Extraction completed for:', rarFile)

      // Moving an arbitrary "dominant" subdirectory can break Engine/ and
      // Content/ layouts. Only unwrap a single, safe wrapper folder.
      flattenSingleSubdir(installPath)

      // Keep every source archive until the caller has validated the final
      // game and committed installation metadata. Deleting here makes retry
      // impossible if a later archive fails or an EXE is missing.

      const rarDir = path.dirname(rarFile)
      const fixRepairPath = path.join(rarDir, 'Fix Repair')
      if (fs.existsSync(fixRepairPath)) {
        try {
          fs.rmSync(fixRepairPath, { recursive: true, force: true })
          console.log('[UpdateProcessor] Removed Fix Repair folder:', fixRepairPath)
        } catch (err) {
          console.warn('[UpdateProcessor] Failed to remove Fix Repair folder:', err)
        }
      }

      const rootFixRepairPath = path.join(installPath, 'Fix Repair')
      if (fs.existsSync(rootFixRepairPath)) {
        try {
          fs.rmSync(rootFixRepairPath, { recursive: true, force: true })
          console.log('[UpdateProcessor] Removed root Fix Repair folder:', rootFixRepairPath)
        } catch (err) {
          console.warn('[UpdateProcessor] Failed to remove root Fix Repair folder:', err)
        }
      }

      if (rarDir !== installPath) {
        try {
          const remainingFiles = fs.readdirSync(rarDir)
          if (remainingFiles.length === 0) {
            fs.rmdirSync(rarDir)
            console.log('[UpdateProcessor] Removed empty folder:', rarDir)
          } else {
            // Archives and Fix Repair files may be needed for retry/debugging.
            // Never delete an archive directory based on filename heuristics.
          }
        } catch (err) {
          // Folder not empty or other error, ignore
        }
      }
    } catch (err: any) {
      console.error('[UpdateProcessor] Failed to extract:', rarFile, err)
      
      // Preserve the failed RAR and its multipart segments for a retry.
      // In particular, deleting them here made the next attempt see zero
      // archives and incorrectly report successful installation.
      return { success: false, error: `Failed to extract ${path.basename(rarFile)}: ${err.message}` }
    }
  }

  if (onlineFixBackup) {
    const newOnlineFixPath = findOnlineFixIni(installPath)
    if (newOnlineFixPath) {
      try {
        fs.writeFileSync(newOnlineFixPath, onlineFixBackup, 'utf-8')
        console.log('[UpdateProcessor] Restored OnlineFix.ini to:', newOnlineFixPath)
      } catch (err) {
        console.warn('[UpdateProcessor] Failed to restore OnlineFix.ini:', err)
      }
    } else if (onlineFixPath) {
      try {
        fs.writeFileSync(onlineFixPath, onlineFixBackup, 'utf-8')
        console.log('[UpdateProcessor] Restored OnlineFix.ini to original location:', onlineFixPath)
      } catch (err) {
        console.warn('[UpdateProcessor] Failed to restore OnlineFix.ini:', err)
      }
    }
  }

  let executablePath: string | null = null

  if (previousExePath && fs.existsSync(previousExePath)) {
    executablePath = previousExePath
    console.log('[UpdateProcessor] Using previous executable path:', executablePath)
  } else {
    executablePath = findExecutable(installPath)
    console.log('[UpdateProcessor] Found new executable path:', executablePath)
  }

  // Final validation
  const fileCount = countFilesRecursive(installPath, 100)
  if (fileCount === 0) {
    return { success: false, error: 'No game files found after extraction' }
  } else if (fileCount < 5) {
    warnings.push(`Very few files (${fileCount}) found after extraction`)
  }

  if (!executablePath) {
    warnings.push('No executable file found in game directory')
  }

  if (warnings.length > 0) {
    console.warn('[UpdateProcessor] Completed with warnings:')
    warnings.forEach(w => console.warn('  -', w))
  } else {
    console.log('[UpdateProcessor] Completed successfully')
  }

  return { success: true, executablePath: executablePath || undefined, warnings: warnings.length > 0 ? warnings : undefined }
}
