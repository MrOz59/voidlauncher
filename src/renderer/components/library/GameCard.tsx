import React, { useRef, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Play, Trash2, RefreshCw, Folder, Library, AlertCircle, Settings, Download, Square, FileText, Trophy, Star, MoreVertical, Cloud } from 'lucide-react'
import type { Game, LaunchState, PrefixJobState, SaveSyncJobState, AchievementProgress, UpdatingGameState, UpdateQueueState } from './types'
import { hasUpdate } from './useFilteredGames'
import { useI18n } from '../../i18n'

export interface GameCardProps {
  game: Game
  launchState?: LaunchState
  prefixState?: PrefixJobState
  syncState?: SaveSyncJobState
  achievementProgress?: AchievementProgress
  updatingGames: Record<string, UpdatingGameState>
  updateQueue: UpdateQueueState
  isActionMenuOpen: boolean
  onToggleActionMenu: () => void
  onCloseActionMenu: () => void
  onOpenConfig: () => void
  onOpenSaves: () => void
  onToggleFavorite: () => void
  onOpenFolder: () => void
  onUpdate: () => void
  onOpenProtonLog: () => void
  onDelete: () => void
  onOpenAchievements: () => void
  onPlay: () => void
  onStop: () => void
}

/** "12 h · 3 d ago" — the launcher records both, nothing showed them. */
function usageSummary(
  game: { play_time?: number | null; last_played?: string | null },
  t: (key: string, params?: Record<string, string | number>) => string
): string | null {
  const parts: string[] = []
  const minutes = Math.max(0, Number(game.play_time) || 0)

  if (minutes >= 60) parts.push(t('library.card.playtimeHours', { hours: Math.round(minutes / 60) }))
  else if (minutes > 0) parts.push(t('library.card.playtimeMinutes', { minutes }))

  const played = game.last_played ? new Date(game.last_played) : null
  if (played && !Number.isNaN(played.getTime())) {
    const days = Math.floor((Date.now() - played.getTime()) / 86400000)
    if (days <= 0) parts.push(t('library.card.lastPlayedToday'))
    else if (days === 1) parts.push(t('library.card.lastPlayedYesterday'))
    else parts.push(t('library.card.lastPlayedDays', { days }))
  }

  return parts.length ? parts.join(' · ') : null
}

export function GameCard({
  game,
  launchState,
  prefixState,
  syncState,
  achievementProgress,
  updatingGames,
  updateQueue,
  isActionMenuOpen,
  onToggleActionMenu,
  onCloseActionMenu,
  onOpenConfig,
  onOpenSaves,
  onToggleFavorite,
  onOpenFolder,
  onUpdate,
  onOpenProtonLog,
  onDelete,
  onOpenAchievements,
  onPlay,
  onStop
}: GameCardProps) {
  const { t } = useI18n()
  const usage = usageSummary(game, t)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number } | null>(null)

  const updateAvailable = hasUpdate(game)
  const isFavorite = !!(game as any)?.is_favorite
  const isGameUpdating = !!(updatingGames[game.url]) || (updateQueue?.running && updateQueue?.currentGameUrl === game.url)

  const isPrefixing = prefixState?.status === 'starting' || prefixState?.status === 'progress'
  const isLaunching = launchState?.status === 'starting' || launchState?.status === 'running'
  const isError = launchState?.status === 'error' || (launchState?.status === 'exited' && launchState?.code != null && Number(launchState.code) !== 0)
  const isSyncing = syncState?.status === 'syncing'
  const canOpenLogs = Boolean(launchState?.protonLogPath || launchState?.stderrTail || isLaunching || isError)

  const isAchvComplete = !!achievementProgress?.complete

  const label = isGameUpdating
    ? t('library.card.updating')
    : isSyncing
      ? (syncState?.message || t('library.card.syncingSaves'))
      : isPrefixing
        ? (prefixState?.message || t('library.prefix.preparing'))
        : isLaunching
          ? (launchState?.message || (launchState?.status === 'running' ? t('library.card.running') : t('library.launch.starting')))
          : isError
            ? (launchState?.code != null ? t('library.card.launchFailedWithCode', { code: launchState.code }) : t('library.card.launchFailed'))
            : ''

  // Update menu position when opened
  useEffect(() => {
    if (isActionMenuOpen && menuButtonRef.current) {
      const rect = menuButtonRef.current.getBoundingClientRect()
      const menuWidth = 220
      
      // Position: bottom-left corner of menu should be just above the button
      // Using bottom positioning from viewport bottom
      let bottom = window.innerHeight - rect.top + 4
      let left = rect.left
      
      // If menu would go off right edge, align to right of button
      if (left + menuWidth > window.innerWidth - 10) {
        left = rect.right - menuWidth
      }
      
      // If menu would go off left edge
      if (left < 10) {
        left = 10
      }
      
      setMenuPosition({ bottom, left })
    }
  }, [isActionMenuOpen])

  return (
    <div className={`game-card-heroic ${updateAvailable ? 'has-update' : ''} ${isGameUpdating ? 'is-updating' : ''} ${isActionMenuOpen ? 'menu-open' : ''}`}>
      <div style={{ position: 'relative' }}>
        <div className="game-cover">
          {game.image_url ? (
            <img src={game.image_url} alt={game.title} loading="lazy" decoding="async" />
          ) : (
            <div className="game-cover-placeholder">
              <Library size={48} />
            </div>
          )}

          {(isLaunching || isPrefixing || isError || isSyncing || isGameUpdating) && (
            <div
              style={{
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: 10,
                padding: '8px 10px',
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: isError ? 'rgba(185, 28, 28, 0.85)' : 'rgba(17, 24, 39, 0.85)',
                border: isError ? '1px solid rgba(239, 68, 68, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
                color: '#fff',
                fontSize: 12,
                backdropFilter: 'blur(6px)'
              }}
              title={syncState?.message || launchState?.stderrTail || prefixState?.message || launchState?.message || ''}
            >
              {(isSyncing || isLaunching || isPrefixing || isGameUpdating) ? <RefreshCw size={14} className="of-spin" /> : <AlertCircle size={14} />}
              <span style={{ lineHeight: 1.1, flex: 1 }}>{label}</span>
            </div>
          )}

          {updateAvailable && (
            <div className="update-badge" title={t('library.card.needsUpdate')}>
              <Download size={12} />
            </div>
          )}

          {/* Favorite badge */}
          {isFavorite && (
            <div
              className="favorite-badge"
              title={t('library.card.favorite')}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: 'rgba(234, 179, 8, 0.9)',
                borderRadius: 6,
                padding: '4px 6px',
                display: 'flex',
                alignItems: 'center',
                backdropFilter: 'blur(4px)',
                border: '1px solid rgba(255, 255, 255, 0.15)'
              }}
            >
              <Star size={12} fill="#fff" style={{ color: '#fff' }} />
            </div>
          )}

          {/* Cloud Saves badge - shown when game has steam_app_id for save detection */}
          {(game as any)?.steam_app_id && (
            <div
              className="cloud-badge"
              title={t('library.card.cloudSavesEnabled')}
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                background: 'rgba(59, 130, 246, 0.85)',
                borderRadius: 6,
                padding: '4px 6px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                backdropFilter: 'blur(4px)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
            >
              <Cloud size={12} style={{ color: '#fff' }} />
            </div>
          )}

          <div className="game-overlay">
            <div className="overlay-content">
              {!game.executable_path && (
                <div className="exe-warning">
                  <AlertCircle size={16} />
                  <span>{t('library.card.configureExe')}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="game-action-bar">
          <div className="action-menu" onClick={(e) => e.stopPropagation()}>
            <button
              ref={menuButtonRef}
              className="action-btn menu"
              onClick={(e) => {
                e.stopPropagation()
                onToggleActionMenu()
              }}
              title={t('library.card.moreActions')}
            >
              <MoreVertical size={18} />
            </button>

            {isActionMenuOpen && menuPosition && createPortal(
              <div 
                className="action-menu-panel-portal"
                style={{
                  position: 'fixed',
                  bottom: menuPosition.bottom,
                  left: menuPosition.left,
                  zIndex: 9999
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <button className="action-menu-item" onClick={() => { onCloseActionMenu(); onOpenConfig() }}>
                  <Settings size={16} />
                  <span>{t('library.card.settings')}</span>
                </button>

                <button className="action-menu-item" onClick={() => { onCloseActionMenu(); onOpenSaves() }}>
                  <Cloud size={16} />
                  <span>{t('library.saves.tab')}</span>
                </button>

                <button className="action-menu-item" onClick={() => { onCloseActionMenu(); onToggleFavorite() }}>
                  <Star size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                  <span>{isFavorite ? t('library.card.removeFavorite') : t('library.card.addFavorite')}</span>
                </button>

                {!!game.install_path && (
                  <button className="action-menu-item" onClick={() => { onCloseActionMenu(); onOpenFolder() }}>
                    <Folder size={16} />
                    <span>{t('library.card.openFolder')}</span>
                  </button>
                )}

                {updateAvailable && (
                  <button
                    className="action-menu-item"
                    onClick={() => { onCloseActionMenu(); onUpdate() }}
                    disabled={!!updatingGames[game.url] || updateQueue.running}
                  >
                    <Download size={16} />
                    <span>{t('library.card.update')}</span>
                  </button>
                )}

                {canOpenLogs && (
                  <button
                    className="action-menu-item"
                    onClick={() => {
                      onCloseActionMenu()
                      onOpenProtonLog()
                    }}
                  >
                    <FileText size={16} />
                    <span>{t('library.card.openLogs')}</span>
                  </button>
                )}

                <div className="action-menu-sep" />

                <button className="action-menu-item danger" onClick={() => { onCloseActionMenu(); onDelete() }}>
                  <Trash2 size={16} />
                  <span>{t('library.card.uninstall')}</span>
                </button>
              </div>,
              document.body
            )}
          </div>

          <button
            className={"action-btn achievements" + (isAchvComplete ? ' of-achv-complete-btn' : '')}
            onClick={(e) => {
              e.stopPropagation()
              onCloseActionMenu()
              onOpenAchievements()
            }}
            title={isAchvComplete ? t('library.card.achievementsComplete', { unlocked: achievementProgress?.unlocked, total: achievementProgress?.total }) : (achievementProgress?.total ? t('library.card.achievementsProgress', { unlocked: achievementProgress?.unlocked, total: achievementProgress?.total }) : t('library.card.achievements'))}
          >
            <Trophy size={18} className={isAchvComplete ? 'of-achv-complete' : undefined} />
          </button>

          {isLaunching ? (
            <button
              className="action-btn stop"
              onClick={async (e) => {
                e.stopPropagation()
                onStop()
              }}
              disabled={!!updatingGames[game.url]}
              title={t('library.card.stop')}
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              className="action-btn play"
              onClick={(e) => { e.stopPropagation(); if (!updatingGames[game.url] && !isPrefixing) onPlay() }}
              disabled={!!updatingGames[game.url] || isPrefixing}
              style={(updatingGames[game.url] || isPrefixing) ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              title={isPrefixing ? t('library.card.waitingPrefix') : t('library.card.play')}
            >
              {isPrefixing ? <RefreshCw size={18} className="of-spin" /> : <Play size={20} fill="currentColor" />}
            </button>
          )}
        </div>

        <div className="game-info-tooltip">
          <div className="game-title">{game.title}</div>
          <div className="game-version">
            v{game.installed_version || '---'}
            {updateAvailable && <span className="new-version"> → v{game.latest_version}</span>}
          </div>
          {usage && <div className="game-usage">{usage}</div>}
        </div>
      </div>
    </div>
  )
}
