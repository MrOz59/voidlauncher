import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'

// Import types and hooks from library module
import {
  Game,
  UpdateQueueState,
  UpdatingGameState,
  LaunchState,
  PrefixJobState,
  useAchievements,
  useOnlineFixIni,
  useVpn,
  useGameConfig,
  useCloudSaves,
  useFilteredGames,
  hasUpdate
} from './library'

// Import components from library module
import { GameCard } from './library/GameCard'
import { CloudSavesBanner } from './library/CloudSavesBanner'
import { LibraryFilters } from './library/LibraryFilters'
import { AchievementsModal } from './library/AchievementsModal'
import { ProtonLogModal } from './library/ProtonLogModal'
import { SchemaEditorModal } from './library/SchemaEditorModal'
import { ConfigModal } from './library/ConfigModal'
import { useI18n } from '../i18n'
import { ipcErrorText } from '../../shared/ipcErrors'

// Spinner and achievement styles
const spinnerStyles = `
  @keyframes of-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .of-spin { animation: of-spin 0.9s linear infinite; }

  /* 100% achievements: keep the SVG sharp without scaling and animate a button ring */
  .action-btn.achievements { position: relative; }
  .action-btn.achievements svg { shape-rendering: geometricPrecision; }

  @keyframes of-achv-ring {
    0%, 100% { transform: scale(1); opacity: 0.35; }
    50% { transform: scale(1.18); opacity: 0.0; }
  }
  .action-btn.achievements.of-achv-complete-btn {
    background: rgba(245, 158, 11, 0.14);
  }
  .action-btn.achievements.of-achv-complete-btn:hover {
    background: rgba(245, 158, 11, 0.18);
    color: #fff;
  }
  .action-btn.achievements.of-achv-complete-btn::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 10px;
    border: 1px solid rgba(245, 158, 11, 0.55);
    pointer-events: none;
    transform-origin: 50% 50%;
    animation: of-achv-ring 1.8s ease-out infinite;
  }
  .of-achv-complete {
    color: #f59e0b;
    filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.28));
  }

  .action-btn.favorite.active {
    background: rgba(245, 158, 11, 0.14);
    color: #f59e0b;
  }
  .action-btn.favorite.active:hover {
    background: rgba(245, 158, 11, 0.18);
    color: #fff;
  }
`

// Tab fix styles
const tabFixStyles = `
  .config-modal .config-tabs {
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 8px !important;
    margin-top: 12px !important;
    background: rgba(255,255,255,0.03) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 12px !important;
    min-height: 44px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
  }
  .config-modal .config-tab-btn {
    appearance: none !important;
    -webkit-appearance: none !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    flex: 0 0 auto !important;
    padding: 10px 12px !important;
    border-radius: 10px !important;
    background: transparent !important;
    border: 1px solid transparent !important;
    color: #e5e7eb !important;
    font-weight: 600 !important;
    font-size: 13px !important;
    line-height: 1 !important;
    white-space: nowrap !important;
    cursor: pointer !important;
    user-select: none !important;
  }
  .config-modal .config-tab-btn:hover { background: rgba(255,255,255,0.04) !important; }
  .config-modal .config-tab-btn.active {
    background: rgba(255,255,255,0.10) !important;
    border-color: rgba(255,255,255,0.14) !important;
    color: #ffffff !important;
  }
  .config-modal .config-tabs::-webkit-scrollbar { height: 6px; }
  .config-modal .config-tabs::-webkit-scrollbar-track { background: transparent; }
  .config-modal .config-tabs::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 999px; }
`

export default function LibraryTab() {
  const { t } = useI18n()
  // Core state
  const [games, setGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isLinux, setIsLinux] = useState(false)
  // The fixes tab needs the system itself, not just "is it Linux": a fix says
  // which systems it is for, and skips the parts that do not apply.
  const [platform, setPlatform] = useState<string>('')

  // Library filters
  const [librarySearch, setLibrarySearch] = useState<string>('')
  const [libraryCategory, setLibraryCategory] = useState<'all' | 'favorites' | 'installed' | 'updating'>('all')
  const [librarySort, setLibrarySort] = useState<'recent' | 'name' | 'size'>('recent')

  // Action menu
  const [openActionMenuGameUrl, setOpenActionMenuGameUrl] = useState<string | null>(null)

  // Update state
  const [scanningInstalled, setScanningInstalled] = useState(false)
  const [updateQueue, setUpdateQueue] = useState<UpdateQueueState>({ running: false, queued: 0, currentGameUrl: null, lastError: null, updatedAt: 0 })
  const [updatingGames, setUpdatingGames] = useState<Record<string, UpdatingGameState>>({})

  // Launch/prefix state
  const [launchingGames, setLaunchingGames] = useState<Record<string, LaunchState>>({})
  const [prefixJobs, setPrefixJobs] = useState<Record<string, PrefixJobState>>({})
  const [protonLogViewer, setProtonLogViewer] = useState<{ gameUrl: string; title: string; logPath?: string | null } | null>(null)
  const [protonLogState, setProtonLogState] = useState<{ text: string; loading: boolean; live: boolean; error: string | null; updatedAt?: number | null }>({
    text: '',
    loading: false,
    live: false,
    error: null,
    updatedAt: null
  })

  // Configuring exe
  const [configuring, setConfiguring] = useState<string | null>(null)

  // Refs
  const gamesRef = useRef<Game[]>([])
  const downloadKeyToGameUrlRef = useRef<Map<string, string>>(new Map())

  // Custom hooks
  const achievements = useAchievements()
  const onlineFixIni = useOnlineFixIni()
  const cloudSaves = useCloudSaves()
  const gameConfig = useGameConfig(gamesRef)

  // VPN hook needs config state
  const vpn = useVpn(
    !!gameConfig.showConfig,
    gameConfig.configTab,
    gameConfig.lanMode,
    gameConfig.lanNetworkId
  )

  // Filtered games
  const filteredGames = useFilteredGames({
    games,
    search: librarySearch,
    category: libraryCategory,
    sort: librarySort,
    updatingGames,
    updateQueue
  })

  // Sync games ref
  useEffect(() => {
    gamesRef.current = games
    const next = new Map<string, string>()
    try {
      for (const g of games || []) {
        const url = String((g as any)?.url || '').trim()
        if (!url) continue
        const magnet = String((g as any)?.torrent_magnet || '').trim()
        const dl = String((g as any)?.download_url || '').trim()
        if (magnet) next.set(magnet, url)
        if (dl) next.set(dl, url)
      }
    } catch {}
    downloadKeyToGameUrlRef.current = next
  }, [games])

  // Close action menu on outside click
  useEffect(() => {
    if (!openActionMenuGameUrl) return
    const onDocClick = () => setOpenActionMenuGameUrl(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenActionMenuGameUrl(null)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openActionMenuGameUrl])

  // Load games function
  const loadGames = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.getGames()
      if (result.success) {
        const list = result.games || []
        setGames(list)
        refreshActiveUpdates(list)
      } else {
        setError(ipcErrorText(t, result, t('library.error.loadGames')))
      }
    } catch (error: any) {
      console.error('Failed to load games:', error)
      setError(error?.message || t('library.error.loadLibrary'))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Refresh active updates
  const refreshActiveUpdates = useCallback(async (gameList?: Game[]) => {
    try {
      const res = await window.electronAPI.getActiveDownloads()
      if (!res.success) return
      const list = gameList || gamesRef.current
      const map: Record<string, UpdatingGameState> = {}
      ;(res.downloads || []).forEach((d: any) => {
        const key = d.info_hash || d.download_url
        if (!key) return
        const match = list.find(g => g.torrent_magnet === key || g.download_url === key || g.url === d.game_url)
        if (match) map[match.url] = { status: 'downloading', id: key }
      })
      if (Object.keys(map).length) setUpdatingGames(prev => ({ ...prev, ...map }))
    } catch {}
  }, [])

  // Toggle favorite
  const toggleFavorite = useCallback(async (gameUrl: string) => {
    try {
      const fn = (window.electronAPI as any)?.toggleGameFavorite
      if (typeof fn !== 'function') throw new Error(t('library.error.favoriteApiMissing'))
      const res: any = await fn(gameUrl)
      if (!res?.success) throw new Error(res?.error || t('library.error.favorite'))
      setGames((prev) => (prev || []).map((g) => (g.url === gameUrl ? { ...g, is_favorite: res.isFavorite ? 1 : 0 } : g)))
    } catch (e: any) {
      alert(e?.message || t('library.error.favorite'))
    }
  }, [t])

  // Play game
  const playGame = useCallback(async (game: Game) => {
    try {
      setLaunchingGames(prev => ({
        ...prev,
        [game.url]: { status: 'starting', message: t('library.launch.starting'), updatedAt: Date.now() }
      }))

      const launch = await window.electronAPI.launchGame(game.url)

      if (!launch.success && launch.error === 'missing_exe') {
        setLaunchingGames(prev => ({ ...prev, [game.url]: { status: 'error', message: t('library.launch.missingExe'), updatedAt: Date.now() } }))
        alert(t('library.launch.missingExe'))
        return
      }
      if (!launch.success) {
        setLaunchingGames(prev => ({ ...prev, [game.url]: { status: 'error', message: launch.error || t('library.launch.failed'), updatedAt: Date.now() } }))
        alert(launch.error || t('library.launch.failedGame'))
      }
    } catch (err: any) {
      console.error('[Library] Falha ao iniciar jogo', err)
      setLaunchingGames(prev => ({ ...prev, [game.url]: { status: 'error', message: err?.message || t('library.launch.failed'), updatedAt: Date.now() } }))
      alert(err?.message || t('library.launch.failedGame'))
    }
  }, [t])

  // Stop game
  const stopGame = useCallback(async (game: Game) => {
    setLaunchingGames(prev => ({
      ...prev,
      [game.url]: {
        ...(prev[game.url] || { status: 'starting', updatedAt: Date.now() }),
        status: 'starting',
        message: t('library.card.stopping'),
        updatedAt: Date.now()
      }
    }))
    const res = await window.electronAPI.stopGame?.(game.url, true)
    if (!res?.success) alert(res?.error || t('library.stop.failed'))
  }, [t])

  // Update game
  const updateGame = useCallback(async (game: Game) => {
    if (updateQueue.running) {
      alert(t('library.update.queueRunning'))
      return
    }
    if (updatingGames[game.url]) return
    if (!hasUpdate(game)) {
      alert(t('library.update.noneAvailable'))
      return
    }

    setUpdatingGames(prev => ({ ...prev, [game.url]: { status: 'starting' } }))
    try {
      let torrentUrl = ''
      const info = await window.electronAPI.fetchGameUpdateInfo(game.url)
      if (!info.success) throw new Error(info.error || t('library.update.fetchFailed'))
      if (info.latest) setGames(prev => prev.map(g => g.url === game.url ? { ...g, latest_version: info.latest ?? g.latest_version } : g))
      if (info.torrentUrl) {
        torrentUrl = info.torrentUrl
        setGames(prev => prev.map(g => g.url === game.url ? { ...g, torrent_magnet: info.torrentUrl, download_url: info.torrentUrl } : g))
      }

      if (!torrentUrl) {
        alert(t('library.update.torrentMissing'))
        setUpdatingGames(prev => { const next = { ...prev }; delete next[game.url]; return next })
        return
      }

      const res = await window.electronAPI.startTorrentDownload(torrentUrl, game.url)
      if (!res.success) {
        alert(ipcErrorText(t, res, t('library.update.startFailed')))
        setUpdatingGames(prev => { const next = { ...prev }; delete next[game.url]; return next })
      } else {
        setUpdatingGames(prev => ({ ...prev, [game.url]: { status: 'downloading', id: torrentUrl } }))
        loadGames()
      }
    } catch (err: any) {
      console.error('[UpdateGame] Failed to start update', err)
      alert(err?.message || t('library.update.startFailed'))
      setUpdatingGames(prev => { const next = { ...prev }; delete next[game.url]; return next })
    }
  }, [updateQueue.running, updatingGames, loadGames, t])

  // Scan installed games
  const scanInstalledGames = useCallback(async () => {
    if (scanningInstalled) return
    setScanningInstalled(true)
    try {
      const res = await window.electronAPI.scanInstalledGames()
      if (!res.success) throw new Error(ipcErrorText(t, res, t('library.scan.failed')))
      await loadGames()
      alert(t('library.scan.completed', { added: res.added || 0, scanned: res.scanned || 0 }))
    } catch (err: any) {
      alert(err?.message || t('library.scan.failed'))
    } finally {
      setScanningInstalled(false)
    }
  }, [scanningInstalled, loadGames, t])

  // Delete game
  const deleteGame = useCallback(async (game: Game) => {
    if (confirm(t('library.delete.confirm', { title: game.title }))) {
      const res = await window.electronAPI.deleteGame(game.url)
      if (res.success) setGames(prev => prev.filter(g => g.url !== game.url))
      else alert(ipcErrorText(t, res, t('library.delete.failed')))
    }
  }, [t])

  // Open game folder
  const openGameFolder = useCallback(async (game: Game) => {
    if (!game.install_path) { alert(t('library.folder.missing')); return }
    const res = await window.electronAPI.openGameFolder(game.install_path)
    if (!res.success) alert(ipcErrorText(t, res, t('library.folder.openFailed')))
  }, [t])

  // Configure exe
  const configureExe = useCallback(async (game: Game) => {
    setConfiguring(game.url)
    const res = await window.electronAPI.configureGameExe(game.url)
    setConfiguring(null)
    if (res.success && res.exePath) setGames(prev => prev.map(g => g.url === game.url ? { ...g, executable_path: res.exePath } : g))
    else alert(ipcErrorText(t, res, t('library.exe.noneConfigured')))
  }, [t])

  // Open proton log modal
  const openProtonLog = useCallback((game: Game) => {
    setProtonLogViewer({
      gameUrl: game.url,
      title: game.title,
      logPath: launchingGames[game.url]?.protonLogPath || null
    })
    setProtonLogState({ text: '', loading: true, live: false, error: null, updatedAt: null })
  }, [launchingGames])

  const refreshProtonLog = useCallback(async (viewer?: { gameUrl: string; title: string; logPath?: string | null } | null, silent = false) => {
    const target = viewer || protonLogViewer
    if (!target) return

    if (!silent) {
      setProtonLogState((prev) => ({ ...prev, loading: true, error: null }))
    }

    try {
      const res = await window.electronAPI.getProtonLogSnapshot({
        gameUrl: target.gameUrl,
        logPath: target.logPath || null,
        maxChars: 250_000
      })

      if (!res?.success) {
        setProtonLogState((prev) => ({
          ...prev,
          loading: false,
          live: false,
          error: res?.error || t('library.logs.loadFailed')
        }))
        return
      }

      setProtonLogState({
        text: String(res.text || ''),
        loading: false,
        live: !!res.live,
        error: null,
        updatedAt: res.updatedAt ?? Date.now()
      })

      if (res.logPath && res.logPath !== target.logPath) {
        setProtonLogViewer((prev) => prev && prev.gameUrl === target.gameUrl ? { ...prev, logPath: res.logPath || null } : prev)
      }
    } catch (err: any) {
      setProtonLogState((prev) => ({
        ...prev,
        loading: false,
        live: false,
        error: err?.message || t('library.logs.loadFailed')
      }))
    }
  }, [protonLogViewer, t])

  // Create proton prefix
  const createProtonPrefix = useCallback(async (game: Game) => {
    setPrefixJobs(prev => ({
      ...prev,
      [game.url]: { status: 'starting', message: t('library.prefix.preparing'), updatedAt: Date.now() }
    }))
    try {
      // Prefix preparation must use the runtime currently selected in the form.
      await gameConfig.flushConfigAutosave(game, setGames)
      const res = await window.electronAPI.protonCreateGamePrefix(game.url, game.title)
      if (!res.success || !res.prefix) throw new Error(ipcErrorText(t, res, t('library.prefix.createFailed')))
      gameConfig.setProtonPrefix(res.prefix)
      setGames(prev => prev.map(g => g.url === game.url ? { ...g, proton_prefix: res.prefix } : g))
      setPrefixJobs(prev => ({ ...prev, [game.url]: { status: 'done', prefix: res.prefix, updatedAt: Date.now() } }))
    } catch (err: any) {
      const message = err?.message || t('library.prefix.createFailed')
      setPrefixJobs(prev => ({ ...prev, [game.url]: { status: 'error', message, updatedAt: Date.now() } }))
      alert(message)
    }
  }, [gameConfig, t])

  // Open config modal
  const openConfigModal = useCallback((game: Game) => {
    gameConfig.openConfig(game)
    onlineFixIni.resetState()
    onlineFixIni.loadIni(game)
    vpn.resetState()
  }, [gameConfig, onlineFixIni, vpn])

  // Open saves directly from the game card action menu.
  const openSavesModal = useCallback((game: Game) => {
    openConfigModal(game)
    gameConfig.setConfigTab('saves')
  }, [openConfigModal, gameConfig.setConfigTab])

  // Close config modal
  const closeConfigModal = useCallback(() => {
    gameConfig.closeConfig()
    onlineFixIni.clearAutosaveTimer()
  }, [gameConfig, onlineFixIni])

  // Initial load
  useEffect(() => {
    loadGames()
    gameConfig.loadProtonRuntimes()
    refreshActiveUpdates()

    // Check platform
    ;(async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        setIsLinux(Boolean(settings?.isLinux || settings?.platform === 'linux'))
        if (settings?.platform) setPlatform(String(settings.platform))
      } catch {}
    })()

    // Auto-check updates
    ;(async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (settings?.success && settings.settings?.autoUpdate === true) {
          await window.electronAPI.checkAllUpdates?.()
          try { void loadGames() } catch {}
        }
      } catch {}
    })()

    // Hydrate update queue
    ;(async () => {
      try {
        const res = await window.electronAPI.getUpdateQueueStatus?.()
        if (res?.success && res.status) setUpdateQueue(res.status)
      } catch {}
    })()

    // Subscribe to update queue changes
    const unsubQueue = window.electronAPI.onUpdateQueueStatus?.((data: any) => {
      try {
        if (!data) return
        const next = {
          running: !!data.running,
          queued: Number(data.queued) || 0,
          currentGameUrl: data.currentGameUrl ?? null,
          lastError: data.lastError ?? null,
          updatedAt: Number(data.updatedAt) || Date.now()
        }
        setUpdateQueue((prev) => {
          if (prev.running === next.running && prev.queued === next.queued && prev.currentGameUrl === next.currentGameUrl && prev.lastError === next.lastError) return prev
          return next
        })
      } catch {}
    })

    const refreshTimerRef = { current: null as any }

    const unsubVersion = window.electronAPI.onGameVersionUpdate((data) => {
      if (!data?.url) return
      setGames(prev => prev.map(g => g.url === data.url ? { ...g, latest_version: data.latest ?? g.latest_version } : g))
    })

    const unsubDownloadComplete = window.electronAPI.onDownloadComplete((data) => {
      const idKey = data?.infoHash || data?.magnet
      if (!idKey) return
      setUpdatingGames(prev => {
        const entry = Object.entries(prev).find(([, info]) => info.id === idKey)
        if (!entry) return prev
        const next = { ...prev }
        delete next[entry[0]]
        return next
      })

      if (data?.destPath) {
        try {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(() => {
            try { void loadGames() } catch {}
          }, 600)
        } catch {}
      }
    })

    const unsubDownloadProgress = window.electronAPI.onDownloadProgress?.((data) => {
      const keys = [data?.infoHash, data?.magnet, data?.url].filter(Boolean).map(k => String(k))
      if (!keys.length) return
      setUpdatingGames(prev => {
        let gameUrl = ''
        let idKey = ''
        for (const keyStr of keys) {
          const mapped = downloadKeyToGameUrlRef.current.get(keyStr)
          if (mapped) {
            gameUrl = mapped
            idKey = keyStr
            break
          }
        }
        if (!gameUrl) return prev
        const cur = prev[gameUrl]
        if (cur && cur.status === 'downloading' && String(cur.id || '') === idKey) return prev
        return { ...prev, [gameUrl]: { status: 'downloading', id: idKey } }
      })
    })

    const unsubDownloadDeleted = window.electronAPI.onDownloadDeleted?.(() => {
      setUpdatingGames({})
      try {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => {
          try {
            void loadGames()
            void refreshActiveUpdates()
          } catch {}
        }, 300)
      } catch {}
    })

    return () => {
      if (typeof unsubVersion === 'function') unsubVersion()
      if (typeof unsubDownloadComplete === 'function') unsubDownloadComplete()
      if (typeof unsubDownloadProgress === 'function') unsubDownloadProgress()
      if (typeof unsubDownloadDeleted === 'function') unsubDownloadDeleted()
      if (typeof unsubQueue === 'function') unsubQueue()
      try { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) } catch {}
    }
  }, [])

  // Game launch status listener
  useEffect(() => {
    const unsub = window.electronAPI.onGameLaunchStatus?.((data) => {
      if (!data?.gameUrl) return

      setLaunchingGames(prev => ({
        ...prev,
        [data.gameUrl]: {
          status: data.status,
          pid: data.pid,
          code: data.code,
          message: data.message,
          stderrTail: data.stderrTail,
          protonLogPath: data.protonLogPath,
          updatedAt: Date.now()
        }
      }))

      // When game exits OK, sync saves
      if (data.status === 'exited') {
        const ok = data.code == null || Number(data.code) === 0
        if (ok) {
          setTimeout(() => { void cloudSaves.runSaveSync(data.gameUrl, 'game_exited') }, 600)
        }
      }

      // Auto-clear successful exits
      if (data.status === 'exited' && (data.code == null || Number(data.code) === 0)) {
        const url = data.gameUrl
        setTimeout(() => {
          setLaunchingGames(p => {
            const cur = p[url]
            if (!cur || cur.status !== 'exited') return p
            if (cur.code != null && Number(cur.code) !== 0) return p
            const next = { ...p }
            delete next[url]
            return next
          })
        }, 2500)
      }
    })
    return () => { try { unsub?.() } catch {} }
  }, [cloudSaves])

  useEffect(() => {
    if (!protonLogViewer) return
    const latestPath = launchingGames[protonLogViewer.gameUrl]?.protonLogPath
    if (latestPath && latestPath !== protonLogViewer.logPath) {
      setProtonLogViewer((prev) => prev ? { ...prev, logPath: latestPath } : prev)
    }
  }, [launchingGames, protonLogViewer])

  useEffect(() => {
    if (!protonLogViewer) return
    void refreshProtonLog(protonLogViewer)
    const timer = setInterval(() => {
      void refreshProtonLog(protonLogViewer, true)
    }, 1000)
    return () => clearInterval(timer)
  }, [protonLogViewer, refreshProtonLog])

  // Prefix job status listener
  useEffect(() => {
    const unsub = window.electronAPI.onPrefixJobStatus?.((data) => {
      if (!data?.gameUrl) return
      setPrefixJobs(prev => ({
        ...prev,
        [data.gameUrl]: {
          status: data.status,
          message: data.message,
          prefix: data.prefix,
          updatedAt: Date.now()
        }
      }))

      if (data.status === 'done') {
        if (data.prefix) {
          setGames(prev => prev.map(g => g.url === data.gameUrl ? { ...g, proton_prefix: data.prefix } : g))
          if (gameConfig.showConfig === data.gameUrl) gameConfig.setProtonPrefix(data.prefix)
        }
        const url = data.gameUrl
        setTimeout(() => {
          setPrefixJobs(p => {
            const cur = p[url]
            if (!cur || cur.status !== 'done') return p
            const next = { ...p }
            delete next[url]
            return next
          })
        }, 2000)
      }
    })
    return () => { try { unsub?.() } catch {} }
  }, [gameConfig.showConfig, gameConfig.setProtonPrefix])

  // Config autosave effect - use JSON.stringify for objects to avoid reference comparison issues
  const protonOptionsJson = JSON.stringify(gameConfig.protonOptions)
  useEffect(() => {
    if (!gameConfig.showConfig) return
    if (gameConfig.suppressConfigAutosaveRef.current) return
    const game = gamesRef.current.find(g => g.url === gameConfig.showConfig)
    if (!game) return
    gameConfig.scheduleConfigAutosave(game, setGames)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gameConfig.showConfig,
    gameConfig.titleValue,
    gameConfig.versionValue,
    gameConfig.protonVersion,
    protonOptionsJson,
    gameConfig.steamAppId,
    gameConfig.protonPrefix,
    gameConfig.lanMode,
    gameConfig.lanNetworkId,
    gameConfig.lanAutoconnect,
    gameConfig.scheduleConfigAutosave
  ])

  // INI autosave effect
  useEffect(() => {
    if (!gameConfig.showConfig) return
    const game = gamesRef.current.find(g => g.url === gameConfig.showConfig)
    if (!game?.install_path) return
    if (!onlineFixIni.iniDirty) return
    if (onlineFixIni.iniLoading || onlineFixIni.iniSaving) return

    if (onlineFixIni.iniAutosaveTimerRef.current) clearTimeout(onlineFixIni.iniAutosaveTimerRef.current)
    onlineFixIni.iniAutosaveTimerRef.current = setTimeout(() => {
      onlineFixIni.iniAutosaveTimerRef.current = null
      void onlineFixIni.saveIni(game)
    }, 1200)
  }, [gameConfig.showConfig, onlineFixIni.iniDirty, onlineFixIni.iniFields, onlineFixIni.iniLoading, onlineFixIni.iniSaving, onlineFixIni])

  // Get current config game
  const configGame = gameConfig.showConfig ? games.find(g => g.url === gameConfig.showConfig) : null

  // Render
  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>{t('library.loading')}</p>
      </div>
    )
  }

  return (
    <div className="library-tab">
      <style>{spinnerStyles + tabFixStyles}</style>

      {error && (
        <div className="error-banner">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* Cloud Saves Banner */}
      {cloudSaves.cloudSavesBanner && (
        <CloudSavesBanner
          banner={cloudSaves.cloudSavesBanner}
          games={games}
          onOpenBackups={cloudSaves.openCloudBackupsForBanner}
          onClose={cloudSaves.closeBanner}
        />
      )}

      {/* Library Filters */}
      <LibraryFilters
        search={librarySearch}
        onSearchChange={setLibrarySearch}
        category={libraryCategory}
        onCategoryChange={setLibraryCategory}
        sort={librarySort}
        onSortChange={setLibrarySort}
        onScan={scanInstalledGames}
        scanning={scanningInstalled}
      />

      {/* Games Grid */}
      <div className="library-grid-heroic">
        {filteredGames.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            launchState={launchingGames[game.url]}
            prefixState={prefixJobs[game.url]}
            syncState={cloudSaves.saveSyncJobs[game.url]}
            achievementProgress={achievements.progressByGameUrl[game.url]}
            updatingGames={updatingGames}
            updateQueue={updateQueue}
            isActionMenuOpen={openActionMenuGameUrl === game.url}
            onToggleActionMenu={() => setOpenActionMenuGameUrl(cur => cur === game.url ? null : game.url)}
            onCloseActionMenu={() => setOpenActionMenuGameUrl(null)}
            onOpenConfig={() => openConfigModal(game)}
            onOpenSaves={() => openSavesModal(game)}
            onToggleFavorite={() => toggleFavorite(game.url)}
            onOpenFolder={() => openGameFolder(game)}
            onUpdate={() => updateGame(game)}
            onOpenProtonLog={() => openProtonLog(game)}
            onDelete={() => deleteGame(game)}
            onOpenAchievements={() => achievements.openModal(game.url, game.title)}
            onPlay={() => playGame(game)}
            onStop={() => stopGame(game)}
          />
        ))}
      </div>

      {/* Achievements Modal */}
      {achievements.modalGameUrl && (
        <>
          <AchievementsModal
            gameUrl={achievements.modalGameUrl}
            title={achievements.modalTitle}
            loading={achievements.modalLoading}
            error={achievements.modalError}
            sources={achievements.modalSources}
            items={achievements.modalItems}
            revealedHiddenIds={achievements.revealedHiddenIds}
            schemaRefreshedOnce={achievements.schemaRefreshedOnce}
            onClose={achievements.closeModal}
            onReload={() => achievements.loadAchievementsForGameUrl(achievements.modalGameUrl!)}
            onImportSchema={async () => {
              if (!achievements.modalGameUrl) return
              const res: any = await window.electronAPI.importAchievementSchema?.(achievements.modalGameUrl)
              if (!res?.success) {
                alert(res?.error || t('library.schema.importFailed'))
                return
              }
              await achievements.loadAchievementsForGameUrl(achievements.modalGameUrl)
            }}
            onCreateSchema={() => achievements.openSchemaEditor(true)}
            onRemoveSchema={async () => {
              if (!achievements.modalGameUrl) return
              const ok = confirm(t('library.schema.removeConfirm'))
              if (!ok) return
              const res: any = await window.electronAPI.clearAchievementSchema?.(achievements.modalGameUrl)
              if (!res?.success) {
                alert(res?.error || t('library.schema.removeFailed'))
                return
              }
              await achievements.loadAchievementsForGameUrl(achievements.modalGameUrl)
            }}
            onRevealHidden={(id, hasMeaningfulName, hasMeaningfulDesc) => {
              achievements.revealHiddenAchievement(id)
              // Force refresh schema if needed
              if (!achievements.schemaRefreshedOnce && (!hasMeaningfulName || !hasMeaningfulDesc) && achievements.modalGameUrl) {
                achievements.setSchemaRefreshedOnce(true)
                void window.electronAPI.forceRefreshAchievementSchema(achievements.modalGameUrl).then(() => {
                  void achievements.loadAchievementsForGameUrl(achievements.modalGameUrl!)
                })
              }
            }}
            onForceRefreshSchema={async () => {
              if (!achievements.modalGameUrl) return
              await window.electronAPI.forceRefreshAchievementSchema(achievements.modalGameUrl)
              await achievements.loadAchievementsForGameUrl(achievements.modalGameUrl)
            }}
          />

          {/* Schema Editor Modal */}
          {achievements.schemaEditorOpen && (
            <SchemaEditorModal
              title={achievements.modalTitle}
              value={achievements.schemaEditorValue}
              error={achievements.schemaEditorError}
              busy={achievements.schemaEditorBusy}
              onValueChange={achievements.setSchemaEditorValue}
              onClose={() => achievements.setSchemaEditorOpen(false)}
              onGenerateTemplate={() => achievements.openSchemaEditor(true)}
              onCopy={async () => {
                try {
                  await navigator.clipboard.writeText(achievements.schemaEditorValue || '')
                } catch {}
              }}
              onClear={() => achievements.setSchemaEditorValue(JSON.stringify({ items: [] }, null, 2))}
              onSave={async () => {
                if (!achievements.modalGameUrl) return
                achievements.setSchemaEditorBusy(true)
                achievements.setSchemaEditorError(null)
                try {
                  const res: any = await window.electronAPI.saveAchievementSchema?.(achievements.modalGameUrl, achievements.schemaEditorValue)
                  if (!res?.success) {
                    achievements.setSchemaEditorError(res?.error || t('library.schema.saveFailed'))
                    return
                  }
                  achievements.setSchemaEditorOpen(false)
                  await achievements.loadAchievementsForGameUrl(achievements.modalGameUrl)
                } catch (e: any) {
                  achievements.setSchemaEditorError(e?.message || t('library.schema.saveFailed'))
                } finally {
                  achievements.setSchemaEditorBusy(false)
                }
              }}
            />
          )}
        </>
      )}

      {protonLogViewer && (
        <ProtonLogModal
          title={protonLogViewer.title}
          text={protonLogState.text}
          loading={protonLogState.loading}
          live={protonLogState.live}
          error={protonLogState.error}
          logPath={protonLogViewer.logPath}
          updatedAt={protonLogState.updatedAt}
          onRefresh={() => { void refreshProtonLog() }}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(protonLogState.text || '')
            } catch {}
          }}
          onClose={() => setProtonLogViewer(null)}
        />
      )}

      {/* Config Modal */}
      {configGame && (
        <ConfigModal
          game={configGame}
          isLinux={isLinux}
          platform={platform}

          // Tab state
          configTab={gameConfig.configTab}
          onTabChange={gameConfig.setConfigTab}
          configSaveState={gameConfig.configSaveState}

          // General tab
          titleValue={gameConfig.titleValue}
          onTitleChange={gameConfig.setTitleValue}
          versionValue={gameConfig.versionValue}
          onVersionChange={gameConfig.setVersionValue}
          bannerLoading={gameConfig.bannerLoading}
          bannerManualUrl={gameConfig.bannerManualUrl}
          onBannerManualUrlChange={gameConfig.setBannerManualUrl}
          bannerManualBusy={gameConfig.bannerManualBusy}
          onFetchBanner={() => gameConfig.fetchBanner(configGame, setGames)}
          onApplyBannerUrl={() => gameConfig.applyBannerUrl(configGame, setGames)}
          onPickBannerFile={() => gameConfig.pickBannerFile(configGame, setGames)}
          onClearBanner={() => gameConfig.clearBanner(configGame, setGames)}
          configuring={configuring}
          onConfigureExe={() => configureExe(configGame)}
          onDelete={() => { closeConfigModal(); deleteGame(configGame) }}

          // OnlineFix.ini tab
          iniPath={onlineFixIni.iniPath}
          iniError={onlineFixIni.iniError}
          iniLoading={onlineFixIni.iniLoading}
          iniSaving={onlineFixIni.iniSaving}
          iniDirty={onlineFixIni.iniDirty}
          iniFields={onlineFixIni.iniFields}
          iniLastSavedAt={onlineFixIni.iniLastSavedAt}
          onReloadIni={() => onlineFixIni.loadIni(configGame)}
          onUpdateIniField={onlineFixIni.updateField}
          onUpdateIniFieldKey={onlineFixIni.updateFieldKey}
          onAddIniField={onlineFixIni.addField}
          onRemoveIniField={onlineFixIni.removeField}
          onReprocessIni={onlineFixIni.reprocessText}

          // Proton tab
          protonPrefix={gameConfig.protonPrefix}
          prefixJobs={prefixJobs}
          onCreatePrefix={() => createProtonPrefix(configGame)}
          protonVersion={gameConfig.protonVersion}
          onProtonVersionChange={gameConfig.setProtonVersion}
          protonRuntimes={gameConfig.protonRuntimes}
          protonRootInput={gameConfig.protonRootInput}
          onProtonRootInputChange={gameConfig.setProtonRootInput}
          onAddProtonRoot={gameConfig.addProtonRoot}
          steamAppId={gameConfig.steamAppId}
          onSteamAppIdChange={gameConfig.setSteamAppId}
          protonOptions={gameConfig.protonOptions}
          onProtonOptionsChange={gameConfig.setProtonOptions}
          onGameFixApplied={(patch) => {
            setGames(prev => prev.map(g => g.url === configGame.url ? { ...g, ...patch } : g))
            if (Object.prototype.hasOwnProperty.call(patch, 'proton_runtime')) {
              gameConfig.setProtonVersion((patch.proton_runtime as string | null) || '')
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'steam_app_id')) {
              gameConfig.setSteamAppId(patch.steam_app_id ? String(patch.steam_app_id) : '')
            }
            if (typeof patch.proton_options === 'string') {
              try {
                const parsed = JSON.parse(patch.proton_options)
                gameConfig.setProtonOptions({
                  esync: parsed.esync !== false,
                  fsync: parsed.fsync !== false,
                  dxvk: parsed.dxvk !== false,
                  mesa_glthread: !!parsed.mesa_glthread,
                  locale: parsed.locale || '',
                  gamemode: !!parsed.gamemode,
                  mangohud: !!parsed.mangohud,
                  logging: !!parsed.logging,
                  steamOverlay: parsed.steamOverlay !== false,
                  launchArgs: parsed.launchArgs || '',
                  useGamescope: !!parsed.useGamescope,
                  wineDllOverrides: parsed.wineDllOverrides || ''
                })
              } catch {}
            }
          }}

          // LAN tab
          lanMode={gameConfig.lanMode}
          onLanModeChange={gameConfig.setLanMode}
          lanRoomCode={vpn.lanRoomCode}
          onLanRoomCodeChange={vpn.setLanRoomCode}
          lanRoomBusy={vpn.lanRoomBusy}
          onCreateRoom={(options) => vpn.createRoom(gameConfig.titleValue, gameConfig.setLanNetworkId, options)}
          onJoinRoom={(password, codeOverride) => vpn.joinRoom(codeOverride || vpn.lanRoomCode, gameConfig.titleValue, gameConfig.setLanNetworkId, password)}
          onLeaveRoom={() => vpn.leaveRoom(gameConfig.setLanNetworkId)}
          lanNetworkId={gameConfig.lanNetworkId}
          lanRoomName={vpn.currentRoomName || gameConfig.lanNetworkId}
          vpnLocalIp={vpn.vpnLocalIp}
          vpnHostIp={vpn.vpnHostIp}
          vpnPeerId={vpn.vpnPeerId}
          lanAutoconnect={gameConfig.lanAutoconnect}
          onLanAutoconnectChange={gameConfig.setLanAutoconnect}
          vpnLoading={vpn.vpnLoading}
          vpnHasLoaded={vpn.vpnHasLoaded}
          vpnError={vpn.vpnError}
          vpnStatus={vpn.vpnStatus}
          vpnConnected={vpn.vpnConnected}
          vpnActionBusy={vpn.vpnActionBusy}
          onInstallVpn={vpn.installVpn}
          onConnectVpn={vpn.connect}
          onDisconnectVpn={vpn.disconnect}
          vpnPeers={vpn.vpnPeers}
          vpnRooms={vpn.publicRooms}
          onRefreshRooms={() => vpn.loadPublicRooms(gameConfig.titleValue)}
          onCopyToClipboard={vpn.copyToClipboard}
          vpnConfig={vpn.vpnConfig}

          // Close
          onClose={closeConfigModal}
        />
      )}
    </div>
  )
}
