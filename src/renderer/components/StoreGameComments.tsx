import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronUp, Loader2, MessageSquare, RefreshCw, RotateCcw, Send } from 'lucide-react'
import { useI18n } from '../i18n'
import { useToast } from './ToastHost'
import { ipcErrorText } from '../../shared/ipcErrors'
import type {
  StoreComment,
  StoreCommentBlock,
  StoreCommentSegment,
  StoreCommentsThread
} from '../../shared/storeComments'

/** The limit the site's own comment box states. */
const MAX_LENGTH = 5000

const draftKey = (url: string) => `voidlauncher.commentDraft.${url}`

function readDraft(url: string): string {
  try {
    return localStorage.getItem(draftKey(url)) || ''
  } catch {
    return ''
  }
}

/**
 * The comment thread of a game, inside the game page.
 *
 * This is where the players answer what the guide does not: whether the fix
 * still works after last week's patch, what to press to host, which of the
 * mirrors is alive. Until now reading any of it meant leaving for the classic
 * webview, so the native page stopped exactly where the useful part began.
 *
 * The thread opens on its newest page, because that is what a reader came for,
 * and older pages are pulled in above on request — the site orders a thread
 * oldest first and paginates it, so this keeps its order while starting where
 * it matters.
 */
export default function StoreGameComments({ url }: { url: string }) {
  const { t, language } = useI18n()
  const toast = useToast()

  const [thread, setThread] = useState<StoreCommentsThread | null>(null)
  const [comments, setComments] = useState<StoreComment[]>([])
  const [oldestPage, setOldestPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(() => readDraft(url))
  const [posting, setPosting] = useState(false)
  const requestIdRef = useRef(0)

  // Escape closes the dialog from anywhere inside it, this box included, so an
  // unsent comment is kept per game rather than lost to a stray keypress.
  useEffect(() => {
    try {
      if (draft.trim()) localStorage.setItem(draftKey(url), draft)
      else localStorage.removeItem(draftKey(url))
    } catch {
      // A comment is not worth failing over if storage is unavailable.
    }
  }, [draft, url])

  const load = useCallback(
    async (page?: number, options?: { force?: boolean; older?: boolean }) => {
      const requestId = ++requestIdRef.current
      if (options?.older) setLoadingOlder(true)
      else {
        setLoading(true)
        setError(null)
      }

      try {
        const res = await window.electronAPI.storeGameComments(url, page, options?.force)
        if (requestId !== requestIdRef.current) return

        if (!res?.success || !res.thread) {
          setError(ipcErrorText(t, res, t('storeNext.comments.loadFailed')))
          return
        }

        setThread(res.thread)
        setOldestPage(res.thread.page)
        setComments((current) => (options?.older ? [...res.thread!.comments, ...current] : res.thread!.comments))
      } catch (err: any) {
        if (requestId === requestIdRef.current) setError(err?.message || t('storeNext.comments.loadFailed'))
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
          setLoadingOlder(false)
        }
      }
    },
    [t, url]
  )

  useEffect(() => {
    load()
  }, [load])

  const submit = async () => {
    const text = draft.trim()
    if (!text || posting) return

    setPosting(true)
    try {
      const res = await window.electronAPI.storePostComment(url, text)
      if (!res?.success) {
        toast.error(t('storeNext.comments.postFailed'), ipcErrorText(t, res) || undefined)
        return
      }

      setDraft('')
      if (res.pending) toast.info(t('storeNext.comments.pending'), res.notice || undefined)
      else toast.success(t('storeNext.comments.posted'))

      // The thread has grown, which can also mean it has a new last page.
      await load()
    } catch (err: any) {
      toast.error(t('storeNext.comments.postFailed'), err?.message || undefined)
    } finally {
      setPosting(false)
    }
  }

  const remaining = MAX_LENGTH - draft.length

  return (
    <div className="store-next-comments">
      <div className="store-next-comments-heading">
        <div>
          <h4 className="store-next-section-title">{t('storeNext.comments.title')}</h4>
          <p>
            {thread
              ? t('storeNext.comments.count', { count: thread.total })
              : t('storeNext.comments.hint')}
            {thread && thread.pageCount > 1 && (
              <> · {t('storeNext.comments.page', { page: thread.page, pages: thread.pageCount })}</>
            )}
          </p>
        </div>
        <button
          className="settings-btn secondary sm"
          onClick={() => load(undefined, { force: true })}
          disabled={loading || loadingOlder || posting}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {t('storeNext.refresh')}
        </button>
      </div>

      {loading && comments.length === 0 && (
        <div className="store-next-detail-loading" role="status">
          <Loader2 size={16} className="of-spin" aria-hidden="true" />
          {t('storeNext.comments.loading')}
        </div>
      )}

      {error && (
        <div className="store-next-notice error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
          <button className="settings-btn secondary sm" onClick={() => load(undefined, { force: true })}>
            <RotateCcw size={13} aria-hidden="true" />
            {t('storeNext.retry')}
          </button>
        </div>
      )}

      {oldestPage > 1 && (
        <button
          className="settings-btn ghost sm store-next-comments-older"
          onClick={() => load(oldestPage - 1, { older: true })}
          disabled={loadingOlder}
        >
          {loadingOlder
            ? <Loader2 size={13} className="of-spin" aria-hidden="true" />
            : <ChevronUp size={13} aria-hidden="true" />}
          {t('storeNext.comments.loadOlder')}
        </button>
      )}

      {comments.length > 0 ? (
        <ol className="store-next-comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="store-next-comment">
              <CommentAvatar comment={comment} />
              <div className="store-next-comment-main">
                <div className="store-next-comment-meta">
                  <span className="store-next-comment-author" style={comment.authorColor ? { color: comment.authorColor } : undefined}>
                    {comment.author}
                  </span>
                  <CommentDate comment={comment} language={language} />
                  {comment.number ? <span className="store-next-comment-number">#{comment.number}</span> : null}
                </div>
                <CommentBody blocks={comment.body} emptyLabel={t('storeNext.comments.empty')} spoilerLabel={t('storeNext.comments.spoiler')} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        !loading && !error && <p className="store-next-detail-description">{t('storeNext.comments.none')}</p>
      )}

      {thread && (thread.canPost ? (
        <div className="store-next-comment-form">
          <label className="store-next-comment-label" htmlFor="store-next-comment-input">
            {thread.author
              ? t('storeNext.comments.composeAs', { name: thread.author })
              : t('storeNext.comments.compose')}
          </label>
          <textarea
            id="store-next-comment-input"
            value={draft}
            maxLength={MAX_LENGTH}
            rows={4}
            placeholder={t('storeNext.comments.placeholder')}
            disabled={posting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="store-next-comment-actions">
            <span className="store-next-source">{t('storeNext.comments.submitHint', { remaining })}</span>
            <button className="settings-btn primary sm" onClick={submit} disabled={posting || draft.trim().length === 0}>
              {posting
                ? <Loader2 size={14} className="of-spin" aria-hidden="true" />
                : <Send size={14} aria-hidden="true" />}
              {posting ? t('storeNext.comments.posting') : t('storeNext.comments.submit')}
            </button>
          </div>
        </div>
      ) : (
        <div className="store-next-notice" role="note">
          <MessageSquare size={15} aria-hidden="true" />
          <span>{t(thread.signedIn ? 'storeNext.comments.unavailable' : 'storeNext.comments.signIn')}</span>
        </div>
      ))}
    </div>
  )
}

/** The site's default avatar says nothing, so initials stand in for it. */
function CommentAvatar({ comment }: { comment: StoreComment }) {
  const [broken, setBroken] = useState(false)

  if (comment.avatarUrl && !broken) {
    return (
      <img
        className="store-next-comment-avatar"
        src={comment.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    )
  }

  return (
    <span className="store-next-comment-avatar placeholder" aria-hidden="true">
      {comment.author.slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * The site writes its times in Moscow time and against its own "today"; the
 * main process resolves that to a real moment, which is what makes it possible
 * to show it here in the reader's locale. When it could not be resolved, the
 * site's own wording is shown rather than a guess.
 */
function CommentDate({ comment, language }: { comment: StoreComment; language: string }) {
  if (!comment.date) return <span className="store-next-comment-date">{comment.dateText}</span>

  const label = new Date(comment.date).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <time className="store-next-comment-date" dateTime={comment.date} title={comment.dateText}>
      {label}
    </time>
  )
}

/**
 * A comment as typed blocks, never as markup. Quotes keep their attribution,
 * spoilers stay closed until asked for, and a link shows where it goes and
 * opens in the browser — nothing here navigates the launcher.
 */
function CommentBody({
  blocks,
  emptyLabel,
  spoilerLabel
}: {
  blocks: StoreCommentBlock[]
  emptyLabel: string
  spoilerLabel: string
}) {
  if (blocks.length === 0) return <p className="store-next-comment-text muted">{emptyLabel}</p>

  return (
    <>
      {blocks.map((block, index) => {
        const content = block.segments.map((segment, position) => <Segment key={position} segment={segment} />)

        if (block.kind === 'quote') {
          return (
            <blockquote key={index} className="store-next-comment-quote">
              {block.title && <cite>{block.title}</cite>}
              <p className="store-next-comment-text">{content}</p>
            </blockquote>
          )
        }

        if (block.kind === 'spoiler') {
          return (
            <details key={index} className="store-next-comment-spoiler">
              <summary>{block.title || spoilerLabel}</summary>
              <p className="store-next-comment-text">{content}</p>
            </details>
          )
        }

        return (
          <p key={index} className="store-next-comment-text">
            {content}
          </p>
        )
      })}
    </>
  )
}

function Segment({ segment }: { segment: StoreCommentSegment }) {
  if (segment.kind === 'text') return <>{segment.text}</>

  if (segment.kind === 'mention') return <span className="store-next-comment-mention">@{segment.name}</span>

  if (segment.kind === 'image') {
    return (
      <img
        className={segment.inline ? 'store-next-comment-emoji' : 'store-next-comment-image'}
        src={segment.url}
        alt={segment.alt || ''}
        loading="lazy"
        decoding="async"
      />
    )
  }

  return (
    <a
      className="store-next-comment-link"
      href={segment.url}
      title={segment.url}
      onClick={(event) => {
        event.preventDefault()
        window.electronAPI.openExternal(segment.url)
      }}
    >
      {segment.text}
    </a>
  )
}
