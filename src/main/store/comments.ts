import { STORE_HOME_URL } from '../../shared/allowedHosts'
import type {
  StoreComment,
  StoreCommentBlock,
  StoreCommentPostResult,
  StoreCommentsThread
} from '../../shared/storeComments'
import { invalidateStorePage, requestStoreText } from './catalog'
import { parseComments, parseCommentsContext } from './commentsParser'
import { toStoreImageUrl } from './imageProxy'
import { StoreRequestError } from './requestPolicy'

/**
 * The comment thread of a game page, read and written through the site's own
 * endpoints.
 *
 * The article page carries the newest page of comments. Read it fresh so a
 * cached guest copy cannot hide the form after sign-in. Earlier pages come
 * from DLE's comment endpoint, which returns the same markup as a small
 * fragment instead of the whole article again.
 *
 * Writing goes to the endpoint the site's own form posts to. The launcher never
 * invents a session for that: it posts through the store session, under the
 * name the page itself says this account would post under, and refuses when the
 * page shows no form — which is how the site says this account may not comment.
 */

/** Only a fallback: a thread's own pager is read instead wherever it has one. */
const COMMENTS_PER_PAGE = 20
/** The template's own limit, stated next to its comment box. */
const MAX_COMMENT_LENGTH = 5000
const DEFAULT_SKIN = 'FixLand'

/** DLE article URLs are `/<id>-<slug>.html`, and the id is the thread's key. */
function newsIdFromUrl(url: string): string | undefined {
  return /\/(\d+)-[^/]*\.html$/i.exec(new URL(url, STORE_HOME_URL).pathname)?.[1]
}

/**
 * Avatars and inline images are served by the site, which drops requests that
 * arrive without a referer — the renderer runs from file://, so they have to go
 * through the launcher's image proxy the same way the covers do.
 */
function withProxiedImages(comment: StoreComment): StoreComment {
  const body: StoreCommentBlock[] = comment.body.map((block) => ({
    ...block,
    segments: block.segments.map((segment) =>
      segment.kind === 'image' ? { ...segment, url: toStoreImageUrl(segment.url) || segment.url } : segment
    )
  }))

  return { ...comment, avatarUrl: toStoreImageUrl(comment.avatarUrl), body }
}

function commentsEndpoint(newsId: string, page: number, skin: string): string {
  const url = new URL('/engine/ajax/comments.php', STORE_HOME_URL)
  url.searchParams.set('cstart', String(page))
  url.searchParams.set('news_id', newsId)
  url.searchParams.set('skin', skin)
  return url.toString()
}

/**
 * The endpoint answers with `{"navigation": "…", "comments": "…"}`, and older
 * templates answer with the fragment alone; both are handled so a template
 * change degrades into "no comments on this page" rather than an error.
 */
function commentsMarkupFrom(payload: string): string {
  const text = String(payload || '').trim()
  if (!text.startsWith('{')) return text

  try {
    const parsed = JSON.parse(text) as { comments?: string }
    return String(parsed?.comments || '')
  } catch {
    return text
  }
}

export async function getStoreGameComments(options: {
  url: string
  page?: number
  force?: boolean
}): Promise<StoreCommentsThread> {
  const target = new URL(String(options.url || ''), STORE_HOME_URL).toString()
  const html = await requestStoreText(target, { document: true })
  const context = parseCommentsContext(html)

  // What the article page carries is not page one: the site opens a thread on
  // its newest page, and its own pager says which that is.
  const inlinePage = context.currentPage ?? 1
  const inlineComments = parseComments(html, target)

  const total = context.total ?? inlineComments.length
  const pageCount = Math.max(context.pageCount ?? 1, Math.ceil(total / COMMENTS_PER_PAGE), inlinePage)
  const page = Math.min(Math.max(1, Math.floor(Number(options.page) || inlinePage)), pageCount)

  const newsId = context.newsId || newsIdFromUrl(target)
  const comments = page === inlinePage || !newsId
    ? inlineComments
    : parseComments(
        commentsMarkupFrom(
          await requestStoreText(commentsEndpoint(newsId, page, context.skin || DEFAULT_SKIN), { referer: target })
        ),
        target
      )

  return {
    url: target,
    page,
    pageCount,
    total,
    comments: comments.map(withProxiedImages),
    canPost: context.canPost,
    signedIn: context.signedIn,
    author: context.author
  }
}

/** The site holds a comment for review instead of publishing it. */
const MODERATION_NOTICE = /модератор|проверк|moderat|approv/i

/** Whatever the site chose to say about a comment it would not publish. */
const ALERT_ARGUMENT = /DLE(?:alert|confirm|Push\.\w+)\s*\(\s*(['"])((?:[^\\]|\\.)*?)\1/i

function textFromHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The endpoint answers in the shape its own page expects: the rendered comment
 * when it published, and otherwise a script that pops the reason up in the
 * browser — flood control, a muted account, a thread closed for comments. Both
 * are the site's answer, so the reason is passed through as it was written.
 */
function interpretPostResponse(payload: string, baseUrl: string): StoreCommentPostResult {
  const published = parseComments(payload, baseUrl)
  if (published.length > 0) {
    return { comment: withProxiedImages(published[published.length - 1]) }
  }

  const alert = ALERT_ARGUMENT.exec(payload)?.[2]
  const message = (alert ? textFromHtml(alert) : textFromHtml(payload)).slice(0, 300)

  if (message && MODERATION_NOTICE.test(message)) return { pending: true, notice: message }
  if (message) throw new StoreRequestError('store-comment-rejected', message)

  throw new StoreRequestError('store-comment-failed', 'The site returned no comment and no reason')
}

export async function postStoreGameComment(options: { url: string; text: string }): Promise<StoreCommentPostResult> {
  const target = new URL(String(options.url || ''), STORE_HOME_URL).toString()
  const text = String(options.text || '').trim()

  if (!text) throw new StoreRequestError('store-comment-empty', 'A comment cannot be empty')
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new StoreRequestError('store-comment-too-long', `A comment is limited to ${MAX_COMMENT_LENGTH} characters`)
  }

  const html = await requestStoreText(target, { document: true })
  const context = parseCommentsContext(html)
  const newsId = context.newsId || newsIdFromUrl(target)

  if (!context.canPost || !newsId) {
    const code = context.signedIn ? 'store-comment-unavailable' : 'store-comment-login-required'
    throw new StoreRequestError(code, 'The site does not offer a comment form for this account on that page')
  }

  // The same fields the site's own form sends, including the ones it leaves
  // empty: captcha and subscription are answered by the page, not by us.
  const body = new URLSearchParams({
    post_id: newsId,
    comments: text,
    name: context.author || '',
    mail: '',
    editor_mode: '',
    skin: context.skin || DEFAULT_SKIN,
    sec_code: '',
    question_answer: '',
    recaptcha_response_field: '',
    recaptcha_challenge_field: '',
    allow_subscribe: '0'
  })

  const payload = await requestStoreText(new URL('/engine/ajax/addcomments.php', STORE_HOME_URL).toString(), {
    method: 'POST',
    body: body.toString(),
    referer: target
  })

  // The thread just changed, and the cached copy of the page carries it.
  await invalidateStorePage(target)

  return interpretPostResponse(payload, target)
}
