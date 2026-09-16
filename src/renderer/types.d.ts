/// <reference types="vite/client" />

import type { StoreComment, StoreCommentsThread } from '../shared/storeComments'

type DownloadResult = { success: boolean; error?: string }
type VersionResult =
  | { success: true; version: string; torrentUrl?: string | null }
  | { success: false; error: string }
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
type ActiveDownload = {
  id: number
  game_url?: string
  title?: string
  type: 'http' | 'torrent'
  download_url: string
  dest_path?: string
  progress?: number
  status?: string
  info_hash?: string
  speed?: string
  eta?: string
  size?: string
  downloaded?: string
  seeds?: number
  peers?: number
  error_message?: string
}
type ActiveDownloadsResult = { success: boolean; downloads: ActiveDownload[]; error?: string }
type CompletedDownloadsResult = { success: boolean; downloads: ActiveDownload[]; error?: string }

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

type DownloadQueueItem = {
  id: string
  gameUrl: string
  title: string
  priority: number
  addedAt: number
}

type DownloadQueueStatus = {
  maxParallel: number
  activeCount: number
  queuedCount: number
  active: DownloadQueueItem[]
  queued: DownloadQueueItem[]
  updatedAt: number
}

type LauncherTask = {
  id: string
  kind: 'download' | 'extract' | 'prefix' | 'redist' | 'cloud-save'
  title: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  progress?: number
  message?: string
  gameUrl?: string
  gameKey?: string
  targetPath?: string
  impact?: 'network' | 'disk' | 'compat' | 'cloud' | 'background'
  startedAt: number
  updatedAt: number
  finishedAt?: number
}

type LauncherTaskStatus = {
  activeCount: number
  recentCount: number
  active: LauncherTask[]
  recent: LauncherTask[]
  updatedAt: number
}

export {}

declare global {
  interface Window {
    electronAPI: {
      getStoreWebviewPreloadUrl: () => string
      openAuthWindow: () => Promise<boolean>
      getStoreLoginStatus: () => Promise<boolean>
      checkGameVersion: (url: string) => Promise<VersionResult>
      onCookiesSaved: (cb: () => void) => (() => void)
      onCookiesCleared: (cb: () => void) => (() => void)
      clearCookies: () => Promise<{ success: boolean; error?: string }>
      downloadHttp: (url: string, dest: string) => Promise<DownloadResult>
      downloadTorrent: (magnet: string, dest: string) => Promise<DownloadResult>
      startTorrentDownload: (url: string, referer?: string) => Promise<DownloadResult>
      getActiveDownloads: () => Promise<ActiveDownloadsResult>
      getCompletedDownloads: () => Promise<CompletedDownloadsResult>
      pauseDownload: (torrentId: string) => Promise<DownloadResult>
      resumeDownload: (torrentId: string) => Promise<DownloadResult>
      cancelDownload: (torrentId: string) => Promise<DownloadResult>
      onDownloadProgress: (cb: (data: DownloadProgressPayload) => void) => (() => void)
      onDownloadComplete: (cb: (data: { magnet?: string; infoHash?: string; destPath?: string }) => void) => (() => void)
      
      // Download Queue APIs
      getDownloadQueueStatus: () => Promise<{ success: boolean; status?: DownloadQueueStatus; error?: string }>
      getTaskQueueStatus: () => Promise<{ success: boolean; status?: LauncherTaskStatus; error?: string }>
      reconcileDownloads: () => Promise<{ success: boolean; result?: any; error?: string }>
      prioritizeDownload: (queueId: string) => Promise<{ success: boolean; error?: string }>
      removeFromDownloadQueue: (queueId: string) => Promise<{ success: boolean; error?: string }>
      swapActiveDownload: (queueId: string) => Promise<{ success: boolean; error?: string }>
      onDownloadQueueStatus: (cb: (data: DownloadQueueStatus) => void) => (() => void)
      onTaskStatus: (cb: (data: LauncherTaskStatus) => void) => (() => void)

      openPath: (target: string) => Promise<DownloadResult>
      getSettings: () => Promise<{ success: boolean; settings?: any; platform?: string; isLinux?: boolean; error?: string }>
      saveSettings: (settings: any) => Promise<{ success: boolean; error?: string }>
      getLauncherDiagnostics: () => Promise<{ success: boolean; diagnostics?: any; error?: string }>
      storeListing: (payload?: { page?: number; query?: string; force?: boolean }) => Promise<{
        success: boolean
        listing?: {
          items: Array<{ id: string; url: string; title: string; imageUrl?: string; publishedAt?: string; updatedAt?: string }>
          nextPageUrl?: string
          page: number
          query?: string
          sourceUrl: string
        }
        error?: string
        errorCode?: string
      }>
      storeGame: (url: string, force?: boolean) => Promise<{
        success: boolean
        game?: {
          url: string
          title: string
          version?: string
          imageUrl?: string
          videoUrl?: string
          releaseDate?: string
          torrentUrl?: string
          directUrl?: string
          instructions?: string[]
          description?: string
          unavailableNotice?: string
        }
        error?: string
        errorCode?: string
      }>
      storeTranslateInstructions: (url: string, instructions: string[], language?: string, force?: boolean) => Promise<{
        success: boolean
        instructions?: string[]
        language?: string
        translated?: boolean
        fromCache?: boolean
        error?: string
        errorCode?: string
      }>
      storeGameMetadata: (url: string, title: string, steamAppId?: string) => Promise<{
        success: boolean
        metadata?: {
          source: 'steam' | 'none'
          steamAppId?: string
          name?: string
          description?: string
          headerImage?: string
          backgroundImage?: string
          screenshots?: string[]
          genres?: string[]
          categories?: string[]
          developers?: string[]
          publishers?: string[]
          releaseDate?: string
          trailer?: { name?: string; thumbnail?: string; hls?: string; webm?: string; mp4?: string }
          requirements?: {
            minimum?: Array<{ label?: string; value: string }>
            recommended?: Array<{ label?: string; value: string }>
          }
        }
        error?: string
        errorCode?: string
      }>
      storeGameComments: (url: string, page?: number, force?: boolean) => Promise<{
        success: boolean
        thread?: StoreCommentsThread
        error?: string
        errorCode?: string
      }>
      storePostComment: (url: string, text: string) => Promise<{
        success: boolean
        comment?: StoreComment
        pending?: boolean
        notice?: string
        error?: string
        errorCode?: string
      }>
      storeCaptureFixture: (url: string, name?: string) => Promise<{ success: boolean; path?: string; bytes?: number; error?: string }>
      storeClearCache: () => Promise<{ success: boolean }>
      setUiLanguage: (language: string) => Promise<{ success: boolean; language?: string; error?: string }>
      testNotification: () => Promise<{ success: boolean; delayMs?: number; error?: string }>
      getLauncherUpdateStatus: (force?: boolean) => Promise<{
        success: boolean
        status?: {
          currentVersion: string
          latestVersion?: string
          latestTag?: string
          releaseName?: string
          releaseUrl?: string
          publishedAt?: string
          canAutoUpdate?: boolean
          updatePackage?: 'appimage' | 'manual'
          appImageAsset?: {
            name: string
            downloadUrl: string
            size?: number
          }
          updateAvailable: boolean
          fromCache?: boolean
          checkedAt?: string
          error?: string
        }
        error?: string
      }>
      installLauncherAppImageUpdate: () => Promise<{ success: boolean; message?: string; error?: string }>
      getToolsStatus: () => Promise<{ success: boolean; status?: any; error?: string }>
      listToolReleases: (tool: 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay', limit?: number, force?: boolean) => Promise<{ success: boolean; releases?: Array<{ tag: string; name: string; publishedAt?: string; assetName?: string; downloadUrl?: string }>; fromCache?: boolean; warning?: string; error?: string }>
      installTool: (tool: 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay', version?: string) => Promise<{ success: boolean; status?: any; path?: string; downloaded?: boolean; error?: string }>
      legendaryAuth: (action: 'status' | 'login' | 'logout') => Promise<{ success: boolean; status?: any; auth?: any; error?: string }>
      eosOverlayAction: (action: 'info' | 'install' | 'update' | 'remove') => Promise<{ success: boolean; status?: any; info?: any; path?: string | null; error?: string }>
      setDefaultProtonRuntime: (runtimePath: string) => Promise<{ success: boolean; status?: any; error?: string }>
      removeProtonGeRuntime: (runtimePath: string) => Promise<{ success: boolean; status?: any; error?: string }>
      listLanguagePacks: () => Promise<{
        success: boolean
        languages?: Array<{
          code: string
          label?: string
          nativeLabel?: string
          source?: string
          translations: Record<string, string>
        }>
        directory?: string
        directories?: string[]
        error?: string
      }>
      selectDirectory: () => Promise<{ success: boolean; path?: string; error?: string }>
      extractDownload: (downloadId: number | string, path?: string) => Promise<DownloadResult & { destPath?: string }>
      protonEnsureRuntime: (customPath?: string) => Promise<{ success: boolean; runtime?: string; runner?: string; error?: string }>
      protonListRuntimes: (force?: boolean) => Promise<{ success: boolean; runtimes?: Array<{ name: string; path: string; runner: string; source: string }>; error?: string }>
      protonSetRoot: (rootPath: string) => Promise<{ success: boolean; runtimes?: Array<{ name: string; path: string; runner: string; source: string }>; error?: string }>
      protonDefaultPrefix: (forceRecreate?: boolean) => Promise<{ success: boolean; prefix?: string; error?: string }>
      protonPreparePrefix: (slug: string) => Promise<{ success: boolean; prefix?: string; error?: string }>
      protonBuildLaunch: (exePath: string, args: string[], slug: string, runtimePath?: string, prefixPath?: string) => Promise<{ success: boolean; launch?: any; error?: string }>
      protonCreateGamePrefix: (gameUrl: string, title?: string, commonRedistPath?: string) => Promise<{ success: boolean; prefix?: string; error?: string }>
      winetricksStatus: () => Promise<{ success: boolean; winetricks?: boolean; error?: string }>
      runWinetricks: (gameUrl: string, components: string[]) => Promise<{ success: boolean; error?: string }>
      protonOpenTricksGui: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      protonOpenWinecfg: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      protonOpenRegedit: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      protonOpenFileManager: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      setGameProtonPrefix: (gameUrl: string, prefixPath: string | null) => Promise<{ success: boolean; error?: string }>
      setGameSteamAppId: (gameUrl: string, steamAppId: string | null) => Promise<{ success: boolean; error?: string }>
      getGames: () => Promise<{ success: boolean; games: any[]; error?: string }>
      getGameDiagnostics: (gameUrl: string) => Promise<{ success: boolean; diagnostics?: any; error?: string }>
      repairGameDiagnostics: (gameUrl: string) => Promise<{ success: boolean; diagnostics?: any; actions?: any[]; error?: string }>
      launchGame: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      stopGame: (gameUrl: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
      deleteGame: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      openGameFolder: (path: string) => Promise<{ success: boolean; error?: string }>
      configureGameExe: (gameUrl: string) => Promise<{ success: boolean; exePath?: string; error?: string }>
      setGameVersion: (gameUrl: string, version: string) => Promise<{ success: boolean; error?: string }>
      setGameTitle: (gameUrl: string, title: string) => Promise<{ success: boolean; error?: string }>
      setGameFavorite: (gameUrl: string, isFavorite: boolean) => Promise<{ success: boolean; isFavorite?: boolean; error?: string }>
      toggleGameFavorite: (gameUrl: string) => Promise<{ success: boolean; isFavorite?: boolean; error?: string }>
      setGameProtonOptions: (gameUrl: string, runtime: string, options: any) => Promise<{ success: boolean; error?: string }>
      exportGameFix: (gameUrl: string, fix?: any) => Promise<{ success: boolean; canceled?: boolean; fix?: any; path?: string; error?: string }>
      buildGameFixDraft: (gameUrl: string) => Promise<{ success: boolean; fix?: any; error?: string }>
      listGameExecutables: (gameUrl: string) => Promise<{
        success: boolean
        executables?: Array<{ name: string; relativePath: string; size: number }>
        installed?: boolean
        error?: string
      }>
      importGameFix: () => Promise<{ success: boolean; canceled?: boolean; fix?: any; path?: string; error?: string }>
      listRemoteGameFixes: (gameUrl: string, force?: boolean) => Promise<{
        success: boolean
        fixes?: Array<{
          id: string
          file: string
          title: string
          description?: string
          game: { id?: string | null; title?: string | null; url?: string | null }
          alreadySaved?: boolean
        }>
        fromCache?: boolean
        warning?: string
        error?: string
      }>
      downloadRemoteGameFix: (gameUrl: string, fixId: string) => Promise<{ success: boolean; fix?: any; path?: string; error?: string }>
      listGameFixes: (gameUrl: string) => Promise<{ success: boolean; fixes?: Array<{ fix: any; path?: string; updatedAt?: string }>; directory?: string; error?: string }>
      saveGameFix: (gameUrl: string, fix: any) => Promise<{ success: boolean; fix?: any; path?: string; error?: string }>
      deleteGameFix: (gameUrl: string, fixId: string) => Promise<{ success: boolean; error?: string }>
      applyGameFix: (gameUrl: string, fix: any, inputValues?: Record<string, string>) => Promise<{ success: boolean; fix?: any; patch?: any; warnings?: string[]; copiedAssemblies?: string[]; pendingComponents?: { winetricks?: string[] }; missingInputs?: string[]; invalidInputs?: string[]; error?: string; errorCode?: string }>
      installGameFixDownloads: (gameUrl: string, fix: any) => Promise<{ success: boolean; installed?: string[]; warnings?: string[]; backupDir?: string; error?: string; errorCode?: string }>
      onGameFixDownloadProgress: (cb: (data: { gameUrl: string; downloadId: string; label: string; phase: 'download' | 'extract' | 'install'; percent: number }) => void) => () => void
      installGameFixComponents: (gameUrl: string, fix: any) => Promise<{ success: boolean; prefix?: string; installed?: string[]; warnings?: string[]; error?: string }>
      getProtonLogSnapshot: (payload: { gameUrl?: string; logPath?: string | null; maxChars?: number }) => Promise<{ success: boolean; text?: string; live?: boolean; logPath?: string | null; pid?: number; updatedAt?: number; hasProcessOutput?: boolean; hasProtonLog?: boolean; error?: string }>
      setGameLanSettings: (gameUrl: string, payload: { mode?: string | null; networkId?: string | null; autoconnect?: boolean }) => Promise<{ success: boolean; error?: string }>
      vpnStatus: () => Promise<{ success: boolean; controller?: any; installed?: boolean; installError?: string; transport?: import('../shared/vpn').VpnTransport; session?: import('../shared/vpn').VpnSessionState | null; error?: string }>
      vpnInstall: () => Promise<{ success: boolean; error?: string; url?: string }>
      vpnRoomCreate: (payload?: {
        name?: string
        roomName?: string
        gameName?: string
        password?: string
        public?: boolean
        maxPlayers?: number
      }) => Promise<{ success: boolean; code?: string; config?: string; vpnIp?: string; peerId?: string; roomName?: string; error?: string }>
      vpnRoomJoin: (code: string, payload?: { name?: string; password?: string }) => Promise<{ success: boolean; config?: string; vpnIp?: string; hostIp?: string; peerId?: string; roomName?: string; maxPlayers?: number; needsPassword?: boolean; error?: string }>
      vpnRoomPeers: (code: string) => Promise<{ success: boolean; peers?: Array<{ id: string; name?: string; ip?: string; role?: string; online?: boolean }>; error?: string }>
      vpnRoomList: (payload?: { gameName?: string }) => Promise<{ success: boolean; rooms?: Array<{
        code: string
        name: string
        gameName?: string
        hostName?: string
        hasPassword: boolean
        playerCount: number
        onlineCount: number
        maxPlayers: number
        createdAt: number
        lastActivity: number
      }>; error?: string }>
      vpnHeartbeat: (peerId: string) => Promise<{ success: boolean; peers?: Array<{ id: string; name?: string; ip?: string; role?: string; online?: boolean }>; error?: string }>
      vpnRoomLeave: (peerId: string) => Promise<{ success: boolean; error?: string }>
      vpnConnect: (config: string) => Promise<{ success: boolean; tunnelName?: string; configPath?: string; needsInstall?: boolean; needsAdmin?: boolean; error?: string }>
      vpnDisconnect: () => Promise<{ success: boolean; needsAdmin?: boolean; error?: string }>

      // Achievements
      getGameAchievements: (gameUrl: string) => Promise<{ success: boolean; sources?: any[]; achievements?: any[]; error?: string }>
      importAchievementSchema: (gameUrl: string) => Promise<{ success: boolean; count?: number; error?: string }>
      saveAchievementSchema: (gameUrl: string, rawJson: string) => Promise<{ success: boolean; count?: number; error?: string }>
      clearAchievementSchema: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      forceRefreshAchievementSchema: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      onAchievementUnlocked: (cb: (data: { gameUrl: string; id: string; title: string; description?: string; icon?: string; iconUrl?: string; unlockedAt?: number }) => void) => (() => void)

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      getOnlineFixIni: (gameUrl: string) => Promise<{ success: boolean; path?: string; content?: string; exists?: boolean; error?: string }>
      saveOnlineFixIni: (gameUrl: string, content: string) => Promise<{ success: boolean; path?: string; error?: string }>
      fetchGameImage: (gameUrl: string, title: string) => Promise<{ success: boolean; imageUrl?: string; error?: string }>
      setGameImageUrl: (gameUrl: string, imageUrl: string | null) => Promise<{ success: boolean; imageUrl?: string | null; error?: string }>
      pickGameBannerFile: (gameUrl: string) => Promise<{ success: boolean; imageUrl?: string; path?: string; canceled?: boolean; error?: string }>
      fetchGameUpdateInfo: (gameUrl: string) => Promise<{ success: boolean; latest?: string | null; torrentUrl?: string | null; error?: string }>
      getUserProfile: () => Promise<{ success: boolean; name?: string | null; avatar?: string | null; avatarData?: string | null; profileUrl?: string | null; error?: string }>
      checkAllUpdates: () => Promise<{ success: boolean; results?: any[]; error?: string }>
      scanInstalledGames: () => Promise<{ success: boolean; scanned?: number; added?: number; skipped?: number; error?: string }>

      queueGameUpdates: (gameUrls: string[]) => Promise<{ success: boolean; queuedAdded?: number; error?: string }>
      clearUpdateQueue: () => Promise<{ success: boolean; error?: string }>
      getUpdateQueueStatus: () => Promise<{ success: boolean; status?: { running: boolean; queued: number; currentGameUrl?: string | null; lastError?: string | null; updatedAt: number }; error?: string }>
      deleteDownload: (downloadId: number) => Promise<{ success: boolean; error?: string }>
      onGameVersionUpdate: (cb: (data: { url: string; latest?: string }) => void) => (() => void)
      onUpdateQueueStatus: (cb: (data: { running: boolean; queued: number; currentGameUrl?: string | null; lastError?: string | null; updatedAt: number }) => void) => (() => void)
      onDownloadWarning: (cb: (data: { code: string; freeGb?: number; thresholdGb?: number }) => void) => () => void
      onDownloadDeleted: (cb: () => void) => (() => void)
      onGameLaunchStatus: (cb: (data: { gameUrl: string; status: 'starting' | 'running' | 'exited' | 'error'; pid?: number; code?: number | null; signal?: string | null; message?: string; stderrTail?: string; protonLogPath?: string }) => void) => (() => void)
      onPrefixJobStatus: (cb: (data: { gameUrl: string; status: 'starting' | 'progress' | 'done' | 'error'; message?: string; prefix?: string }) => void) => (() => void)

      // Cloud Saves (Ludusavi + Drive)
      onCloudSavesStatus: (cb: (data: CloudSavesStatusPayload) => void) => (() => void)
      cloudSavesOpenBackups: (gameUrl: string) => Promise<{ success: boolean; error?: string }>
      cloudSavesGetHistory: (gameUrl: string, limit?: number) => Promise<{ success: boolean; entries?: any[]; error?: string }>

      // Navigation events from tray menu
      onNavigateToTab: (cb: (tab: string) => void) => (() => void)
      onNavigateToGame: (cb: (gameUrl: string) => void) => (() => void)

      // Drive
      driveAuth: () => Promise<{
        success: boolean
        message?: string
        error?: string
        ludusaviPrepared?: boolean
        ludusaviPath?: string
        ludusaviDownloaded?: boolean
        ludusaviError?: string
      }>
      driveStatus: () => Promise<{ success?: boolean; connected?: boolean; message?: string; error?: string }>
      driveDisconnect: () => Promise<{ success: boolean; message?: string; error?: string }>
      driveGetCredentials: () => Promise<{ success: boolean; content?: string; message?: string }>
      driveOpenCredentials: () => Promise<{ success: boolean; message?: string }>
      driveSaveCredentials: (rawJson: string) => Promise<{ success: boolean; message?: string }>
      driveListSaves: () => Promise<{ success: boolean; files?: DriveListItem[]; message?: string; error?: string }>
      driveListSavesForGame: (realAppId: string) => Promise<{ success: boolean; files?: DriveListItem[]; error?: string }>
      driveUploadSave: (localPath: string, remoteName?: string) => Promise<{ success: boolean; message?: string; error?: string }>
      driveDownloadSave: (fileId: string, destPath: string) => Promise<{ success: boolean; message?: string; error?: string }>

      // Saves sync entrypoint (manual / after-exit)
      syncGameSaves: (gameUrl: string) => Promise<{ success: boolean; message?: string; error?: string }>
    }
  }
}
