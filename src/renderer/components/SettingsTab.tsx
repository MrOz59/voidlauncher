import React, { useState, useEffect, useMemo, useRef } from 'react'
import { AlertCircle, Bell, Folder, Download, HardDrive, RefreshCw, Gamepad2, Cloud, Globe, Info, Settings2, ChevronDown, Trash2, Key, Link, Monitor, FolderPlus, Check, X, CloudOff, Minimize2, Terminal, Shield, ExternalLink, Heart } from 'lucide-react'
import { useI18n, type SupportedLanguage } from '../i18n'
import { useToast } from './ToastHost'
import { ipcErrorText } from '../../shared/ipcErrors'

interface Settings {
  downloadPath: string
  gamesPath: string
  downloadPathDefault?: string
  gamesPathDefault?: string
  autoExtract: boolean
  autoUpdate: boolean
  parallelDownloads: number
  steamWebApiKey?: string
  achievementSchemaBaseUrl?: string
  protonDefaultRuntimePath: string
  protonExtraPaths: string[]
  lanDefaultNetworkId?: string
  lanControllerUrl?: string
  cloudSavesEnabled: boolean
  minimizeToTray: boolean
  notificationsEnabled: boolean
}

type DriveFile = { id: string; name: string; modifiedTime?: string }
type SaveStatus = { state: 'idle' | 'pending' | 'saving' | 'saved' | 'error'; message: string }
type LauncherDiagnosticCheck = { id: string; label: string; status: 'ok' | 'warn' | 'error' | 'info'; detail?: string }
type LauncherDiagnostics = {
  error?: string
  app?: { platform?: string }
  linux?: { protonRuntime?: string | null }
  tools?: { torrentAgentPath?: string | null; ludusaviPath?: string | null }
  checks?: LauncherDiagnosticCheck[]
}
type LauncherUpdateStatus = {
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

const LAUNCHER_DONATE_URL = 'https://ko-fi.com/mroz59'

function formatMaybeDate(s?: string) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

function settingsSnapshot(settings: Settings) {
  return JSON.stringify({
    downloadPath: String(settings.downloadPath || '').trim(),
    gamesPath: String(settings.gamesPath || '').trim(),
    autoExtract: !!settings.autoExtract,
    autoUpdate: !!settings.autoUpdate,
    parallelDownloads: Math.max(1, Math.min(10, Number(settings.parallelDownloads) || 3)),
    steamWebApiKey: String(settings.steamWebApiKey || '').trim(),
    achievementSchemaBaseUrl: String(settings.achievementSchemaBaseUrl || '').trim(),
    protonDefaultRuntimePath: String(settings.protonDefaultRuntimePath || '').trim(),
    protonExtraPaths: (settings.protonExtraPaths || []).map(p => String(p).trim()).filter(Boolean).sort(),
    lanDefaultNetworkId: String(settings.lanDefaultNetworkId || '').trim(),
    lanControllerUrl: String(settings.lanControllerUrl || '').trim(),
    cloudSavesEnabled: !!settings.cloudSavesEnabled,
    minimizeToTray: !!settings.minimizeToTray,
    notificationsEnabled: !!settings.notificationsEnabled
  })
}

type SettingsTabProps = {
  /** Lets the shell warn before navigating away with unsaved settings. */
  onDirtyChange?: (dirty: boolean) => void
}

export default function SettingsTab({ onDirtyChange }: SettingsTabProps = {}) {
  const { t, language, setLanguage, supportedLanguages } = useI18n()
  const toast = useToast()
  const [platformInfo, setPlatformInfo] = useState<{ platform: string; isLinux: boolean }>({
    platform: 'unknown',
    isLinux: false
  })

  const [settings, setSettings] = useState<Settings>({
    downloadPath: '',
    gamesPath: '',
    autoExtract: true,
    autoUpdate: false,
    parallelDownloads: 3,
    steamWebApiKey: '',
    achievementSchemaBaseUrl: '',
    protonDefaultRuntimePath: '',
    protonExtraPaths: [],
    lanDefaultNetworkId: '',
    lanControllerUrl: 'https://vpn.mroz.dev.br',
    cloudSavesEnabled: true,
    minimizeToTray: false,
    notificationsEnabled: true,
  })

  const [runtimes, setRuntimes] = useState<Array<{ name: string; path: string; runner: string; source: string }>>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'idle', message: t('settings.save.idle') })
  const [launcherDiagnostics, setLauncherDiagnostics] = useState<LauncherDiagnostics | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdateStatus | null>(null)
  const [launcherVersion, setLauncherVersion] = useState('—')
  const [launcherUpdateLoading, setLauncherUpdateLoading] = useState(false)
  const [launcherUpdateInstalling, setLauncherUpdateInstalling] = useState(false)
  const [launcherUpdateMessage, setLauncherUpdateMessage] = useState<string | null>(null)
  const [notificationTestCountdown, setNotificationTestCountdown] = useState(0)
  const [notificationTestError, setNotificationTestError] = useState<string | null>(null)

  // Drive UI state
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null)
  const [driveStatus, setDriveStatus] = useState<string | null>(null)
  const [driveConnected, setDriveConnected] = useState(false)
  const driveStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setDriveStatusTimed = (msg: string | null, ms = 4000) => {
    if (driveStatusTimeoutRef.current) {
      clearTimeout(driveStatusTimeoutRef.current)
      driveStatusTimeoutRef.current = null
    }
    setDriveStatus(msg)
    if (msg) {
      driveStatusTimeoutRef.current = setTimeout(() => {
        setDriveStatus(null)
        driveStatusTimeoutRef.current = null
      }, ms)
    }
  }

  useEffect(() => {
    ;(async () => {
      const isLinux = await loadSettings()
      if (isLinux) {
        refreshRuntimes(false)
      }
      try {
        const res = await window.electronAPI.driveStatus()
        if (res && typeof res.connected === 'boolean') setDriveConnected(res.connected)
      } catch {
        // ignore
      }
      loadLauncherDiagnostics()
      loadLauncherUpdate(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (driveStatusTimeoutRef.current) {
        clearTimeout(driveStatusTimeoutRef.current)
        driveStatusTimeoutRef.current = null
      }
    }
  }, [])

  const loadSettings = async (): Promise<boolean> => {
    try {
      const res = await window.electronAPI.getSettings()
      if (res.success && res.settings) {
        const raw: any = res.settings
        setSettings((prev) => {
          const next: Settings = {
            ...prev,
            ...raw,
            gamesPath: typeof raw?.gamesPath === 'string' ? raw.gamesPath : prev.gamesPath,
            notificationsEnabled: raw?.notificationsEnabled !== false,
            protonDefaultRuntimePath: typeof raw?.protonDefaultRuntimePath === 'string'
              ? raw.protonDefaultRuntimePath
              : (typeof raw?.protonPath === 'string' ? raw.protonPath : prev.protonDefaultRuntimePath),
            protonExtraPaths: Array.isArray(raw?.protonExtraPaths)
              ? raw.protonExtraPaths.filter((p: unknown) => typeof p === 'string' && p.trim()).map((p: string) => p.trim())
              : prev.protonExtraPaths,
          }
          setSavedSnapshot(settingsSnapshot(next))
          return next
        })
      }
      const isLinux = Boolean(res?.isLinux || res?.platform === 'linux')
      setPlatformInfo({ platform: String(res?.platform || 'unknown'), isLinux })
      return isLinux
    } catch (err: any) {
      setSaveStatus({ state: 'error', message: err?.message || t('settings.save.error') })
      return false
    } finally {
      setLoading(false)
    }
  }

  const hasUnsavedChanges = useMemo(() => {
    if (!savedSnapshot) return false
    return settingsSnapshot(settings) !== savedSnapshot
  }, [savedSnapshot, settings])

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges)
  }, [hasUnsavedChanges, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (hasUnsavedChanges && saveStatus.state !== 'saving' && saveStatus.state !== 'error') {
      setSaveStatus({ state: 'pending', message: t('settings.save.pending') })
    } else if (!hasUnsavedChanges && saveStatus.state === 'pending') {
      setSaveStatus({ state: 'idle', message: t('settings.save.idle') })
    }
  }, [hasUnsavedChanges, saveStatus.state, t])

  const loadLauncherDiagnostics = async () => {
    setDiagnosticsLoading(true)
    try {
      const res = await window.electronAPI.getLauncherDiagnostics()
      if (res.success) setLauncherDiagnostics(res.diagnostics || null)
      else setLauncherDiagnostics({ error: ipcErrorText(t, res, t('settings.launcherDiagnostics.failed')), checks: [] })
    } catch (err: any) {
      setLauncherDiagnostics({ error: err?.message || String(err), checks: [] })
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  // Support threads always start with "send me your setup"; make that one click.
  const copyDiagnostics = async () => {
    if (!launcherDiagnostics) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(launcherDiagnostics, null, 2))
      toast.success(t('settings.launcherDiagnostics.copied'))
    } catch (err: any) {
      toast.error(t('settings.launcherDiagnostics.copyFailed'), err?.message || undefined)
    }
  }

  const loadLauncherUpdate = async (force = false) => {
    setLauncherUpdateLoading(true)
    setLauncherUpdateMessage(null)
    try {
      const res = await window.electronAPI.getLauncherUpdateStatus(force)
      if (res.success && res.status) {
        setLauncherUpdate(res.status)
        setLauncherVersion(res.status.currentVersion || '—')
      } else {
        setLauncherUpdate({
          currentVersion: launcherVersion !== '—' ? launcherVersion : '',
          updateAvailable: false,
          error: ipcErrorText(t, res, t('settings.launcherUpdate.failed'))
        })
      }
    } catch (err: any) {
      setLauncherUpdate({
        currentVersion: launcherVersion !== '—' ? launcherVersion : '',
        updateAvailable: false,
        error: err?.message || String(err)
      })
    } finally {
      setLauncherUpdateLoading(false)
    }
  }

  useEffect(() => {
    if (notificationTestCountdown <= 0) return
    const id = setTimeout(() => setNotificationTestCountdown((n) => n - 1), 1000)
    return () => clearTimeout(id)
  }, [notificationTestCountdown])

  const runNotificationTest = async () => {
    setNotificationTestError(null)
    try {
      const res = await window.electronAPI.testNotification()
      if (!res?.success) {
        setNotificationTestError(res?.error === 'notifications-disabled'
          ? t('settings.notifications.testDisabled')
          : t('settings.notifications.testFailed'))
        return
      }
      setNotificationTestCountdown(Math.max(1, Math.round((res.delayMs || 5000) / 1000)))
    } catch {
      setNotificationTestError(t('settings.notifications.testFailed'))
    }
  }

  const installLauncherUpdate = async () => {
    if (!launcherUpdate?.canAutoUpdate) {
      if (launcherUpdate?.releaseUrl) await window.electronAPI.openExternal(launcherUpdate.releaseUrl)
      return
    }

    setLauncherUpdateInstalling(true)
    setLauncherUpdateMessage(t('settings.launcherUpdate.installing'))
    try {
      const res = await window.electronAPI.installLauncherAppImageUpdate()
      if (!res.success) {
        setLauncherUpdateMessage(ipcErrorText(t, res, t('settings.launcherUpdate.installFailed')))
        setLauncherUpdateInstalling(false)
      } else {
        setLauncherUpdateMessage(res.message || t('settings.launcherUpdate.restarting'))
      }
    } catch (err: any) {
      setLauncherUpdateMessage(err?.message || String(err))
      setLauncherUpdateInstalling(false)
    }
  }

  const refreshRuntimes = async (force = false) => {
    try {
      const res = await window.electronAPI.protonListRuntimes(force)
      if (res.success) {
        setRuntimes(res.runtimes || [])
      }
    } catch (err) {
      console.warn('Failed to list proton runtimes', err)
    }
  }

  const shortenPathForLabel = (p: string) => {
    const raw = String(p || '').trim()
    if (!raw) return ''
    const parts = raw.split('/').filter(Boolean)
    if (parts.length <= 3) return raw
    return `…/${parts.slice(-3).join('/')}`
  }

  const selectedRuntimeTitle = useMemo(() => {
    const selected = String(settings.protonDefaultRuntimePath || '').trim()
    if (!selected) return ''
    const rt = runtimes.find((r) => String(r.path) === selected)
    return rt ? `${rt.name} • ${rt.path}` : selected
  }, [runtimes, settings.protonDefaultRuntimePath])

  const selectDownloadPath = async () => {
    const res = await window.electronAPI.selectDirectory()
    if (res.success && res.path) {
      setSettings(prev => ({ ...prev, downloadPath: res.path || prev.downloadPath }))
    }
  }

  const selectGamesPath = async () => {
    const res = await window.electronAPI.selectDirectory()
    if (res.success && res.path) {
      setSettings(prev => ({ ...prev, gamesPath: res.path || prev.gamesPath }))
    }
  }

  const addProtonSearchPath = async () => {
    if (!platformInfo.isLinux) return
    const res = await window.electronAPI.selectDirectory()
    if (res.success && res.path) {
      const p = String(res.path).trim()
      if (!p) return

      try {
        const update = await window.electronAPI.protonSetRoot(p)
        if (update.success) setRuntimes(update.runtimes || [])
      } catch {
        // ignore
      }

      setSettings((prev) => ({
        ...prev,
        protonExtraPaths: Array.from(new Set([...(prev.protonExtraPaths || []), p]))
      }))
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setSaveStatus({ state: 'saving', message: t('settings.save.saving') })
    try {
      const res = await window.electronAPI.saveSettings(settings)
      if (!res.success) {
        setSaveStatus({ state: 'error', message: ipcErrorText(t, res, t('settings.save.error')) })
        toast.error(t('settings.save.error'), (ipcErrorText(t, res) || undefined))
      } else {
        await loadSettings()
        if (platformInfo.isLinux) {
          refreshRuntimes()
        }
        loadLauncherDiagnostics()
        setSaveStatus({ state: 'saved', message: t('settings.save.saved') })
        toast.success(t('settings.unsaved.saved'))
      }
    } catch (err: any) {
      setSaveStatus({ state: 'error', message: err?.message || t('settings.save.error') })
      toast.error(t('settings.save.error'), err?.message || undefined)
    } finally {
      setSaving(false)
    }
  }

  // =========================
  // DRIVE helpers
  // =========================

  const driveAuth = async () => {
    setDriveStatusTimed(t('settings.cloud.authStarting'))
    try {
      const res = await window.electronAPI.driveAuth()
      if (res.success) {
        setDriveConnected(true)
        const prepared = (res as any)?.ludusaviPrepared
        const downloaded = (res as any)?.ludusaviDownloaded
        const err = String((res as any)?.ludusaviError || '').trim()

        if (prepared === true) {
          setDriveStatusTimed(downloaded ? t('settings.cloud.authenticatedDownloaded') : t('settings.cloud.authenticatedReady'))
        } else if (prepared === false) {
          setDriveStatusTimed(t('settings.cloud.authLudusaviFailed') + (err ? ': ' + err : ''), 9000)
        } else {
          setDriveStatusTimed(t('settings.cloud.authenticated'))
        }
      } else {
        setDriveStatusTimed(t('settings.errorPrefix', { message: res.message || '' }))
        setDriveConnected(false)
      }
    } catch (e) {
      setDriveStatusTimed(t('settings.errorPrefix', { message: String(e) }))
      setDriveConnected(false)
    }
  }

  const driveList = async () => {
    setDriveStatusTimed(t('settings.cloud.listing'))
    try {
      const res = await window.electronAPI.driveListSaves()

      // Compatibility: some handlers return the array directly, others return {success, files}.
      if (Array.isArray(res)) {
        setDriveFiles(res as DriveFile[])
        setDriveStatusTimed('OK')
      } else if (res && typeof res === 'object' && res.success && Array.isArray(res.files)) {
        setDriveFiles(res.files as DriveFile[])
        setDriveStatusTimed('OK')
      } else if (res && typeof res === 'object' && res.error) {
        setDriveFiles(null)
        setDriveStatusTimed(t('settings.errorPrefix', { message: ipcErrorText(t, res) }))
      } else if (res && typeof res === 'object' && res.success === false) {
        setDriveFiles(null)
        setDriveStatusTimed(t('settings.errorPrefix', { message: String(res.message || ipcErrorText(t, res, t('downloads.status.error'))) }))
      } else {
        setDriveFiles(null)
        setDriveStatusTimed(t('settings.errorPrefix', { message: t('settings.cloud.unexpectedResponse') }))
      }
    } catch (e) {
      setDriveFiles(null)
      setDriveStatusTimed(t('settings.errorPrefix', { message: String(e) }))
    }
  }

  const driveDownload = async (fileId: string, fileName: string) => {
    setDriveStatusTimed(t('downloads.status.downloading') + '...', 4500)
    try {
      const safeName = String(fileName || 'save.zip').replace(/[\/\\]/g, '_')
      const dest = `${settings.downloadPath}/${safeName}`
      const res = await window.electronAPI.driveDownloadSave(fileId, dest)
      if (res.success) setDriveStatusTimed(t('settings.cloud.downloadedTo', { path: dest }), 4500)
      else setDriveStatusTimed(t('settings.errorPrefix', { message: res.message || '' }), 4500)
    } catch (e) {
      setDriveStatusTimed(t('settings.errorPrefix', { message: String(e) }), 4500)
    }
  }

  const gamesPathHint = settings.gamesPathDefault
    ? t('settings.path.default', { path: settings.gamesPathDefault })
    : t('settings.path.default', { path: '~/Games/VoidLauncher' })
  const downloadPathHint = settings.downloadPathDefault
    ? t('settings.path.default', { path: settings.downloadPathDefault })
    : t('settings.path.default', { path: '~/Downloads' })
  const diagnosticSummary = launcherDiagnostics ? [
    [t('settings.launcherDiagnostics.platform'), launcherDiagnostics.app?.platform || platformInfo.platform],
    ['Proton', launcherDiagnostics.linux?.protonRuntime ? 'OK' : platformInfo.isLinux ? t('library.configModal.diagnostics.pending') : 'N/A'],
    ['Torrent agent', launcherDiagnostics.tools?.torrentAgentPath ? 'OK' : 'Fallback'],
    ['Ludusavi', launcherDiagnostics.tools?.ludusaviPath ? 'OK' : t('common.missing')]
  ] : []

  const saveStatusText = (() => {
    switch (saveStatus.state) {
      case 'idle': return t('settings.save.idle')
      case 'pending': return t('settings.save.pending')
      case 'saving': return t('settings.save.saving')
      case 'saved': return t('settings.save.saved')
      case 'error': return saveStatus.message || t('settings.save.error')
      default: return saveStatus.message
    }
  })()

  return (
    <div className="settings-page">
      {loading && (
        <div className="settings-loading">
          <RefreshCw size={20} className="of-spin" />
          <span>{t('settings.loading')}</span>
        </div>
      )}

      {/* Header */}
      <div className="settings-header">
        <div className="settings-header-icon">
          <Settings2 size={24} />
        </div>
        <div>
          <h1>{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
      </div>

      {/* General Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <Settings2 size={18} />
          <h3>{t('settings.general.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Globe size={16} />
                {t('settings.language.title')}
              </div>
              <div className="settings-card-description">
                {t('settings.language.description')}
              </div>
            </div>
            <div className="settings-card-control">
              <div className="settings-select-wrapper">
                <select
                  className="settings-select settings-select-compact"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}
                >
                  {supportedLanguages.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.nativeLabel}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className="settings-select-icon" />
              </div>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Minimize2 size={16} />
                {t('settings.minimizeToTray.title')}
              </div>
              <div className="settings-card-description">
                {t('settings.minimizeToTray.description')}
              </div>
            </div>
            <div className="settings-card-control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.minimizeToTray === true}
                  onChange={(e) => setSettings({ ...settings, minimizeToTray: e.target.checked })}
                />
                <span className="settings-toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Bell size={16} />
                {t('settings.notifications.title')}
              </div>
              <div className="settings-card-description">
                {t('settings.notifications.description')}
              </div>
              <div className="settings-status-message">
                {notificationTestError
                  || (notificationTestCountdown > 0
                    ? t('settings.notifications.testPending', { seconds: String(notificationTestCountdown) })
                    : t('settings.notifications.testHint'))}
              </div>
            </div>
            <div className="settings-card-control settings-actions-column">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled !== false}
                  onChange={(e) => setSettings({ ...settings, notificationsEnabled: e.target.checked })}
                />
                <span className="settings-toggle-slider"></span>
              </label>
              <button
                className="settings-btn ghost"
                onClick={runNotificationTest}
                disabled={notificationTestCountdown > 0 || settings.notificationsEnabled === false}
              >
                <Bell size={14} />
                {t('settings.notifications.test')}
              </button>
            </div>
          </div>


          </div>
        </div>
      </div>

      {/* Downloads Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <Download size={18} />
          <h3>{t('settings.downloads.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <HardDrive size={16} />
                {t('settings.downloads.gamesPath')}
              </div>
              <div className="settings-card-description">
                {t('settings.downloads.gamesPathDescription', { hint: gamesPathHint })}
              </div>
            </div>
            <div className="settings-card-control">
              <div className="settings-input-group">
                <input
                  type="text"
                  className="settings-input"
                  value={settings.gamesPath}
                  onChange={(e) => setSettings({ ...settings, gamesPath: e.target.value })}
                  placeholder={settings.gamesPathDefault || ''}
                />
                <button className="settings-btn secondary" onClick={selectGamesPath}>
                  <Folder size={14} />
                  {t('common.select')}
                </button>
                <button className="settings-btn ghost" onClick={() => setSettings({ ...settings, gamesPath: '' })}>
                  {t('common.useDefault')}
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Download size={16} />
                {t('settings.downloads.downloadPath')}
              </div>
              <div className="settings-card-description">
                {t('settings.downloads.downloadPathDescription', { hint: downloadPathHint })}
              </div>
            </div>
            <div className="settings-card-control">
              <div className="settings-input-group">
                <input
                  type="text"
                  className="settings-input"
                  value={settings.downloadPath}
                  onChange={(e) => setSettings({ ...settings, downloadPath: e.target.value })}
                  placeholder={settings.downloadPathDefault || ''}
                />
                <button className="settings-btn secondary" onClick={selectDownloadPath}>
                  <Folder size={14} />
                  {t('common.select')}
                </button>
                <button className="settings-btn ghost" onClick={() => setSettings({ ...settings, downloadPath: '' })}>
                  {t('common.useDefault')}
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">{t('settings.downloads.autoExtract')}</div>
              <div className="settings-card-description">
                {t('settings.downloads.autoExtractDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.autoExtract}
                  onChange={(e) => setSettings({ ...settings, autoExtract: e.target.checked })}
                />
                <span className="settings-toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">{t('settings.downloads.parallel')}</div>
              <div className="settings-card-description">
                {t('settings.downloads.parallelDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <input
                type="number"
                className="settings-input settings-input-sm"
                min="1"
                max="10"
                value={Number.isFinite(settings.parallelDownloads) ? settings.parallelDownloads : 3}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  setSettings({ ...settings, parallelDownloads: Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 1 })
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Updates Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <RefreshCw size={18} />
          <h3>{t('settings.updates.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">{t('settings.updates.autoCheck')}</div>
              <div className="settings-card-description">
                {t('settings.updates.autoCheckDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.autoUpdate}
                  onChange={(e) => setSettings({ ...settings, autoUpdate: e.target.checked })}
                />
                <span className="settings-toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <Key size={18} />
          <h3>{t('settings.achievements.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Key size={16} />
                Steam Web API Key
              </div>
              <div className="settings-card-description">
                {t('settings.achievements.steamKeyDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <input
                type="password"
                className="settings-input"
                value={settings.steamWebApiKey || ''}
                onChange={(e) => setSettings({ ...settings, steamWebApiKey: e.target.value })}
                placeholder={t('settings.achievements.steamKeyPlaceholder')}
              />
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Link size={16} />
                {t('settings.achievements.communitySchema')}
              </div>
              <div className="settings-card-description">
                {t('settings.achievements.communitySchemaDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <input
                type="text"
                className="settings-input"
                value={settings.achievementSchemaBaseUrl || ''}
                onChange={(e) => setSettings({ ...settings, achievementSchemaBaseUrl: e.target.value })}
                placeholder={t('settings.achievements.communitySchemaPlaceholder')}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Proton Section (Linux only) */}
      {platformInfo.isLinux && (
        <div className="settings-section">
          <div className="settings-section-header">
            <Monitor size={18} />
            <h3>{t('settings.proton.title')}</h3>
          </div>

          <div className="settings-card">
            <div className="settings-card-item vertical">
              <div className="settings-card-info">
                <div className="settings-card-title">
                  <Gamepad2 size={16} />
                  {t('settings.proton.default')}
                </div>
                <div className="settings-card-description">
                  {t('settings.proton.defaultDescription')}
                </div>
              </div>
              <div className="settings-proton-control">
                <div className="settings-select-wrapper">
                  <select
                    className="settings-select"
                    value={settings.protonDefaultRuntimePath}
                    onChange={(e) => setSettings({ ...settings, protonDefaultRuntimePath: e.target.value })}
                    title={selectedRuntimeTitle}
                  >
                    <option value="">{t('settings.proton.autoRecommended')}</option>
                    {runtimes.map((rt) => (
                      <option key={rt.runner} value={rt.path}>
                        {rt.name} • {shortenPathForLabel(rt.path)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} className="settings-select-icon" />
                </div>
                <div className="settings-btn-row">
                  <button className="settings-btn ghost" onClick={() => refreshRuntimes(true)}>
                    <RefreshCw size={14} />
                    {t('settings.proton.reload')}
                  </button>
                  <button className="settings-btn ghost" onClick={addProtonSearchPath}>
                    <FolderPlus size={14} />
                    {t('settings.proton.addPath')}
                  </button>
                </div>
              </div>
            </div>

            {(settings.protonExtraPaths || []).length > 0 && (
              <div className="settings-card-item vertical">
                <div className="settings-card-info">
                  <div className="settings-card-title">{t('settings.proton.extraPaths')}</div>
                  <div className="settings-card-description">
                    {t('settings.proton.extraPathsDescription')}
                  </div>
                </div>
                <div className="settings-paths-list">
                  {(settings.protonExtraPaths || []).map((p) => (
                    <div key={p} className="settings-path-item">
                      <code>{p}</code>
                      <button
                        className="settings-btn-icon"
                        onClick={() => setSettings((prev) => ({
                          ...prev,
                          protonExtraPaths: (prev.protonExtraPaths || []).filter((x) => x !== p)
                        }))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* VPN Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <Globe size={18} />
          <h3>{t('settings.vpn.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">{t('settings.vpn.defaultRoom')}</div>
              <div className="settings-card-description">
                {t('settings.vpn.defaultRoomDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <input
                type="text"
                className="settings-input"
                placeholder={t('settings.vpn.defaultRoomPlaceholder')}
                value={settings.lanDefaultNetworkId || ''}
                onChange={(e) => setSettings((prev) => ({ ...prev, lanDefaultNetworkId: e.target.value }))}
              />
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Link size={16} />
                VPN Controller URL
              </div>
              <div className="settings-card-description">
                {t('settings.vpn.controllerDescription', { url: 'https://vpn.mroz.dev.br' })}
              </div>
            </div>
            <div className="settings-card-control">
              <input
                type="text"
                className="settings-input"
                placeholder="https://vpn.mroz.dev.br"
                value={settings.lanControllerUrl || ''}
                onChange={(e) => setSettings((prev) => ({ ...prev, lanControllerUrl: e.target.value }))}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Cloud Saves Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <Cloud size={18} />
          <h3>{t('settings.cloud.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                {driveConnected ? <Cloud size={16} /> : <CloudOff size={16} />}
                {t('settings.cloud.connectionStatus')}
              </div>
              <div className="settings-card-description">
                {t('settings.cloud.connectionDescription')}
              </div>
            </div>
            <div className="settings-card-control settings-actions-column">
              <div className={`settings-status-badge ${driveConnected ? 'connected' : 'disconnected'}`}>
                {driveConnected ? <Check size={14} /> : <X size={14} />}
                {driveConnected ? t('settings.cloud.connected') : t('settings.cloud.disconnected')}
              </div>
              {driveStatus && (
                <div className="settings-status-message">{driveStatus}</div>
              )}
              <div className="settings-btn-row">
                <button className="settings-btn secondary" onClick={driveAuth}>
                  <Cloud size={14} />
                  {t('settings.cloud.connect')}
                </button>
                <button
                  className="settings-btn ghost"
                  onClick={async () => {
                    try {
                      const res = await window.electronAPI.driveDisconnect()
                      if (res?.success) {
                        setDriveConnected(false)
                        setDriveStatusTimed(t('settings.cloud.disconnectedStatus'))
                      } else {
                        setDriveStatusTimed(t('settings.errorPrefix', { message: res?.message || t('library.vpn.disconnectFailed') }))
                      }
                    } catch (e: any) {
                      setDriveStatusTimed(t('settings.errorPrefix', { message: e?.message || String(e) }))
                    }
                  }}
                  disabled={!driveConnected}
                >
                  {t('settings.cloud.disconnect')}
                </button>
                <button className="settings-btn ghost" onClick={driveList}>
                  <RefreshCw size={14} />
                  {t('settings.cloud.listBackups')}
                </button>
              </div>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">{t('settings.cloud.syncAutomatic')}</div>
              <div className="settings-card-description">
                {t('settings.cloud.syncAutomaticDescription')}
              </div>
            </div>
            <div className="settings-card-control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings.cloudSavesEnabled}
                  onChange={(e) => setSettings({ ...settings, cloudSavesEnabled: e.target.checked })}
                />
                <span className="settings-toggle-slider"></span>
              </label>
            </div>
          </div>

          {driveFiles && driveFiles.length > 0 && (
            <div className="settings-card-item vertical">
              <div className="settings-card-info settings-card-info-spaced">
                <div className="settings-card-title">{t('settings.cloud.driveBackups')}</div>
                <div className="settings-card-description">
                  {t('settings.cloud.driveBackupsDescription')}
                </div>
              </div>
              <div className="settings-drive-list">
                <div className="settings-drive-list-header">
                  <div>{t('settings.cloud.file')}</div>
                  <div>{t('settings.cloud.modified')}</div>
                  <div></div>
                </div>
                {driveFiles.map(f => (
                  <div key={f.id} className="settings-drive-list-item">
                    <div className="settings-drive-file-name">{f.name}</div>
                    <div className="settings-drive-file-date">{formatMaybeDate(f.modifiedTime)}</div>
                    <div>
                      <button className="settings-btn ghost sm" onClick={() => driveDownload(f.id, f.name)}>
                        <Download size={12} />
                        {t('downloads.status.downloading')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {driveFiles && driveFiles.length === 0 && (
            <div className="settings-empty-state">
              <CloudOff size={32} />
              <span>{t('settings.cloud.noBackups')}</span>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <Terminal size={18} />
          <h3>{t('settings.launcherDiagnostics.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item vertical">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Terminal size={16} />
                {t('settings.launcherDiagnostics.compatTools')}
              </div>
              <div className="settings-card-description">
                {t('settings.launcherDiagnostics.description')}
              </div>
            </div>

            <div className="settings-btn-row">
              <button className="settings-btn secondary" onClick={loadLauncherDiagnostics} disabled={diagnosticsLoading}>
                <RefreshCw size={14} className={diagnosticsLoading ? 'of-spin' : ''} />
                {t('settings.launcherDiagnostics.refresh')}
              </button>
              <button
                className="settings-btn ghost"
                onClick={copyDiagnostics}
                disabled={diagnosticsLoading || !launcherDiagnostics}
              >
                <Terminal size={14} />
                {t('settings.launcherDiagnostics.copy')}
              </button>
            </div>

            {launcherDiagnostics?.error ? (
              <div className="settings-inline-error">
                <AlertCircle size={14} />
                <span>{launcherDiagnostics.error}</span>
              </div>
            ) : null}

            {launcherDiagnostics ? (
              <>
                <div className="diagnostic-summary">
                  {diagnosticSummary.map(([label, value]) => (
                    <div className="diagnostic-summary-item" key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>

                <div className="diagnostic-check-list">
                  {(launcherDiagnostics.checks || []).map((check) => (
                    <div className={`diagnostic-check diagnostic-check--${check.status}`} key={check.id}>
                      <div className="diagnostic-check-status">
                        {check.status === 'ok' ? <Check size={14} /> : check.status === 'error' ? <AlertCircle size={14} /> : <Info size={14} />}
                      </div>
                      <div className="diagnostic-check-body">
                        <strong>{check.label}</strong>
                        <span>{check.detail || '—'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="settings-empty-state">
                <Terminal size={32} />
                <span>{t('settings.launcherDiagnostics.notLoaded')}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* About Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <Info size={18} />
          <h3>{t('settings.about.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">VoidLauncher</div>
              <div className="settings-card-description">
                {t('settings.about.version', { version: launcherVersion })}
              </div>
            </div>
            <div className="settings-version-badge">v{launcherVersion}</div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Download size={16} />
                {t('settings.launcherUpdate.title')}
              </div>
              <div className="settings-card-description">
                {launcherUpdate?.updateAvailable
                  ? t('settings.launcherUpdate.available', { version: launcherUpdate.latestVersion || launcherUpdate.latestTag || '' })
                  : launcherUpdate?.error
                    ? t('settings.launcherUpdate.failed')
                    : t('settings.launcherUpdate.upToDate')}
                {launcherUpdate?.fromCache ? ` ${t('settings.launcherUpdate.fromCache')}` : ''}
                {launcherUpdate?.updateAvailable && !launcherUpdate?.canAutoUpdate ? ` ${t('settings.launcherUpdate.manualOnly')}` : ''}
              </div>
              <div className="launcher-update-meta">
                <span>{t('settings.launcherUpdate.current')}: v{launcherUpdate?.currentVersion || launcherVersion}</span>
                <span>{t('settings.launcherUpdate.latest')}: {launcherUpdate?.latestVersion ? `v${launcherUpdate.latestVersion}` : '—'}</span>
                <span>{t('settings.launcherUpdate.package')}: {launcherUpdate?.canAutoUpdate ? 'AppImage' : t('settings.launcherUpdate.manual')}</span>
                {launcherUpdate?.appImageAsset?.name && <span>{launcherUpdate.appImageAsset.name}</span>}
                {launcherUpdate?.checkedAt && <span>{t('settings.launcherUpdate.checked')}: {formatMaybeDate(launcherUpdate.checkedAt)}</span>}
              </div>
              {launcherUpdateMessage && <div className="launcher-update-message">{launcherUpdateMessage}</div>}
            </div>
            <div className="settings-card-control settings-btn-row">
              <button
                className="settings-btn secondary"
                onClick={() => loadLauncherUpdate(true)}
                disabled={launcherUpdateLoading || launcherUpdateInstalling}
              >
                <RefreshCw size={14} className={launcherUpdateLoading ? 'of-spin' : ''} />
                {t('settings.launcherUpdate.check')}
              </button>
              <button
                className="settings-btn primary"
                disabled={launcherUpdateInstalling || (!launcherUpdate?.releaseUrl && !launcherUpdate?.canAutoUpdate)}
                onClick={installLauncherUpdate}
              >
                {launcherUpdate?.canAutoUpdate ? <Download size={14} className={launcherUpdateInstalling ? 'of-spin' : ''} /> : <ExternalLink size={14} />}
                {launcherUpdate?.canAutoUpdate
                  ? launcherUpdateInstalling ? t('settings.launcherUpdate.installingShort') : t('settings.launcherUpdate.installAppImage')
                  : t('settings.launcherUpdate.openRelease')}
              </button>
            </div>
          </div>

          <div className="settings-card-item">
            <div className="settings-card-info">
              <div className="settings-card-title">
                <Heart size={16} />
                {t('settings.donate.title')}
              </div>
              <div className="settings-card-description">
                {t('settings.donate.description')}
              </div>
            </div>
            <div className="settings-card-control">
              <button
                className="settings-btn primary"
                onClick={() => window.electronAPI.openExternal(LAUNCHER_DONATE_URL)}
              >
                <Heart size={14} />
                {t('settings.donate.button')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="settings-footer">
        <div className="config-save-pill" data-status={saveStatus.state}>
          {saveStatusText}
        </div>
        <button
          className="settings-btn primary lg"
          onClick={saveSettings}
          disabled={saving || !hasUnsavedChanges}
        >
          {saving ? (
            <><RefreshCw size={16} className="of-spin" /> {t('settings.save.buttonSaving')}</>
          ) : (
            <><Check size={16} /> {t('settings.save.button')}</>
          )}
        </button>
        <button
          className="settings-btn ghost lg"
          onClick={async () => {
            await loadSettings()
            toast.info(t('settings.unsaved.discarded'))
          }}
          disabled={saving || !hasUnsavedChanges}
        >
          <X size={16} /> {t('settings.unsaved.discard')}
        </button>
      </div>
    </div>
  )
}
