/**
 * PCGamingWiki API Client
 * 
 * Fetches save game locations and other game data from PCGamingWiki.
 * API Documentation: https://www.pcgamingwiki.com/wiki/PCGamingWiki:API
 */

import https from 'https'
import path from 'path'

const API_BASE = 'https://www.pcgamingwiki.com/w/api.php'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface CacheEntry {
  data: PCGWGameData
  timestamp: number
}

const cache = new Map<string, CacheEntry>()

export interface PCGWSaveLocation {
  platform: 'Windows' | 'Linux' | 'macOS'
  path: string
  rawPath: string // Original path with {{p|...}} placeholders
}

export interface PCGWGameData {
  title: string
  steamAppId?: string
  gogId?: string
  saveLocations: PCGWSaveLocation[]
  configLocations: PCGWSaveLocation[]
}

/**
 * Expand PCGamingWiki path placeholders to actual paths
 * Reference: https://www.pcgamingwiki.com/wiki/Template:Path
 */
function expandPathPlaceholders(rawPath: string, platform: string): string {
  let expanded = rawPath

  // Common Windows paths
  const windowsReplacements: Record<string, string> = {
    '{{p|game}}': '<GAME>',
    '{{p|uid}}': '<USER_ID>',
    '{{p|steam}}': 'C:\\Program Files (x86)\\Steam',
    '{{p|uplay}}': 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher',
    '{{p|username}}': '<USERNAME>',
    // User folders
    '{{p|userprofile}}': '%USERPROFILE%',
    '{{p|userprofile\\Documents}}': '%USERPROFILE%\\Documents',
    '{{p|appdata}}': '%APPDATA%',
    '{{p|localappdata}}': '%LOCALAPPDATA%',
    '{{p|public}}': '%PUBLIC%',
    '{{p|programdata}}': '%PROGRAMDATA%',
    '{{p|programfiles}}': '%PROGRAMFILES%',
    '{{p|programfiles(x86)}}': '%PROGRAMFILES(X86)%',
    '{{p|windir}}': '%WINDIR%',
    // Registry
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
  }

  // Linux paths
  const linuxReplacements: Record<string, string> = {
    '{{p|game}}': '<GAME>',
    '{{p|uid}}': '<USER_ID>',
    '{{p|steam}}': '~/.steam/steam',
    '{{p|xdgdatahome}}': '~/.local/share',
    '{{p|xdgconfighome}}': '~/.config',
    '{{p|linuxhome}}': '~',
  }

  const replacements = platform.toLowerCase() === 'linux' ? linuxReplacements : windowsReplacements

  for (const [placeholder, replacement] of Object.entries(replacements)) {
    expanded = expanded.split(placeholder).join(replacement)
  }

  // Handle remaining {{p|...}} patterns
  expanded = expanded.replace(/\{\{p\|([^}]+)\}\}/gi, (match, name) => {
    return `<${name.toUpperCase()}>`
  })

  return expanded
}

/**
 * Convert Windows path to Wine prefix path
 */
export function windowsPathToWinePrefix(windowsPath: string, winePrefix: string, steamUserId?: string): string {
  let winePath = windowsPath

  // Replace Windows environment variables with Wine prefix paths
  winePath = winePath.replace(/%APPDATA%/gi, path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming'))
  winePath = winePath.replace(/%LOCALAPPDATA%/gi, path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Local'))
  winePath = winePath.replace(/%USERPROFILE%/gi, path.join(winePrefix, 'drive_c', 'users', 'steamuser'))
  winePath = winePath.replace(/%PUBLIC%/gi, path.join(winePrefix, 'drive_c', 'users', 'Public'))
  winePath = winePath.replace(/%PROGRAMDATA%/gi, path.join(winePrefix, 'drive_c', 'ProgramData'))
  winePath = winePath.replace(/%PROGRAMFILES%/gi, path.join(winePrefix, 'drive_c', 'Program Files'))
  winePath = winePath.replace(/%PROGRAMFILES\(X86\)%/gi, path.join(winePrefix, 'drive_c', 'Program Files (x86)'))
  winePath = winePath.replace(/%WINDIR%/gi, path.join(winePrefix, 'drive_c', 'windows'))

  // Replace Documents path pattern
  winePath = winePath.replace(/%USERPROFILE%\\Documents/gi, path.join(winePrefix, 'drive_c', 'users', 'steamuser', 'Documents'))

  // Replace user ID placeholder
  if (steamUserId) {
    winePath = winePath.replace(/<USER_ID>/g, steamUserId)
  }

  // Replace game path placeholder (caller should handle this)
  // winePath = winePath.replace(/<GAME>/g, gamePath)

  // Convert backslashes to forward slashes for Linux
  winePath = winePath.replace(/\\/g, '/')

  return winePath
}

/**
 * HTTP GET request
 */
function httpGet(url: string, timeoutMs: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'VoidLauncher/1.0 (https://github.com/voidlauncher)' }
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location
        if (location) {
          httpGet(location, timeoutMs).then(resolve).catch(reject)
          return
        }
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })

    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'))
    })
  })
}

/**
 * Parse wikitext to extract Game data/saves entries
 */
function parseWikitext(wikitext: string): { saves: PCGWSaveLocation[], configs: PCGWSaveLocation[] } {
  const saves: PCGWSaveLocation[] = []
  const configs: PCGWSaveLocation[] = []

  // Match {{Game data/saves|Platform|Path}}
  const saveRegex = /\{\{Game data\/saves\|([^|]+)\|([^}]+)\}\}/gi
  let match
  while ((match = saveRegex.exec(wikitext)) !== null) {
    const platform = match[1].trim() as 'Windows' | 'Linux' | 'macOS'
    const rawPath = match[2].trim()
    saves.push({
      platform,
      rawPath,
      path: expandPathPlaceholders(rawPath, platform)
    })
  }

  // Match {{Game data/config|Platform|Path}}
  const configRegex = /\{\{Game data\/config\|([^|]+)\|([^}]+)\}\}/gi
  while ((match = configRegex.exec(wikitext)) !== null) {
    const platform = match[1].trim() as 'Windows' | 'Linux' | 'macOS'
    const rawPath = match[2].trim()
    configs.push({
      platform,
      rawPath,
      path: expandPathPlaceholders(rawPath, platform)
    })
  }

  return { saves, configs }
}

/**
 * Search for a game by Steam App ID
 */
export async function searchBySteamAppId(steamAppId: string): Promise<string | null> {
  try {
    const url = `${API_BASE}?action=cargoquery&tables=Infobox_game&fields=Infobox_game._pageName=Page&where=Steam_AppID%20HOLDS%20%27${steamAppId}%27&format=json`
    const response = await httpGet(url)
    const data = JSON.parse(response)

    if (data.cargoquery && data.cargoquery.length > 0) {
      return data.cargoquery[0].title.Page
    }
  } catch (err) {
    console.warn('[PCGW] Failed to search by Steam ID:', err)
  }
  return null
}

/**
 * Search for a game by title (fuzzy)
 */
export async function searchByTitle(title: string): Promise<string | null> {
  try {
    // Use opensearch for fuzzy matching
    const url = `${API_BASE}?action=opensearch&search=${encodeURIComponent(title)}&limit=5&format=json`
    const response = await httpGet(url)
    const data = JSON.parse(response)

    // opensearch returns [query, [titles], [descriptions], [urls]]
    if (Array.isArray(data) && data.length >= 2 && data[1].length > 0) {
      // Return the first match
      return data[1][0]
    }
  } catch (err) {
    console.warn('[PCGW] Failed to search by title:', err)
  }
  return null
}

/**
 * Fetch game data from PCGamingWiki
 */
export async function fetchGameData(pageTitle: string): Promise<PCGWGameData | null> {
  // Check cache
  const cacheKey = pageTitle.toLowerCase()
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data
  }

  try {
    // Fetch page wikitext
    const url = `${API_BASE}?action=parse&page=${encodeURIComponent(pageTitle.replace(/ /g, '_'))}&prop=wikitext&format=json`
    const response = await httpGet(url)
    const data = JSON.parse(response)

    if (!data.parse || !data.parse.wikitext) {
      return null
    }

    const wikitext = data.parse.wikitext['*']
    const { saves, configs } = parseWikitext(wikitext)

    // Extract Steam App ID from infobox
    const steamMatch = wikitext.match(/\|steam appid\s*=\s*(\d+)/i)
    const gogMatch = wikitext.match(/\|gogcom id\s*=\s*(\d+)/i)

    const gameData: PCGWGameData = {
      title: pageTitle,
      steamAppId: steamMatch ? steamMatch[1] : undefined,
      gogId: gogMatch ? gogMatch[1] : undefined,
      saveLocations: saves,
      configLocations: configs
    }

    // Cache result
    cache.set(cacheKey, { data: gameData, timestamp: Date.now() })

    return gameData
  } catch (err) {
    console.warn('[PCGW] Failed to fetch game data:', err)
    return null
  }
}

/**
 * Get save locations for a game
 * Tries Steam App ID first, then title search
 */
export async function getSaveLocations(options: {
  steamAppId?: string
  title?: string
}): Promise<PCGWSaveLocation[]> {
  let pageTitle: string | null = null

  // Try Steam App ID first
  if (options.steamAppId) {
    pageTitle = await searchBySteamAppId(options.steamAppId)
    if (pageTitle) {
      console.log('[PCGW] Found game by Steam ID:', pageTitle)
    }
  }

  // Fall back to title search
  if (!pageTitle && options.title) {
    pageTitle = await searchByTitle(options.title)
    if (pageTitle) {
      console.log('[PCGW] Found game by title:', pageTitle)
    }
  }

  if (!pageTitle) {
    console.log('[PCGW] Game not found')
    return []
  }

  const gameData = await fetchGameData(pageTitle)
  if (!gameData) {
    return []
  }

  console.log('[PCGW] Save locations found:', gameData.saveLocations.length)
  return gameData.saveLocations
}

/**
 * Get Windows save paths converted for a Wine prefix
 */
export async function getWinePrefixSavePaths(options: {
  steamAppId?: string
  title?: string
  winePrefix: string
  steamUserId?: string
  gameInstallPath?: string
}): Promise<string[]> {
  const locations = await getSaveLocations(options)
  
  // Filter to Windows paths and convert
  const windowsPaths = locations
    .filter(l => l.platform === 'Windows')
    .map(l => {
      let converted = windowsPathToWinePrefix(l.path, options.winePrefix, options.steamUserId)
      
      // Replace game path placeholder if we have install path
      if (options.gameInstallPath) {
        converted = converted.replace(/<GAME>/g, options.gameInstallPath)
      }
      
      return converted
    })
    .filter(p => !p.includes('<')) // Remove paths with unresolved placeholders

  return windowsPaths
}

/**
 * Resolve PCGamingWiki save folders on native Windows, not a Wine prefix.
 * Unknown placeholders are rejected rather than used as literal directories.
 */
export async function getWindowsNativeSavePaths(options: {
  steamAppId?: string
  title?: string
  gameInstallPath?: string
}): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const home = process.env.USERPROFILE || ''
  const paths = await getSaveLocations(options)
  const tokens: Record<string, string> = {
    '%USERPROFILE%': home,
    '%APPDATA%': process.env.APPDATA || '',
    '%LOCALAPPDATA%': process.env.LOCALAPPDATA || '',
    '%PUBLIC%': process.env.PUBLIC || '',
    '%PROGRAMDATA%': process.env.PROGRAMDATA || '',
    '%PROGRAMFILES%': process.env.ProgramFiles || '',
    '%PROGRAMFILES(X86)%': process.env['ProgramFiles(x86)'] || '',
    '%WINDIR%': process.env.WINDIR || '',
    '<GAME>': options.gameInstallPath || '',
    '<USERNAME>': process.env.USERNAME || ''
  }
  const results = new Set<string>()
  for (const item of paths) {
    if (item.platform.toLowerCase() !== 'windows') continue
    let p = item.path
    for (const [token, value] of Object.entries(tokens)) {
      p = p.split(token).join(value)
    }
    if (!p || /[<>%]/.test(p)) continue
    const resolved = path.win32.normalize(p)
    if (!path.win32.isAbsolute(resolved)) continue
    results.add(resolved)
  }
  return [...results]
}
