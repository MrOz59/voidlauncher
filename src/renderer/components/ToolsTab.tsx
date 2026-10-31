import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Download, ExternalLink, HardDrive, Loader2, LogIn, LogOut, Package, RefreshCw, Shield, Trash2, UserCircle, Wrench } from 'lucide-react'
import { useI18n } from '../i18n'
import { ipcErrorText } from '../../shared/ipcErrors'

type ReleaseInfo = {
  tag: string
  name: string
  publishedAt?: string
  assetName?: string
  downloadUrl?: string
}

type ToolKey = 'proton-ge' | 'proton-cachyos' | 'legendary' | 'ludusavi' | 'eos-overlay'
type ProtonTab = 'proton-ge' | 'proton-cachyos'

type ProtonGeInstall = {
  name: string
  version: string
  path: string
  runner: string
  installedAt?: number
  isDefault?: boolean
}

type LegendaryAuthInfo = {
  loggedIn?: boolean
  displayName?: string
  email?: string
  accountId?: string
  error?: string
  raw?: string
}

type EosOverlayInfo = {
  managed?: boolean
  valid?: boolean
  version?: string
  availableVersion?: string
  installPath?: string
  installedAt?: number
  raw?: string
  error?: string
}

type ToolStatus = {
  platform?: string
  isLinux?: boolean
  userData?: string
  protonGe?: {
    root?: string
    installed?: ProtonGeInstall[]
    defaultRuntime?: string | null
    prefixRoot?: string
    winetricks?: boolean
  }
  protonCachyos?: {
    root?: string
    installed?: ProtonGeInstall[]
    defaultRuntime?: string | null
    prefixRoot?: string
    winetricks?: boolean
  }
  tools?: {
    legendary?: { path?: string | null; version?: string | null; managedVersion?: string | null; managedDir?: string; auth?: LegendaryAuthInfo }
    ludusavi?: { path?: string | null; version?: string | null; managedVersion?: string | null; managedDir?: string }
    eosOverlay?: { path?: string | null; valid?: boolean; managedDir?: string; info?: EosOverlayInfo }
  }
}

function compactPath(value?: string | null): string {
  const p = String(value || '').trim()
  if (!p) return '—'
  if (p.length <= 74) return p
  const parts = p.split('/')
  if (parts.length < 4) return `...${p.slice(-70)}`
  return `${parts[0] || '/'}.../${parts.slice(-3).join('/')}`
}

function formatDate(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString()
}

function formatTimestamp(value?: number): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`tool-status-pill ${ok ? 'ok' : 'warn'}`}>
      {ok ? <Check size={13} /> : <AlertCircle size={13} />}
      {label}
    </span>
  )
}

export default function ToolsTab() {
  const { t } = useI18n()
  const [status, setStatus] = useState<ToolStatus | null>(null)
  const [releases, setReleases] = useState<Record<string, ReleaseInfo[]>>({})
  const [loading, setLoading] = useState(true)
  const [releaseLoading, setReleaseLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [protonTab, setProtonTab] = useState<ProtonTab>('proton-ge')

  const activeProton = protonTab === 'proton-ge' ? status?.protonGe : status?.protonCachyos
  const installedProton = activeProton?.installed || []
  const installedProtonTags = useMemo(
    () => new Set(installedProton.flatMap(item => [item.version, item.name].filter(Boolean))),
    [installedProton]
  )

  const loadStatus = async () => {
    setLoading(true)
    setMessage(null)
    try {
      const res = await window.electronAPI.getToolsStatus()
      if (res.success) setStatus(res.status || null)
      else setMessage(ipcErrorText(t, res, t('tools.statusFailed')))
    } catch (err: any) {
      setMessage(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  const loadReleases = async (force = false, linuxPlatform = status?.isLinux === true) => {
    setReleaseLoading(true)
    try {
      const keys: ToolKey[] = linuxPlatform
        ? ['proton-ge', 'proton-cachyos', 'legendary', 'ludusavi']
        : ['legendary', 'ludusavi']
      const errors: string[] = []
      const results = await Promise.all(keys.map(async key => {
        const res = await window.electronAPI.listToolReleases(key, 12, force)
        if (!res.success) errors.push(`${key}: ${ipcErrorText(t, res, t('tools.releases.failed'))}`)
        return [key, res.success ? (res.releases || []) : []] as const
      }))
      setReleases(Object.fromEntries(results))
      if (errors.length) setMessage(errors.join('\n'))
    } catch (err: any) {
      setMessage(err?.message || String(err))
    } finally {
      setReleaseLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      let linuxPlatform = false
      try {
        const res = await window.electronAPI.getToolsStatus()
        if (!mounted) return
        if (res.success) {
          setStatus(res.status || null)
          linuxPlatform = res.status?.isLinux === true
        } else {
          setMessage(ipcErrorText(t, res, t('tools.statusFailed')))
        }
      } catch (err: any) {
        if (mounted) setMessage(err?.message || String(err))
      } finally {
        if (mounted) setLoading(false)
      }
      if (mounted) await loadReleases(false, linuxPlatform)
    })()
    return () => { mounted = false }
  }, [])

  const runAction = async (key: string, action: () => Promise<any>) => {
    setBusy(key)
    setMessage(null)
    try {
      const res = await action()
      if (res?.success) {
        if (res.status) setStatus(res.status)
        else await loadStatus()
        setMessage(t('tools.actionDone'))
      } else {
        setMessage(res?.error || t('tools.actionFailed'))
      }
    } catch (err: any) {
      setMessage(err?.message || String(err))
    } finally {
      setBusy(null)
    }
  }

  const install = (tool: ToolKey, version?: string) => {
    runAction(`${tool}:${version || 'latest'}`, () => window.electronAPI.installTool(tool, version || 'latest'))
  }

  const setDefaultProton = (runtimePath: string) => {
    runAction(`default:${runtimePath}`, () => window.electronAPI.setDefaultProtonRuntime(runtimePath))
  }

  const removeProton = (runtimePath: string) => {
    runAction(`remove:${runtimePath}`, () => window.electronAPI.removeProtonGeRuntime(runtimePath))
  }

  const legendaryAuth = (action: 'status' | 'login' | 'logout') => {
    runAction(`legendary-auth:${action}`, () => window.electronAPI.legendaryAuth(action))
  }

  const eosOverlayAction = (action: 'info' | 'install' | 'update' | 'remove') => {
    runAction(`eos-overlay:${action}`, () => window.electronAPI.eosOverlayAction(action))
  }

  const renderLegendaryAccount = () => {
    const auth = status?.tools?.legendary?.auth
    const loggedIn = !!auth?.loggedIn
    const title = loggedIn
      ? (auth?.displayName || auth?.email || auth?.accountId || t('tools.legendary.loggedIn'))
      : t('tools.legendary.notLogged')
    const detail = loggedIn
      ? [auth?.email, auth?.accountId].filter(Boolean).join(' • ')
      : (auth?.error || t('tools.legendary.loginHint'))
    const action = loggedIn ? 'logout' : 'login'
    const busyKey = `legendary-auth:${action}`

    return (
      <div className="tool-account-row">
        <UserCircle size={18} />
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
        <button className={loggedIn ? 'settings-btn ghost' : 'settings-btn primary'} onClick={() => legendaryAuth(action)} disabled={!!busy}>
          {loggedIn ? <LogOut size={14} className={busy === busyKey ? 'of-spin' : ''} /> : <LogIn size={14} className={busy === busyKey ? 'of-spin' : ''} />}
          {loggedIn ? t('tools.legendary.logout') : t('tools.legendary.login')}
        </button>
      </div>
    )
  }

  const renderEosOverlayCard = () => {
    const eos = status?.tools?.eosOverlay
    const info = eos?.info
    const valid = !!eos?.valid
    const currentVersion = info?.version || t('tools.eos.versionUnknown')
    const availableVersion = info?.availableVersion || t('tools.eos.availableUnknown')
    const note = info?.managed === false && valid
      ? t('tools.eos.externalInstall')
      : (info?.error || t('tools.eos.managedByLegendary'))
    const installOrUpdate = valid ? 'update' : 'install'

    return (
      <div className="tool-card eos-tool-card">
        <div className="tool-card-header">
          <div>
            <h4>EOS Overlay</h4>
            <p>{t('tools.eos.description')}</p>
          </div>
          <StatusPill ok={valid} label={valid ? t('common.available') : t('common.missing')} />
        </div>

        <div className="eos-version-grid">
          <div className="eos-version-box">
            <span>{t('tools.eos.currentVersion')}</span>
            <strong>{currentVersion}</strong>
          </div>
          <div className="eos-version-box">
            <span>{t('tools.eos.availableVersion')}</span>
            <strong>{availableVersion}</strong>
          </div>
        </div>

        <div className="eos-path-block">
          <div>
            <span>{t('tools.path')}</span>
            <code>{compactPath(eos?.path || info?.installPath)}</code>
          </div>
          <div>
            <span>{t('tools.destination')}</span>
            <code>{compactPath(eos?.managedDir)}</code>
          </div>
          {info?.installedAt ? (
            <div>
              <span>{t('tools.eos.installedAt')}</span>
              <code>{formatTimestamp(info.installedAt)}</code>
            </div>
          ) : null}
        </div>

        <div className="eos-note">
          <strong>{t('tools.eos.managedRelease')}</strong>
          <span>{note}</span>
        </div>

        <div className="eos-actions">
          <button className="settings-btn primary" onClick={() => eosOverlayAction(installOrUpdate)} disabled={!status?.isLinux || !!busy}>
            <Shield size={14} className={busy === `eos-overlay:${installOrUpdate}` ? 'of-spin' : ''} />
            {valid ? t('tools.eos.update') : t('tools.eos.install')}
          </button>
          <button className="settings-btn ghost" onClick={() => eosOverlayAction('info')} disabled={!status?.isLinux || !!busy}>
            <RefreshCw size={14} className={busy === 'eos-overlay:info' ? 'of-spin' : ''} />
            {t('common.refresh')}
          </button>
          <button className="settings-btn danger" onClick={() => eosOverlayAction('remove')} disabled={!status?.isLinux || !!busy || !valid}>
            <Trash2 size={14} />
            {t('tools.eos.uninstall')}
          </button>
        </div>

        <button className="settings-btn ghost eos-legendary-link" onClick={() => window.electronAPI.openExternal('https://github.com/legendary-gl/legendary/releases')}>
          <ExternalLink size={14} />
          Legendary
        </button>
      </div>
    )
  }

  const renderReleaseList = (tool: ToolKey, installedTags = new Set<string>()) => {
    const list = releases[tool] || []
    if (!list.length) {
      return (
        <div className="settings-empty-state compact">
          <Package size={24} />
          <span>{releaseLoading ? t('common.loading') : t('tools.releases.empty')}</span>
        </div>
      )
    }

    return (
      <div className="tool-release-list">
        {list.map(release => {
          const installed = installedTags.has(release.tag) || installedTags.has(release.name)
          const key = `${tool}:${release.tag}`
          const installing = busy === key
          return (
            <div className="tool-release-row" key={key}>
              <div>
                <strong>{release.name || release.tag}</strong>
                <span>{[release.tag, formatDate(release.publishedAt), release.assetName].filter(Boolean).join(' • ')}</span>
              </div>
              <button className={installed ? 'settings-btn ghost' : 'settings-btn primary'} onClick={() => install(tool, release.tag)} disabled={!!busy || !release.downloadUrl}>
                {installing ? <Loader2 size={14} className="of-spin" /> : <Download size={14} />}
                {installed ? t('tools.reinstall') : t('tools.install')}
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="settings-container tools-container">
      <div className="settings-header">
        <div>
          <h1>
            <Wrench size={24} />
            {t('tools.title')}
          </h1>
          <p>{t('tools.subtitle')}</p>
        </div>
        <div className="settings-btn-row">
          <button className="settings-btn secondary" onClick={() => { loadStatus(); loadReleases(true, status?.isLinux === true) }} disabled={loading || releaseLoading || !!busy}>
            <RefreshCw size={14} className={loading || releaseLoading ? 'of-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {message ? (
        <div className="settings-alert">
          <AlertCircle size={16} />
          <span>{message}</span>
        </div>
      ) : null}

      {status?.isLinux === true && (
      <div className="settings-section">
        <div className="settings-section-header">
          <Package size={18} />
          <h3>{t('tools.proton.title')}</h3>
        </div>

        <div className="settings-card">
          <div className="settings-card-item vertical">
            <div className="settings-card-info">
              <div className="settings-card-title">{protonTab === 'proton-ge' ? 'Proton-GE' : 'Proton-CachyOS'}</div>
              <div className="settings-card-description">
                {protonTab === 'proton-ge' ? t('tools.proton.description') : t('tools.proton.cachyosDescription')}
              </div>
            </div>
            <div className="settings-btn-row">
              <button className="settings-btn ghost" onClick={() => window.electronAPI.openPath(activeProton?.root || '')} disabled={!activeProton?.root}>
                <HardDrive size={14} />
                {t('tools.openFolder')}
              </button>
            </div>
          </div>

          <div className="tool-tabs">
            <button className={protonTab === 'proton-ge' ? 'active' : ''} onClick={() => setProtonTab('proton-ge')}>
              Proton-GE
            </button>
            <button className={protonTab === 'proton-cachyos' ? 'active' : ''} onClick={() => setProtonTab('proton-cachyos')}>
              Proton-CachyOS
            </button>
          </div>

          <div className="tool-managed-block">
            <div className="tool-managed-header">
              <strong>{t('tools.installedVersions')}</strong>
              <span>{compactPath(activeProton?.root)}</span>
            </div>
            {installedProton.length ? (
              <div className="tool-runtime-list">
                {installedProton.map(runtime => (
                  <div className="tool-runtime-row" key={runtime.path}>
                    <div>
                      <strong>{runtime.name}</strong>
                      <span>{runtime.isDefault ? t('tools.proton.defaultSelected') : runtime.version}</span>
                      <code>{runtime.path}</code>
                    </div>
                    <div className="tool-row-actions">
                      <button className="settings-btn ghost" onClick={() => setDefaultProton(runtime.path)} disabled={!!busy || runtime.isDefault}>
                        <Check size={14} />
                        {runtime.isDefault ? t('tools.proton.selected') : t('tools.proton.use')}
                      </button>
                      <button className="settings-btn-icon" onClick={() => removeProton(runtime.path)} disabled={!!busy}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-empty-state compact">
                <Package size={24} />
                <span>{status?.isLinux ? t('tools.proton.emptyManaged') : t('tools.proton.linuxOnly')}</span>
              </div>
            )}
          </div>

          <div className="tool-managed-block">
            <div className="tool-managed-header">
              <strong>{t('tools.availableVersions')}</strong>
              <span>{protonTab === 'proton-ge' ? t('tools.proton.releaseSource') : t('tools.proton.cachyosReleaseSource')}</span>
            </div>
            {renderReleaseList(protonTab, installedProtonTags)}
          </div>

          <div className="tool-mini-grid">
            <div>
              <span>winetricks</span>
              <StatusPill ok={!!status?.protonGe?.winetricks} label={status?.protonGe?.winetricks ? t('common.available') : t('common.missing')} />
            </div>
          </div>
        </div>
      </div>
      )}

      <div className="settings-section">
        <div className="settings-section-header">
          <Wrench size={18} />
          <h3>{t('tools.managed.title')}</h3>
        </div>

        <div className="tools-card-grid">
          <div className="tool-card">
            <div className="tool-card-header">
              <div>
                <h4>Legendary</h4>
                <p>{t('tools.legendary.description')}</p>
              </div>
              <StatusPill ok={!!status?.tools?.legendary?.path} label={status?.tools?.legendary?.path ? t('common.available') : t('common.missing')} />
            </div>
            <div className="tool-meta">
              <span>{t('tools.currentVersion')}</span>
              <strong>{status?.tools?.legendary?.version || status?.tools?.legendary?.managedVersion || '—'}</strong>
              <span>{t('tools.path')}</span>
              <code>{compactPath(status?.tools?.legendary?.path)}</code>
            </div>
            {renderLegendaryAccount()}
            {renderReleaseList('legendary')}
          </div>

          <div className="tool-card">
            <div className="tool-card-header">
              <div>
                <h4>Ludusavi</h4>
                <p>{t('tools.ludusavi.description')}</p>
              </div>
              <StatusPill ok={!!status?.tools?.ludusavi?.path} label={status?.tools?.ludusavi?.path ? t('common.available') : t('common.missing')} />
            </div>
            <div className="tool-meta">
              <span>{t('tools.currentVersion')}</span>
              <strong>{status?.tools?.ludusavi?.version || status?.tools?.ludusavi?.managedVersion || '—'}</strong>
              <span>{t('tools.path')}</span>
              <code>{compactPath(status?.tools?.ludusavi?.path)}</code>
            </div>
            {renderReleaseList('ludusavi')}
          </div>

          {status?.isLinux === true && renderEosOverlayCard()}
        </div>
      </div>
    </div>
  )
}
