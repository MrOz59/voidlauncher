import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Cloud, CloudOff, Download, FolderOpen, HardDrive, Loader2, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { Game } from './types'

type LocalLocation = {
  path: string
  type: string
  confidence: string
  fileCount: number
  modifiedMs: number | null
}

type SaveBackup = {
  id: string
  name: string
  modifiedTime?: string
  saveModifiedMs: number | null
  format: string
  role: 'main' | 'conflict' | 'legacy'
  platform?: string
  restorable: boolean
}

type Overview = {
  gameKey: string
  connected: boolean
  local: { exists: boolean; modifiedMs: number | null; locations: LocalLocation[] }
  backups: SaveBackup[]
  customLocations: string[]
  recommendation: 'restore' | 'local' | 'ask' | 'none'
}

function displayTime(timestamp: number | null | undefined, fallback?: string) {
  const time = timestamp || (fallback ? Date.parse(fallback) : 0)
  return time && Number.isFinite(time) ? new Date(time).toLocaleString() : '—'
}

export function GameSavesTab({ game }: { game: Game }) {
  const { t } = useI18n()
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.electronAPI.cloudSavesGameOverview(game.url)
      if (!res?.success || !res.overview) throw new Error(res?.error || t('library.saves.loadError'))
      setData(res.overview as Overview)
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [game.url, t])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, action: () => Promise<any>, refresh = true) => {
    setBusy(key)
    setError('')
    setMessage('')
    try {
      const result = await action()
      if (!result?.success) throw new Error(result?.error || result?.message || t('library.saves.actionFailed'))
      if (!result?.canceled) {
        setMessage(result?.message || t('library.saves.actionComplete'))
        if (refresh) await load()
      }
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setBusy(null)
    }
  }

  const summary = !data ? '' : !data.connected ? t('library.saves.notConnected')
    : data.recommendation === 'restore' ? t('library.saves.remoteOnly')
    : data.recommendation === 'local' ? t('library.saves.localNewer')
    : data.recommendation === 'ask' ? t('library.saves.conflict')
    : t('library.saves.empty')

  return (
    <div className="modal-section">
      <div className="config-section">
        <div className="config-section-header">
          <HardDrive size={18} />
          <h4>{t('library.saves.localTitle')}</h4>
          <button className="config-btn secondary" onClick={() =>
            void run('add-folder', () => window.electronAPI.cloudSavesGameAddFolder(game.url))}
            disabled={!!busy || loading}>
            <FolderOpen size={14} />
            {t('library.saves.addFolder')}
          </button>
          <button className="config-btn secondary" onClick={() => { void load() }} disabled={loading || !!busy}>
            <RefreshCw size={14} className={loading ? 'of-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
        <div className="config-section-content">
          {loading && !data ? <p className="config-hint"><Loader2 size={14} className="of-spin" /> {t('common.loading')}</p> : null}
          {error ? <p role="alert" className="config-hint" style={{ color: '#fca5a5' }}><AlertCircle size={14} /> {error}</p> : null}
          {message ? <p role="status" className="config-hint"><ShieldCheck size={14} /> {message}</p> : null}
          {data && (
            <>
              <p className="config-hint">{data.local.exists
                ? t('library.saves.localFound')
                : t('library.saves.noLocal')}</p>
              {data.local.modifiedMs != null && <p className="config-hint">{t('library.saves.modified')}: {displayTime(data.local.modifiedMs)}</p>}
              {data.local.locations.length === 0 && (
                <p className="config-hint">{t('library.saves.notDetected')}</p>
              )}
              {data.customLocations.length > 0 && (
                <div className="config-section" style={{ marginBottom: 12 }}>
                  <div className="config-section-content">
                    <strong>{t('library.saves.customFolders')}</strong>
                    {data.customLocations.map(folder => (
                      <div key={folder} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{folder}</code>
                        <button className="config-btn secondary" disabled={!!busy}
                          title={t('library.saves.removeFolderHint')} onClick={() =>
                            void run('remove-folder:' + folder, () =>
                              window.electronAPI.cloudSavesGameRemoveFolder(game.url, folder))}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {data.local.locations.map((loc, index) => (
                <div key={loc.path + index} className="config-form-row" style={{ alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{loc.type}</strong>
                    <p className="config-hint" style={{ overflowWrap: 'anywhere', margin: '4px 0' }}>{loc.path}</p>
                    <small className="config-hint">
                      {t('library.saves.files')}: {loc.fileCount}
                      {' • '}{t('library.saves.modified')}: {displayTime(loc.modifiedMs)}
                      {' • '}{loc.confidence}
                    </small>
                  </div>
                  <button className="config-btn secondary" onClick={() => {
                    void run('open:' + index, () => window.electronAPI.openPath(loc.path), false)
                  }} disabled={!!busy} title={t('library.saves.openFolder')}>
                    <FolderOpen size={15} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="config-section">
        <div className="config-section-header">
          {data?.connected ? <Cloud size={18} /> : <CloudOff size={18} />}
          <h4>{t('library.saves.driveTitle')}</h4>
          <button className="config-btn secondary" onClick={() => {
            void run('backup', () => window.electronAPI.cloudSavesGameBackup(game.url))
          }} disabled={!data?.connected || !!busy || loading}>
            {busy === 'backup' ? <Loader2 size={14} className="of-spin" /> : <Upload size={14} />}
            {t('library.saves.backupNow')}
          </button>
        </div>
        <div className="config-section-content">
          {data && (
            <>
              <p className="config-hint">{summary}</p>
              {data.backups.length === 0 && data.connected && (
                <p className="config-hint">{t('library.saves.noBackups')}</p>
              )}
              {data.backups.map(backup => (
                <div key={backup.id} className="config-section" style={{ marginBottom: 12 }}>
                  <div className="config-section-content" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 230px', minWidth: 0 }}>
                      <strong style={{ overflowWrap: 'anywhere' }}>{backup.name}</strong>
                      <p className="config-hint" style={{ margin: '5px 0' }}>
                        {backup.role === 'main' ? t('library.saves.main') :
                          backup.role === 'conflict' ? t('library.saves.conflictCopy') : t('library.saves.legacy')}
                        {' • '}{backup.format}
                        {backup.platform ? ' • ' + backup.platform : ''}
                      </p>
                      <small className="config-hint">
                        {t('library.saves.saveDate')}: {displayTime(backup.saveModifiedMs)}
                        {' • '}{t('library.saves.uploaded')}: {displayTime(null, backup.modifiedTime)}
                      </small>
                      {!backup.restorable && <p className="config-hint">{t('library.saves.notRestorable')}</p>}
                    </div>
                    <div className="settings-btn-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="config-btn secondary" disabled={!!busy || !backup.restorable}
                        title={t('library.saves.restoreHint')} onClick={() =>
                          void run('restore:' + backup.id, () => window.electronAPI.cloudSavesGameRestore(game.url, backup.id))}>
                        {busy === 'restore:' + backup.id ? <Loader2 size={14} className="of-spin" /> : <RefreshCw size={14} />}
                        {t('library.saves.restore')}
                      </button>
                      <button className="config-btn secondary" disabled={!!busy} onClick={() =>
                        void run('export:' + backup.id, () => window.electronAPI.cloudSavesGameExport(game.url, backup.id), false)}>
                        <Download size={14} />
                        {t('library.saves.export')}
                      </button>
                      <button className="config-btn secondary" disabled={!!busy} title={t('library.saves.deleteHint')} onClick={() =>
                        void run('delete:' + backup.id, () => window.electronAPI.cloudSavesGameDeleteBackup(game.url, backup.id))}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <p className="config-hint">{t('library.saves.safety')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
