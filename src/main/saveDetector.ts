/**
 * Heuristic Save Game Detector
 * 
 * Finds save game locations when Ludusavi doesn't know the game.
 * Uses common patterns, folder structures, and PCGamingWiki to detect saves.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getWinePrefixSavePaths, getWindowsNativeSavePaths } from './pcgamingwiki'

export interface DetectedSaveLocation {
  path: string
  type: 'pcgamingwiki' | 'onlinefix' | 'unreal' | 'unity' | 'appdata_local' | 'appdata_roaming' | 'documents' | 'saved_games' | 'game_folder' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  steamAppId?: string
  gameName?: string
  source?: string
  /** Most recent modification time of files in this folder */
  lastModified?: Date
  /** Number of save files found */
  saveFileCount?: number
  /** Total size of save files in bytes */
  totalSize?: number
}

export interface SaveDetectorOptions {
  winePrefix?: string
  gameInstallPath?: string
  gameTitle?: string
  steamAppId?: string
}

/**
 * Common save file extensions
 */
const SAVE_EXTENSIONS = [
  '.sav', '.save', '.savegame',
  '.dat', '.bin',
  '.json', '.xml',
  '.profile', '.player',
  '.slot', '.slot0', '.slot1', '.slot2',
  '.progress', '.checkpoint'
]

/**
 * Folders that commonly contain saves
 */
const SAVE_FOLDER_PATTERNS = [
  /save[sd]?$/i,
  /savegame[sd]?$/i,
  /save[_-]?data$/i,
  /game[_-]?data$/i,
  /profile[sd]?$/i,
  /slot[sd]?$/i,
  /progress$/i,
  /checkpoint[sd]?$/i,
  /user[_-]?data$/i
]

/**
 * Folders to skip when scanning
 */
const SKIP_FOLDERS = [
  'logs', 'log', 'crash', 'crashes', 'crashdumps',
  'shader', 'shaders', 'shadercache', 'cache', 'cached',
  'temp', 'tmp', 'config', 'configs', 'settings',
  'screenshots', 'video', 'videos', 'movies',
  'dlc', 'mods', 'workshop', 'sdk'
]

function looksLikeSaveFolder(name: string): boolean {
  const lower = name.toLowerCase()
  return SAVE_FOLDER_PATTERNS.some(p => p.test(lower))
}

function shouldSkipFolder(name: string): boolean {
  const lower = name.toLowerCase()
  return SKIP_FOLDERS.includes(lower)
}

function hasSaveFiles(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath)
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (SAVE_EXTENSIONS.includes(ext)) return true
      // Also check for numbered files like save_001, slot_1, etc.
      if (/^(save|slot|profile|auto)[_-]?\d+/i.test(entry)) return true
    }
  } catch {
    // ignore
  }
  return false
}

function isSaveFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  if (SAVE_EXTENSIONS.includes(ext)) return true
  if (/^(save|slot|profile|auto)[_-]?\d+/i.test(filename)) return true
  return false
}

interface FolderStats {
  saveFileCount: number
  totalSize: number
  lastModified: Date | null
}

/**
 * Get statistics about save files in a directory (recursively)
 */
function getFolderStats(dirPath: string, maxDepth = 6): FolderStats {
  const stats: FolderStats = {
    saveFileCount: 0,
    totalSize: 0,
    lastModified: null
  }
  
  function scan(currentPath: string, depth: number) {
    if (depth > maxDepth) return
    
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)
        
        if (entry.isDirectory()) {
          // Skip certain folders
          if (!shouldSkipFolder(entry.name)) {
            scan(fullPath, depth + 1)
          }
        } else if (entry.isFile()) {
          // Check if it's a save file
          if (isSaveFile(entry.name)) {
            stats.saveFileCount++
            try {
              const fileStat = fs.statSync(fullPath)
              stats.totalSize += fileStat.size
              
              if (!stats.lastModified || fileStat.mtime > stats.lastModified) {
                stats.lastModified = fileStat.mtime
              }
            } catch {
              // ignore stat errors
            }
          } else {
            // Even non-save files can indicate activity - check mtime
            try {
              const fileStat = fs.statSync(fullPath)
              // Only consider recent files (not system/default files)
              const age = Date.now() - fileStat.mtime.getTime()
              const thirtyDays = 30 * 24 * 60 * 60 * 1000
              if (age < thirtyDays) {
                if (!stats.lastModified || fileStat.mtime > stats.lastModified) {
                  stats.lastModified = fileStat.mtime
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore directory read errors
    }
  }
  
  scan(dirPath, 0)
  return stats
}

/**
 * Enrich a detected location with file statistics
 */
function enrichWithStats(location: DetectedSaveLocation): DetectedSaveLocation {
  const stats = getFolderStats(location.path)
  return {
    ...location,
    saveFileCount: stats.saveFileCount,
    totalSize: stats.totalSize,
    lastModified: stats.lastModified || undefined
  }
}

function countSaveFiles(dirPath: string): number {
  let count = 0
  try {
    const entries = fs.readdirSync(dirPath)
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (SAVE_EXTENSIONS.includes(ext)) count++
      if (/^(save|slot|profile|auto)[_-]?\d+/i.test(entry)) count++
    }
  } catch {
    // ignore
  }
  return count
}

/**
 * Detect OnlineFix save locations
 * OnlineFix stores saves in: Documents/OnlineFix/<SteamAppId>/Saves
 */
function detectOnlineFixSaves(winePrefix: string, steamAppId?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  const documentsPath = path.join(winePrefix, 'drive_c', 'users', 'Public', 'Documents', 'OnlineFix')
  
  if (!fs.existsSync(documentsPath)) return results
  
  try {
    const entries = fs.readdirSync(documentsPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      
      // If we have a steamAppId, only look for that
      if (steamAppId && entry.name !== steamAppId) continue
      
      const savesPath = path.join(documentsPath, entry.name, 'Saves')
      if (fs.existsSync(savesPath)) {
        results.push({
          path: savesPath,
          type: 'onlinefix',
          confidence: 'high',
          steamAppId: entry.name
        })
      }
      
      // Also check root of the app folder
      const appPath = path.join(documentsPath, entry.name)
      if (hasSaveFiles(appPath)) {
        results.push({
          path: appPath,
          type: 'onlinefix',
          confidence: 'medium',
          steamAppId: entry.name
        })
      }
    }
  } catch {
    // ignore
  }
  
  return results
}

/**
 * Detect Unreal Engine save locations
 * UE games save in: AppData/Local/<GameName>/Saved/SaveGames
 */
function detectUnrealSaves(winePrefix: string, gameTitle?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  const localAppData = path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Local')
  
  if (!fs.existsSync(localAppData)) return results
  
  try {
    const entries = fs.readdirSync(localAppData, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      
      // Skip common non-game folders
      const lower = entry.name.toLowerCase()
      if (['microsoft', 'temp', 'packages', 'google', 'mozilla'].includes(lower)) continue
      
      // If we have a game title, prefer matching folders
      const titleMatch = gameTitle && lower.includes(gameTitle.toLowerCase().replace(/[^a-z0-9]/g, ''))
      
      const savedPath = path.join(localAppData, entry.name, 'Saved')
      const saveGamesPath = path.join(savedPath, 'SaveGames')
      
      if (fs.existsSync(saveGamesPath)) {
        results.push({
          path: saveGamesPath,
          type: 'unreal',
          confidence: titleMatch ? 'high' : 'medium',
          gameName: entry.name
        })
      } else if (fs.existsSync(savedPath) && hasSaveFiles(savedPath)) {
        results.push({
          path: savedPath,
          type: 'unreal',
          confidence: titleMatch ? 'high' : 'medium',
          gameName: entry.name
        })
      }
    }
  } catch {
    // ignore
  }
  
  return results
}

/**
 * Detect Unity save locations
 * Unity games save in: AppData/LocalLow/<Company>/<GameName>
 */
function detectUnitySaves(winePrefix: string, gameTitle?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  const localLowAppData = path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'AppData', 'LocalLow')
  
  if (!fs.existsSync(localLowAppData)) return results
  
  try {
    const companies = fs.readdirSync(localLowAppData, { withFileTypes: true })
    for (const company of companies) {
      if (!company.isDirectory()) continue
      
      const companyPath = path.join(localLowAppData, company.name)
      const games = fs.readdirSync(companyPath, { withFileTypes: true })
      
      for (const game of games) {
        if (!game.isDirectory()) continue
        
        const gamePath = path.join(companyPath, game.name)
        const titleMatch = gameTitle && game.name.toLowerCase().includes(gameTitle.toLowerCase().replace(/[^a-z0-9]/g, ''))
        
        // Check for save files or save folders
        if (hasSaveFiles(gamePath) || fs.existsSync(path.join(gamePath, 'Saves'))) {
          results.push({
            path: gamePath,
            type: 'unity',
            confidence: titleMatch ? 'high' : 'low',
            gameName: game.name
          })
        }
      }
    }
  } catch {
    // ignore
  }
  
  return results
}

/**
 * Detect saves in Documents folder
 * Many games save in: Documents/<GameName> or Documents/My Games/<GameName>
 */
function detectDocumentsSaves(winePrefix: string, gameTitle?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  const documentsPaths = [
    path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'Documents'),
    path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'My Documents')
  ]
  
  for (const documentsPath of documentsPaths) {
    if (!fs.existsSync(documentsPath)) continue
    
    try {
      const entries = fs.readdirSync(documentsPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        
        const entryPath = path.join(documentsPath, entry.name)
        const titleMatch = gameTitle && entry.name.toLowerCase().includes(gameTitle.toLowerCase().replace(/[^a-z0-9]/g, ''))
        
        // Check "My Games" subfolder
        if (entry.name.toLowerCase() === 'my games') {
          const myGames = fs.readdirSync(entryPath, { withFileTypes: true })
          for (const game of myGames) {
            if (!game.isDirectory()) continue
            const gamePath = path.join(entryPath, game.name)
            const gameMatch = gameTitle && game.name.toLowerCase().includes(gameTitle.toLowerCase().replace(/[^a-z0-9]/g, ''))
            
            if (hasSaveFiles(gamePath) || looksLikeSaveFolder(game.name)) {
              results.push({
                path: gamePath,
                type: 'documents',
                confidence: gameMatch ? 'high' : 'low',
                gameName: game.name
              })
            }
          }
          continue
        }
        
        // Direct game folders in Documents
        if (hasSaveFiles(entryPath) || looksLikeSaveFolder(entry.name)) {
          results.push({
            path: entryPath,
            type: 'documents',
            confidence: titleMatch ? 'high' : 'low',
            gameName: entry.name
          })
        }
      }
    } catch {
      // ignore
    }
  }
  
  return results
}

/**
 * Detect saves in Saved Games folder (Windows Vista+)
 */
function detectSavedGamesSaves(winePrefix: string, gameTitle?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  const savedGamesPath = path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'Saved Games')
  
  if (!fs.existsSync(savedGamesPath)) return results
  
  try {
    const entries = fs.readdirSync(savedGamesPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      
      const entryPath = path.join(savedGamesPath, entry.name)
      const titleMatch = gameTitle && entry.name.toLowerCase().includes(gameTitle.toLowerCase().replace(/[^a-z0-9]/g, ''))
      
      results.push({
        path: entryPath,
        type: 'saved_games',
        confidence: titleMatch ? 'high' : 'medium',
        gameName: entry.name
      })
    }
  } catch {
    // ignore
  }
  
  return results
}

/**
 * Detect saves in the game installation folder
 * Some games save directly in their install folder
 */
function detectGameFolderSaves(gameInstallPath?: string): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  
  if (!gameInstallPath || !fs.existsSync(gameInstallPath)) return results
  
  try {
    const scanDir = (dir: string, depth: number = 0) => {
      if (depth > 2) return
      
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (shouldSkipFolder(entry.name)) continue
        
        const entryPath = path.join(dir, entry.name)
        
        if (looksLikeSaveFolder(entry.name)) {
          // A folder named zone_slots/savegames is just a *candidate*.
          // Never report it as a save unless it actually contains save data.
          const stats = getFolderStats(entryPath, 6)
          if (stats.saveFileCount > 0) {
            results.push({
              path: entryPath,
              type: 'game_folder',
              confidence: 'medium'
            })
          }
        } else {
          scanDir(entryPath, depth + 1)
        }
      }
    }
    
    scanDir(gameInstallPath)
  } catch {
    // ignore
  }
  
  return results
}

/**
 * Detect saves using PCGamingWiki database
 * This provides accurate save locations for known games
 */
async function detectPCGamingWikiSaves(
  winePrefix: string,
  steamAppId?: string,
  gameTitle?: string,
  gameInstallPath?: string
): Promise<DetectedSaveLocation[]> {
  const results: DetectedSaveLocation[] = []
  
  try {
    console.log('[SaveDetector] Querying PCGamingWiki...')
    const paths = await getWinePrefixSavePaths({
      steamAppId,
      title: gameTitle,
      winePrefix,
      gameInstallPath
    })
    
    for (const p of paths) {
      if (fs.existsSync(p)) {
        results.push({
          path: p,
          type: 'pcgamingwiki',
          confidence: 'high',
          source: 'PCGamingWiki'
        })
        console.log('[SaveDetector] PCGamingWiki path exists:', p)
      } else {
        console.log('[SaveDetector] PCGamingWiki path not found:', p)
      }
    }
  } catch (err) {
    console.warn('[SaveDetector] PCGamingWiki query failed:', err)
  }
  
  return results
}

/**
 * Main detection function - tries all methods and returns best results
 */
/**
 * Native Windows saves are outside Proton prefixes. Keep the search narrowly
 * scoped to this game's title/Steam ID instead of backing up unrelated files
 * from the user's AppData or Documents directories.
 */
function detectWindowsSaveLocations(options: SaveDetectorOptions): DetectedSaveLocation[] {
  if (process.platform !== 'win32') return []
  const title = String(options.gameTitle || '').trim()
  const appId = String(options.steamAppId || '').trim()
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const roaming = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '')
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')
  const documents = home ? path.join(home, 'Documents') : ''
  const savedGames = home ? path.join(home, 'Saved Games') : ''
  const localLow = home ? path.join(home, 'AppData', 'LocalLow') : ''
  // Windows Known Folders handles redirection and localized folders
  // (e.g. C:\\Users\\...\\OneDrive\\Documentos instead of Documents).
  let systemDocuments = ''
  try {
    if (app?.isReady()) systemDocuments = app.getPath('documents')
  } catch {}
  const oneDrives = [process.env.OneDrive, process.env.OneDriveConsumer,
    process.env.OneDriveCommercial].filter((root): root is string => !!root)
  const documentsRoots = Array.from(new Set([
    systemDocuments,
    documents,
    home ? path.join(home, 'Documentos') : '',
    ...oneDrives.flatMap(root => [path.join(root, 'Documents'), path.join(root, 'Documentos')])
  ].filter(Boolean)))
  const candidates: Array<{ path: string; type: DetectedSaveLocation['type'] }> = []

  // Windows directory names often strip punctuation from the store title.
  const variations = Array.from(new Set([
    title,
    title.replace(/[<>:"/\\|?*]/g, '').trim(),
    title.replace(/[^a-z0-9]/gi, ''),
    title.replace(/\s+/g, ''),
  ].filter(Boolean)))
  for (const name of variations) {
    if (roaming) candidates.push({ path: path.join(roaming, name), type: 'appdata_roaming' })
    if (local) {
      candidates.push({ path: path.join(local, name, 'Saved', 'SaveGames'), type: 'unreal' })
      candidates.push({ path: path.join(local, name), type: 'appdata_local' })
    }
    for (const docRoot of documentsRoots) {
      candidates.push({ path: path.join(docRoot, 'My Games', name), type: 'documents' })
      candidates.push({ path: path.join(docRoot, name), type: 'documents' })
      // Paradox's launch-independent saves live in Documents/Paradox
      // Interactive/<Game>/save games/<empire or profile>/<date>.sav.
      // Preserve that root, never substitute the game installation directory.
      if (/^(stellaris|crusader kings|europa universalis|hearts of iron|victoria)\\b/i.test(title)) {
        candidates.push({ path: path.join(docRoot, 'Paradox Interactive', name, 'save games'), type: 'documents' })
      }
    }
    if (savedGames) candidates.push({ path: path.join(savedGames, name), type: 'saved_games' })
  }
  if (/^\d+$/.test(appId)) {
    for (const docRoot of documentsRoots) {
      candidates.push({ path: path.join(docRoot, 'OnlineFix', appId, 'Saves'), type: 'onlinefix' })
    }
    // Native Steam games can write into Steam/userdata/<account>/<appId>/remote.
    const steamRoots = Array.from(new Set([
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'userdata'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam', 'userdata')
    ]))
    for (const root of steamRoots) {
      try {
        for (const user of fs.readdirSync(root, { withFileTypes: true })) {
          if (user.isDirectory() && /^\d+$/.test(user.name)) {
            candidates.push({ path: path.join(root, user.name, appId, 'remote'), type: 'saved_games' })
          }
        }
      } catch {}
    }
  }
  // Unity frequently stores saves under LocalLow/<publisher>/<game>.
  if (localLow && variations.length) {
    try {
      const accepted = new Set(variations.map(v => v.replace(/[^a-z0-9]/gi, '').toLowerCase()))
      for (const publisher of fs.readdirSync(localLow, { withFileTypes: true })) {
        if (!publisher.isDirectory()) continue
        const root = path.join(localLow, publisher.name)
        for (const item of fs.readdirSync(root, { withFileTypes: true })) {
          if (item.isDirectory() && accepted.has(item.name.replace(/[^a-z0-9]/gi, '').toLowerCase())) {
            candidates.push({ path: path.join(root, item.name), type: 'unity' })
          }
        }
      }
    } catch {}
  }

  const seen = new Set<string>()
  return candidates.filter(item => {
    const key = path.normalize(item.path).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    try {
      return fs.statSync(item.path).isDirectory() &&
        (hasSaveFiles(item.path) || getFolderStats(item.path, 4).saveFileCount > 0)
    } catch {
      return false
    }
  }).map(item => ({
    path: item.path, type: item.type, confidence: 'medium' as const,
    gameName: title || undefined, steamAppId: appId || undefined,
    source: 'windows-native'
  }))
}

export function detectSaveLocations(options: SaveDetectorOptions): DetectedSaveLocation[] {
  const results: DetectedSaveLocation[] = []
  const { winePrefix, gameInstallPath, gameTitle, steamAppId } = options
  
  if (winePrefix && fs.existsSync(winePrefix)) {
    // OnlineFix - highest priority for OnlineFix games
    results.push(...detectOnlineFixSaves(winePrefix, steamAppId))
    
    // Unreal Engine
    results.push(...detectUnrealSaves(winePrefix, gameTitle))
    
    // Unity
    results.push(...detectUnitySaves(winePrefix, gameTitle))
    
    // Documents
    results.push(...detectDocumentsSaves(winePrefix, gameTitle))
    
    // Saved Games
    results.push(...detectSavedGamesSaves(winePrefix, gameTitle))
  }
  
  // Native Windows saves may be in AppData, Documents, or Saved Games.
  results.push(...detectWindowsSaveLocations(options))

  // Game folder
  results.push(...detectGameFolderSaves(gameInstallPath))
  
  // Enrich all results with file stats (modification time, count, size)
  const enrichedResults = results.map(r => enrichWithStats(r))
  
  // Sort by confidence first, then by most recent modification
  const seen = new Set<string>()
  const unique: DetectedSaveLocation[] = []
  
  const confidenceOrder = { high: 0, medium: 1, low: 2 }
  enrichedResults.sort((a, b) => {
    // First by confidence
    const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence]
    if (confDiff !== 0) return confDiff
    
    // Then by most recent modification (more recent = higher priority)
    const aTime = a.lastModified?.getTime() || 0
    const bTime = b.lastModified?.getTime() || 0
    return bTime - aTime // descending (most recent first)
  })
  
  for (const r of enrichedResults) {
    const normalized = path.normalize(r.path)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      unique.push(r)
    }
  }
  
  // Log stats for debugging
  console.log('[SaveDetector] Found', unique.length, 'save locations:')
  for (const loc of unique) {
    const modStr = loc.lastModified ? loc.lastModified.toISOString() : 'N/A'
    const sizeStr = loc.totalSize ? `${(loc.totalSize / 1024).toFixed(1)}KB` : '0KB'
    console.log(`  - ${loc.type} (${loc.confidence}): ${loc.path}`)
    console.log(`    Files: ${loc.saveFileCount || 0}, Size: ${sizeStr}, Last Modified: ${modStr}`)
  }
  
  return unique
}

/**
 * Main detection function with PCGamingWiki support (async)
 * This is the preferred method as it includes online database lookup
 */
export async function detectSaveLocationsAsync(options: SaveDetectorOptions): Promise<DetectedSaveLocation[]> {
  const results: DetectedSaveLocation[] = []
  const { winePrefix, gameInstallPath, gameTitle, steamAppId } = options
  
  // Try PCGamingWiki first (most accurate for known games)
  if (winePrefix && fs.existsSync(winePrefix)) {
    const pcgwResults = await detectPCGamingWikiSaves(winePrefix, steamAppId, gameTitle, gameInstallPath)
    results.push(...pcgwResults)
  }
  
  if (process.platform === 'win32') {
    try {
      const nativePaths = await getWindowsNativeSavePaths({
        steamAppId, title: gameTitle, gameInstallPath
      })
      for (const candidate of nativePaths) {
        try {
          if (!fs.statSync(candidate).isDirectory()) continue
          results.push({
            path: candidate, type: 'pcgamingwiki', confidence: 'high',
            steamAppId, gameName: gameTitle, source: 'pcgamingwiki-windows'
          })
        } catch {
          // Missing paths are normal before the first game launch.
        }
      }
    } catch (err) {
      console.warn('[SaveDetector] PCGamingWiki native Windows lookup failed:', err)
    }
  }

  // Then add heuristic results (already enriched with stats)
  const heuristicResults = detectSaveLocations(options)
  results.push(...heuristicResults)
  
  // Enrich PCGamingWiki results with stats too
  const enrichedResults = results.map(r => 
    r.saveFileCount !== undefined ? r : enrichWithStats(r)
  )
  
  // Remove duplicates, keeping highest confidence and most recent
  const seen = new Set<string>()
  const unique: DetectedSaveLocation[] = []
  
  const confidenceOrder = { high: 0, medium: 1, low: 2 }
  enrichedResults.sort((a, b) => {
    // First by confidence
    const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence]
    if (confDiff !== 0) return confDiff
    
    // Then by most recent modification
    const aTime = a.lastModified?.getTime() || 0
    const bTime = b.lastModified?.getTime() || 0
    return bTime - aTime
  })
  
  for (const r of enrichedResults) {
    const normalized = path.normalize(r.path)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      unique.push(r)
    }
  }
  
  return unique
}

/**
 * Get the best save location (highest confidence + most recent match)
 */
export function getBestSaveLocation(options: SaveDetectorOptions): DetectedSaveLocation | null {
  const locations = detectSaveLocations(options)
  
  if (locations.length === 0) return null
  
  // Filter by confidence level
  const highConf = locations.filter(l => l.confidence === 'high')
  const mediumConf = locations.filter(l => l.confidence === 'medium')
  
  // Helper: pick most recently modified from a list
  const pickMostRecent = (list: DetectedSaveLocation[]): DetectedSaveLocation | null => {
    if (list.length === 0) return null
    if (list.length === 1) return list[0]
    
    // Sort by last modified descending
    return list.sort((a, b) => {
      const aTime = a.lastModified?.getTime() || 0
      const bTime = b.lastModified?.getTime() || 0
      return bTime - aTime
    })[0]
  }
  
  // Prefer high confidence with recent modifications
  if (highConf.length > 0) {
    return pickMostRecent(highConf)
  }
  
  // Then medium confidence
  if (mediumConf.length > 0) {
    return pickMostRecent(mediumConf)
  }
  
  // Finally any
  return pickMostRecent(locations)
}

/**
 * Create a simple zip backup of detected save locations
 */
export async function backupDetectedSaves(
  options: SaveDetectorOptions,
  backupDir: string
): Promise<{ success: boolean; message?: string; path?: string; locations?: DetectedSaveLocation[] }> {
  const locations = detectSaveLocations(options)
  
  if (locations.length === 0) {
    return { success: false, message: 'Nenhuma pasta de saves detectada.' }
  }
  
  console.log('[SaveDetector] Found', locations.length, 'save locations:')
  locations.forEach(l => console.log(`  - ${l.type} (${l.confidence}): ${l.path}`))
  
  // For now, just return the detected locations
  // The actual backup will be handled by the caller
  return { success: true, locations, message: `Detectadas ${locations.length} pastas de saves.` }
}
