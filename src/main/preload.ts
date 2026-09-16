import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type DownloadProgressPayload = {
  url?: string
  magnet?: string
  progress: number
  speed?: number
  eta?: number
  downloaded?: number
  total?: number
  infoHash?: string
  destPath?: string
  peers?: number
  seeds?: number
  statusMessage?: string
  agentState?: string
  hasMetadata?: boolean
  stage?: 'download' | 'extract'
  extractProgress?: number
}

type GameLaunchStatusPayload = {
  gameUrl: string
  status: 'starting' | 'running' | 'exited' | 'error'
  pid?: number
  code?: number | null
  signal?: string | null
  message?: string
  stderrTail?: string
  protonLogPath?: string
}

type PrefixJobStatusPayload = {
  gameUrl: string
  status: 'starting' | 'progress' | 'done' | 'error'
  message?: string
  prefix?: string
}

type DriveListItem = {
  id: string
  name: string
  mimeType?: string
  size?: number
  modifiedTime?: string
  createdTime?: string
}

type CloudSavesStatusPayload = {
  at: number
  gameUrl?: string
  gameKey?: string
  stage: 'restore' | 'backup'
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  conflict?: boolean
}

type LauncherTaskStatusPayload = {
  activeCount: number
  recentCount: number
  active: any[]
  recent: any[]
  updatedAt: number
}

contextBridge.exposeInMainWorld('electronAPI', {
  getStoreWebviewPreloadUrl: () => ipcRenderer.sendSync('get-store-webview-preload-url'),
  openAuthWindow: () => ipcRenderer.invoke('open-auth-window'),
  checkGameVersion: (url: string) => ipcRenderer.invoke('check-game-version', url),
  getStoreLoginStatus: () => ipcRenderer.invoke('get-store-login-status'),
  clearCookies: () => ipcRenderer.invoke('clear-cookies'),

  onCookiesSaved: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('cookies-saved', handler)
    return () => ipcRenderer.removeListener('cookies-saved', handler)
  },

  onCookiesCleared: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('cookies-cleared', handler)
    return () => ipcRenderer.removeListener('cookies-cleared', handler)
  },

  downloadHttp: (url: string, dest: string) => ipcRenderer.invoke('download-http', url, dest),
  downloadTorrent: (magnet: string, dest: string) => ipcRenderer.invoke('download-torrent', magnet, dest),
  startTorrentDownload: (url: string, referer?: string) => ipcRenderer.invoke('start-torrent-download', url, referer),
  pauseDownload: (torrentId: string) => ipcRenderer.invoke('pause-download', torrentId),
  resumeDownload: (torrentId: string) => ipcRenderer.invoke('resume-download', torrentId),
  cancelDownload: (torrentId: string) => ipcRenderer.invoke('cancel-download', torrentId),
  getActiveDownloads: () => ipcRenderer.invoke('get-active-downloads'),
  getCompletedDownloads: () => ipcRenderer.invoke('get-completed-downloads'),
  deleteDownload: (downloadId: number) => ipcRenderer.invoke('delete-download', downloadId),

  // Download Queue APIs
  getDownloadQueueStatus: () => ipcRenderer.invoke('get-download-queue-status'),
  getTaskQueueStatus: () => ipcRenderer.invoke('get-task-queue-status'),
  reconcileDownloads: () => ipcRenderer.invoke('reconcile-downloads'),
  prioritizeDownload: (queueId: string) => ipcRenderer.invoke('prioritize-download', queueId),
  removeFromDownloadQueue: (queueId: string) => ipcRenderer.invoke('remove-from-queue', queueId),
  swapActiveDownload: (queueId: string) => ipcRenderer.invoke('swap-active-download', queueId),
  onDownloadQueueStatus: (cb: (data: any) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data)
    ipcRenderer.on('download-queue-status', handler)
    return () => ipcRenderer.removeListener('download-queue-status', handler)
  },
  onTaskStatus: (cb: (data: LauncherTaskStatusPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: LauncherTaskStatusPayload) => cb(data)
    ipcRenderer.on('task-status', handler)
    return () => ipcRenderer.removeListener('task-status', handler)
  },

  getOnlineFixIni: (gameUrl: string) => ipcRenderer.invoke('get-onlinefix-ini', gameUrl),
  saveOnlineFixIni: (gameUrl: string, content: string) => ipcRenderer.invoke('save-onlinefix-ini', gameUrl, content),

  fetchGameImage: (gameUrl: string, title: string) => ipcRenderer.invoke('fetch-game-image', gameUrl, title),
  setGameImageUrl: (gameUrl: string, imageUrl: string | null) =>
    ipcRenderer.invoke('set-game-image-url', gameUrl, imageUrl),
  pickGameBannerFile: (gameUrl: string) => ipcRenderer.invoke('pick-game-banner-file', gameUrl),

  fetchGameUpdateInfo: (gameUrl: string) => ipcRenderer.invoke('fetch-game-update-info', gameUrl),
  getUserProfile: () => ipcRenderer.invoke('get-user-profile'),
  checkAllUpdates: () => ipcRenderer.invoke('check-all-updates'),

  scanInstalledGames: () => ipcRenderer.invoke('scan-installed-games'),

  queueGameUpdates: (gameUrls: string[]) => ipcRenderer.invoke('queue-game-updates', gameUrls),
  clearUpdateQueue: () => ipcRenderer.invoke('clear-update-queue'),
  getUpdateQueueStatus: () => ipcRenderer.invoke('get-update-queue-status'),

  openPath: (target: string) => ipcRenderer.invoke('open-path', target),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  getLauncherDiagnostics: () => ipcRenderer.invoke('get-launcher-diagnostics'),
  storeListing: (payload?: { page?: number; query?: string; force?: boolean }) =>
    ipcRenderer.invoke('store-listing', payload || {}),
  storeGame: (url: string, force?: boolean) => ipcRenderer.invoke('store-game', { url, force }),
  storeTranslateInstructions: (url: string, instructions: string[], language?: string, force?: boolean) =>
    ipcRenderer.invoke('store-translate-instructions', { url, instructions, language, force }),
  storeGameMetadata: (url: string, title: string, steamAppId?: string) =>
    ipcRenderer.invoke('store-game-metadata', { url, title, steamAppId }),
  storeGameComments: (url: string, page?: number, force?: boolean) =>
    ipcRenderer.invoke('store-game-comments', { url, page, force }),
  storePostComment: (url: string, text: string) => ipcRenderer.invoke('store-post-comment', { url, text }),
  storeCaptureFixture: (url: string, name?: string) => ipcRenderer.invoke('store-capture-fixture', { url, name }),
  storeClearCache: () => ipcRenderer.invoke('store-clear-cache'),
  setUiLanguage: (language: string) => ipcRenderer.invoke('set-ui-language', language),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  getLauncherUpdateStatus: (force?: boolean) => ipcRenderer.invoke('get-launcher-update-status', { force }),
  installLauncherAppImageUpdate: () => ipcRenderer.invoke('install-launcher-appimage-update'),
  getToolsStatus: () => ipcRenderer.invoke('tools-status'),
  listToolReleases: (tool: 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay', limit?: number, force?: boolean) =>
    ipcRenderer.invoke('tools-list-releases', { tool, limit, force }),
  installTool: (tool: 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay', version?: string) =>
    ipcRenderer.invoke('tools-install', { tool, version }),
  legendaryAuth: (action: 'status' | 'login' | 'logout') =>
    ipcRenderer.invoke('tools-legendary-auth', { action }),
  eosOverlayAction: (action: 'info' | 'install' | 'update' | 'remove') =>
    ipcRenderer.invoke('tools-eos-overlay-action', { action }),
  setDefaultProtonRuntime: (runtimePath: string) => ipcRenderer.invoke('tools-set-proton-default', runtimePath),
  removeProtonGeRuntime: (runtimePath: string) => ipcRenderer.invoke('tools-remove-proton-ge', runtimePath),
  listLanguagePacks: () => ipcRenderer.invoke('i18n-list-language-packs'),

  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  extractDownload: (downloadId: number | string, path?: string) => ipcRenderer.invoke('extract-download', downloadId, path),

  protonEnsureRuntime: (customPath?: string) => ipcRenderer.invoke('proton-ensure-runtime', customPath),
  protonListRuntimes: (force?: boolean) => ipcRenderer.invoke('proton-list-runtimes', force),
  protonSetRoot: (rootPath: string) => ipcRenderer.invoke('proton-set-root', rootPath),
  protonDefaultPrefix: (forceRecreate?: boolean) => ipcRenderer.invoke('proton-default-prefix', forceRecreate),
  protonPreparePrefix: (slug: string) => ipcRenderer.invoke('proton-prepare-prefix', slug),
  protonBuildLaunch: (
    exePath: string,
    args: string[],
    slug: string,
    runtimePath?: string,
    prefixPath?: string
  ) => ipcRenderer.invoke('proton-build-launch', exePath, args, slug, runtimePath, prefixPath),
  protonCreateGamePrefix: (gameUrl: string, title?: string, commonRedistPath?: string) =>
    ipcRenderer.invoke('proton-create-game-prefix', gameUrl, title, commonRedistPath),
  winetricksStatus: () => ipcRenderer.invoke('winetricks-status'),
  runWinetricks: (gameUrl: string, components: string[]) =>
    ipcRenderer.invoke('winetricks-run', gameUrl, components),
  protonOpenTricksGui: (gameUrl: string) => ipcRenderer.invoke('proton-open-tricks-gui', gameUrl),
  protonOpenWinecfg: (gameUrl: string) => ipcRenderer.invoke('proton-open-winecfg', gameUrl),
  protonOpenRegedit: (gameUrl: string) => ipcRenderer.invoke('proton-open-regedit', gameUrl),
  protonOpenFileManager: (gameUrl: string) => ipcRenderer.invoke('proton-open-filemanager', gameUrl),

  setGameProtonPrefix: (gameUrl: string, prefixPath: string | null) =>
    ipcRenderer.invoke('set-game-proton-prefix', gameUrl, prefixPath),
  setGameSteamAppId: (gameUrl: string, steamAppId: string | null) =>
    ipcRenderer.invoke('set-game-steam-appid', gameUrl, steamAppId),

  getGames: () => ipcRenderer.invoke('get-games'),
  getGameDiagnostics: (gameUrl: string) => ipcRenderer.invoke('get-game-diagnostics', gameUrl),
  repairGameDiagnostics: (gameUrl: string) => ipcRenderer.invoke('repair-game-diagnostics', gameUrl),
  launchGame: (gameUrl: string) => ipcRenderer.invoke('launch-game', gameUrl),
  stopGame: (gameUrl: string, force?: boolean) => ipcRenderer.invoke('stop-game', gameUrl, force),
  deleteGame: (gameUrl: string) => ipcRenderer.invoke('delete-game', gameUrl),
  openGameFolder: (path: string) => ipcRenderer.invoke('open-game-folder', path),
  configureGameExe: (gameUrl: string) => ipcRenderer.invoke('configure-game-exe', gameUrl),

  setGameVersion: (gameUrl: string, version: string) => ipcRenderer.invoke('set-game-version', gameUrl, version),
  setGameTitle: (gameUrl: string, title: string) => ipcRenderer.invoke('set-game-title', gameUrl, title),
  setGameFavorite: (gameUrl: string, isFavorite: boolean) => ipcRenderer.invoke('set-game-favorite', gameUrl, isFavorite),
  toggleGameFavorite: (gameUrl: string) => ipcRenderer.invoke('toggle-game-favorite', gameUrl),
  setGameProtonOptions: (gameUrl: string, runtime: string, options: any) =>
    ipcRenderer.invoke('set-game-proton-options', gameUrl, runtime, options),
  exportGameFix: (gameUrl: string, fix?: any) => ipcRenderer.invoke('export-game-fix', gameUrl, fix),
  buildGameFixDraft: (gameUrl: string) => ipcRenderer.invoke('build-game-fix-draft', gameUrl),
  listGameExecutables: (gameUrl: string) => ipcRenderer.invoke('list-game-executables', gameUrl),
  importGameFix: () => ipcRenderer.invoke('import-game-fix'),
  listGameFixes: (gameUrl: string) => ipcRenderer.invoke('list-game-fixes', gameUrl),
  listRemoteGameFixes: (gameUrl: string, force?: boolean) => ipcRenderer.invoke('list-remote-game-fixes', gameUrl, force),
  downloadRemoteGameFix: (gameUrl: string, fixId: string) => ipcRenderer.invoke('download-remote-game-fix', gameUrl, fixId),
  saveGameFix: (gameUrl: string, fix: any) => ipcRenderer.invoke('save-game-fix', gameUrl, fix),
  deleteGameFix: (gameUrl: string, fixId: string) => ipcRenderer.invoke('delete-game-fix', gameUrl, fixId),
  applyGameFix: (gameUrl: string, fix: any, inputValues?: Record<string, string>) => ipcRenderer.invoke('apply-game-fix', gameUrl, fix, inputValues),
  installGameFixDownloads: (gameUrl: string, fix: any) => ipcRenderer.invoke('install-game-fix-downloads', gameUrl, fix),
  onGameFixDownloadProgress: (cb: (data: any) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data)
    ipcRenderer.on('game-fix-download-progress', handler)
    return () => ipcRenderer.removeListener('game-fix-download-progress', handler)
  },
  installGameFixComponents: (gameUrl: string, fix: any) => ipcRenderer.invoke('install-game-fix-components', gameUrl, fix),
  getProtonLogSnapshot: (payload: { gameUrl?: string; logPath?: string | null; maxChars?: number }) =>
    ipcRenderer.invoke('get-proton-log-snapshot', payload),

  setGameLanSettings: (gameUrl: string, payload: { mode?: string | null; networkId?: string | null; autoconnect?: boolean }) =>
    ipcRenderer.invoke('set-game-lan-settings', gameUrl, payload),

  vpnStatus: () => ipcRenderer.invoke('vpn-status'),
  vpnInstall: () => ipcRenderer.invoke('vpn-install'),
  vpnRoomCreate: (payload?: {
    name?: string
    roomName?: string
    gameName?: string
    password?: string
    public?: boolean
    maxPlayers?: number
  }) => ipcRenderer.invoke('vpn-room-create', payload),
  vpnRoomJoin: (code: string, payload?: { name?: string; password?: string }) =>
    ipcRenderer.invoke('vpn-room-join', { code, name: payload?.name, password: payload?.password }),
  vpnRoomPeers: (code: string) => ipcRenderer.invoke('vpn-room-peers', { code }),
  vpnRoomList: (payload?: { gameName?: string }) => ipcRenderer.invoke('vpn-room-list', payload),
  vpnHeartbeat: (peerId: string) => ipcRenderer.invoke('vpn-heartbeat', { peerId }),
  vpnRoomLeave: (peerId: string) => ipcRenderer.invoke('vpn-room-leave', { peerId }),
  vpnConnect: (config: string) => ipcRenderer.invoke('vpn-connect', { config }),
  vpnDisconnect: () => ipcRenderer.invoke('vpn-disconnect'),

  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Achievements
  getGameAchievements: (gameUrl: string) => ipcRenderer.invoke('achievements-get', gameUrl),
  importAchievementSchema: (gameUrl: string) => ipcRenderer.invoke('achievements-import-schema', gameUrl),
  saveAchievementSchema: (gameUrl: string, rawJson: string) => ipcRenderer.invoke('achievements-save-schema', gameUrl, rawJson),
  clearAchievementSchema: (gameUrl: string) => ipcRenderer.invoke('achievements-clear-schema', gameUrl),
  forceRefreshAchievementSchema: (gameUrl: string) => ipcRenderer.invoke('achievements-force-refresh', gameUrl),
  onAchievementUnlocked: (cb: (data: any) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data)
    ipcRenderer.on('achievement-unlocked', handler)
    return () => ipcRenderer.removeListener('achievement-unlocked', handler)
  },

  onDownloadProgress: (cb: (data: DownloadProgressPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: DownloadProgressPayload) => cb(data)
    ipcRenderer.on('download-progress', handler)
    return () => ipcRenderer.removeListener('download-progress', handler)
  },

  onDownloadComplete: (cb: (data: { magnet?: string; infoHash?: string; destPath?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { magnet?: string; infoHash?: string; destPath?: string }) => cb(data)
    ipcRenderer.on('download-complete', handler)
    return () => ipcRenderer.removeListener('download-complete', handler)
  },

  onDownloadWarning: (cb: (data: { code: string; freeGb?: number; thresholdGb?: number }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { code: string; freeGb?: number; thresholdGb?: number }) => cb(data)
    ipcRenderer.on('download-warning', handler)
    return () => ipcRenderer.removeListener('download-warning', handler)
  },

  onDownloadDeleted: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('download-deleted', handler)
    return () => ipcRenderer.removeListener('download-deleted', handler)
  },

  onGameVersionUpdate: (cb: (data: { url: string; latest?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { url: string; latest?: string }) => cb(data)
    ipcRenderer.on('game-version-update', handler)
    return () => ipcRenderer.removeListener('game-version-update', handler)
  },

  onUpdateQueueStatus: (cb: (data: any) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data)
    ipcRenderer.on('update-queue-status', handler)
    return () => ipcRenderer.removeListener('update-queue-status', handler)
  },

  onGameLaunchStatus: (cb: (data: GameLaunchStatusPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data as GameLaunchStatusPayload)
    ipcRenderer.on('game-launch-status', handler)
    return () => ipcRenderer.removeListener('game-launch-status', handler)
  },

  onCloudSavesStatus: (cb: (data: CloudSavesStatusPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data as CloudSavesStatusPayload)
    ipcRenderer.on('cloud-saves-status', handler)
    return () => ipcRenderer.removeListener('cloud-saves-status', handler)
  },

  // Navigation events from tray menu
  onNavigateToTab: (cb: (tab: string) => void) => {
    const handler = (_event: IpcRendererEvent, tab: string) => cb(tab)
    ipcRenderer.on('navigate-to-tab', handler)
    return () => ipcRenderer.removeListener('navigate-to-tab', handler)
  },

  onNavigateToGame: (cb: (gameUrl: string) => void) => {
    const handler = (_event: IpcRendererEvent, gameUrl: string) => cb(gameUrl)
    ipcRenderer.on('navigate-to-game', handler)
    return () => ipcRenderer.removeListener('navigate-to-game', handler)
  },

  cloudSavesOpenBackups: (gameUrl: string) => ipcRenderer.invoke('cloud-saves-open-backups', { gameUrl }),
  cloudSavesGetHistory: (gameUrl: string, limit?: number) =>
    ipcRenderer.invoke('cloud-saves-get-history', { gameUrl, limit }),
  
  onPrefixJobStatus: (cb: (data: PrefixJobStatusPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data as PrefixJobStatusPayload)
    ipcRenderer.on('prefix-job-status', handler)
    return () => ipcRenderer.removeListener('prefix-job-status', handler)
  },

  // ==========================
  // Drive APIs
  // ==========================
  driveAuth: () => ipcRenderer.invoke('drive-auth'),
  driveStatus: () => ipcRenderer.invoke('drive-status'),
  driveDisconnect: () => ipcRenderer.invoke('drive-disconnect'),
  
  // FIX: Add syncGameSaves for LibraryTab compatibility.
  syncGameSaves: (gameUrl: string) => ipcRenderer.invoke('drive-sync-game-saves', gameUrl),

  driveListSaves: () => ipcRenderer.invoke('drive-list-saves') as Promise<{ success: boolean; files?: DriveListItem[]; error?: string }>,
  driveListSavesForGame: (realAppId: string) =>
    ipcRenderer.invoke('drive-list-saves-for-game', realAppId) as Promise<{ success: boolean; files?: DriveListItem[]; error?: string }>,
  driveUploadSave: (localPath: string, remoteName?: string) => ipcRenderer.invoke('drive-upload-save', localPath, remoteName),
  driveDownloadSave: (fileId: string, destPath: string) => ipcRenderer.invoke('drive-download-save', fileId, destPath)
})
