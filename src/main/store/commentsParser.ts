import * as cheerio from 'cheerio'
import type { StoreComment, StoreCommentBlock, StoreCommentSegment } from '../../shared/storeComments'
import { absoluteUrl, cleanText } from './parser'

/**
 * Parser for the comment thread under a game page.
 *
 * The thread is the one part of a guide the site does not write: it is where
 * players say the fix broke on the latest patch, which archive password worked
 * and what to press to host. The native game page quoted the instructions but
 * sent anyone who wanted that to the classic webview.
 *
 * Two shapes of markup arrive here and both parse the same way. The article
 * page carries the first page of comments inline, and DLE's own AJAX endpoint
 * returns the later pages as a fragment of exactly that markup — so the
 * container is found by `.comment[data-comment-id]` rather than by the block it
 * happens to sit in.
 *
 * No Electron imports: this module is plain Node so it can be tested against
 * saved fixtures. URLs come out as the site wrote them; the caller decides
 * which ones need the image proxy. The shapes it produces are in
 * shared/storeComments, because the renderer draws exactly these.
 */

export type StoreCommentsContext = {
  /** DLE's article id, which the AJAX endpoint needs. */
  newsId?: string
  /** Template name, also required by that endpoint. */
  skin?: string
  total?: number
  /**
   * Which page of the thread the markup in hand actually holds. The site opens
   * an article on the *last* page of its comments, not the first, so this is
   * never assumed.
   */
  currentPage?: number
  /** How many pages the thread has, as its own pager states it. */
  pageCount?: number
  /** The form is rendered for accounts that may comment, and for nobody else. */
  canPost: boolean
  /** The page's login token distinguishes a signed-in account from a guest. */
  signedIn: boolean
  /** The name the form would post under. */
  author?: string
}

/** Enough for a long answer, and a cap on what one comment can cost. */
const MAX_BODY_CHARS = 4000
const MAX_BLOCKS = 14
const MAX_SEGMENTS = 60
const MAX_COMMENTS = 60

/** The template's own "no avatar" image says less than showing initials. */
const PLACEHOLDER_AVATAR = /noavatar|no_avatar|nopic/i

const EMOTICON_PATH = /\/emoticons?\//i

/** "Цитата: Name" / "Quote: Name" — the attribution above a quoted block. */
const QUOTE_LABEL = /^(?:цитата|quote)\s*:\s*/i

export function parseComments(html: string, baseUrl: string): StoreComment[] {
  const $ = cheerio.load(html)
  const comments: StoreComment[] = []

  $('.comment[data-comment-id]').each((_index, element) => {
    if (comments.length >= MAX_COMMENTS) return
    const comment = parseComment($, element, baseUrl)
    if (comment) comments.push(comment)
  })

  return comments
}

function parseComment($: cheerio.CheerioAPI, element: any, baseUrl: string): StoreComment | null {
  const el = $(element)
  const id = String(el.attr('data-comment-id') || '').trim()
  if (!id) return null

  const authorLink = el.find('.group.author a, .group a').first()
  const author = cleanText(authorLink.text())
  if (!author) return null

  // The group's colour is inline on a span around the name.
  const colored = authorLink.find('[style*="color"]').first()
  const authorColor = /color\s*:\s*([^;"]+)/i.exec(String(colored.attr('style') || ''))?.[1]?.trim()

  const avatarRaw = el.find('.user-avatar img').first().attr('src')
  const avatarUrl = PLACEHOLDER_AVATAR.test(String(avatarRaw || ''))
    ? undefined
    : absoluteUrl(avatarRaw, baseUrl) || undefined

  const numberLink = el.find('.comment-link a').first()
  const number = Number(/#(\d+)/.exec(cleanText(numberLink.text()))?.[1]) || undefined
  const permalink = absoluteUrl(numberLink.attr('href'), baseUrl) || undefined

  const dateText = cleanText(el.find('.date').first().text())

  // The text sits in a wrapper the template styles; `#comm-id-<id>` is the
  // comment itself, and editing tools live in the wrapper around it.
  const body = el.find(`#comm-id-${id}`).first()
  const bodyRoot = body.length > 0 ? body[0] : el.find('.text.user-comment, .text').first()[0]

  return {
    id,
    author,
    authorUrl: absoluteUrl(authorLink.attr('href'), baseUrl) || undefined,
    authorColor,
    avatarUrl,
    dateText,
    date: parseCommentDate(dateText),
    number,
    permalink,
    body: bodyRoot ? parseCommentBody($, bodyRoot, baseUrl) : []
  }
}

/**
 * The body is BBCode rendered to HTML: prose broken by `<br>`, mentions and
 * links, the site's smileys as images, and quoted replies as a caption element
 * followed by the quoted block.
 *
 * It comes back as blocks of typed segments rather than as HTML, because the
 * renderer shows it inside the launcher: handing it markup written by another
 * site's users would mean trusting that markup with the launcher's own window.
 */
function parseCommentBody($: cheerio.CheerioAPI, root: any, baseUrl: string): StoreCommentBlock[] {
  const blocks: StoreCommentBlock[] = []
  let segments: StoreCommentSegment[] = []
  let text = ''
  let budget = MAX_BODY_CHARS
  let pendingTitle: string | undefined

  const pushText = () => {
    if (text) segments.push({ kind: 'text', text })
    text = ''
  }

  const flush = (kind: StoreCommentBlock['kind'] = 'text', title?: string) => {
    pushText()
    const normalized = normalizeSegments(segments)
    segments = []
    if (normalized.length === 0 && !title) return
    if (blocks.length >= MAX_BLOCKS) return
    blocks.push({ kind, ...(title ? { title } : {}), segments: normalized })
  }

  /** Mentions link to a profile; everything else is a link to show as one. */
  const appendLink = (el: cheerio.Cheerio<any>, base: string) => {
    const label = cleanText(el.text())
    const href = String(el.attr('href') || '')
    const isMention = /\bprofilus\b/.test(String(el.attr('class') || '')) || /\/user\//.test(href)

    if (isMention && label) {
      // The template writes the "@" as plain text before the link.
      text = text.replace(/@[ \t]*$/, '')
      pushText()
      if (segments.length < MAX_SEGMENTS) segments.push({ kind: 'mention', name: label.replace(/^@/, '') })
      return
    }

    const url = resolveLinkUrl(href, base)
    if (!url || !label) {
      text += label
      return
    }

    pushText()
    if (segments.length < MAX_SEGMENTS) segments.push({ kind: 'link', text: label, url })
  }

  const walk = (node: any) => {
    for (const child of node?.children || []) {
      if (budget <= 0) return

      if (child.type === 'text') {
        const value = String(child.data || '')
        text += value
        budget -= value.length
        continue
      }
      if (child.type !== 'tag') continue

      const el = $(child)
      const tag = String(child.name).toLowerCase()
      const classes = String(child.attribs?.class || '')

      if (tag === 'br') {
        text += '\n'
        continue
      }

      // The caption of the quote (or spoiler) that follows it.
      if (/\btitle_quote\b|\btitle_spoiler\b/.test(classes)) {
        pendingTitle = cleanText(el.text()).replace(QUOTE_LABEL, '') || undefined
        continue
      }

      if (/\bquote\b|\btext_spoiler\b/.test(classes)) {
        const kind = /\btext_spoiler\b/.test(classes) ? 'spoiler' : 'quote'
        const title = pendingTitle
        pendingTitle = undefined
        flush()
        walk(child)
        flush(kind, title)
        continue
      }

      if (tag === 'a') {
        appendLink(el, baseUrl)
        continue
      }

      if (tag === 'img') {
        const src = absoluteUrl(el.attr('src') || el.attr('data-src'), baseUrl)
        if (!src) continue
        pushText()
        if (segments.length < MAX_SEGMENTS) {
          segments.push({
            kind: 'image',
            url: src,
            alt: cleanText(el.attr('alt')) || undefined,
            ...(EMOTICON_PATH.test(src) ? { inline: true } : {})
          })
        }
        continue
      }

      if (tag === 'script' || tag === 'style' || tag === 'iframe') continue

      walk(child)
    }
  }

  walk(root)
  flush()

  return blocks
}

/**
 * Whitespace is normalised at the end of a block, not per segment: a link in
 * the middle of a sentence must keep the spaces around it, while the newlines
 * the template leaves between elements must not open the comment with a gap.
 */
function normalizeSegments(segments: StoreCommentSegment[]): StoreCommentSegment[] {
  const cleaned = segments
    .map((segment) =>
      segment.kind === 'text'
        ? { ...segment, text: segment.text.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n') }
        : segment
    )
    .filter((segment) => segment.kind !== 'text' || segment.text.trim().length > 0 || segment.text.includes('\n'))

  const first = cleaned[0]
  if (first?.kind === 'text') cleaned[0] = { ...first, text: first.text.replace(/^\s+/, '') }

  const last = cleaned[cleaned.length - 1]
  if (last?.kind === 'text') cleaned[cleaned.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') }

  return cleaned.filter((segment) => segment.kind !== 'text' || segment.text.length > 0).slice(0, MAX_SEGMENTS)
}

/**
 * Outbound links are wrapped by the site's own redirector, which carries the
 * real target base64-encoded. Unwrapping it means the launcher can show where
 * a link goes before anyone follows it. The other wrapper (`/ext/…`) is
 * encrypted server-side, so that one stays as it is.
 */
function resolveLinkUrl(href: string, baseUrl: string): string | null {
  const url = absoluteUrl(href, baseUrl)
  if (!url) return null

  try {
    const parsed = new URL(url)
    if (!/\/engine\/go\.php$/i.test(parsed.pathname)) return url

    const encoded = parsed.searchParams.get('url')
    if (!encoded) return url

    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    return /^https?:\/\/\S+$/i.test(decoded) ? decoded : url
  } catch {
    return url
  }
}

/** The template's short month names, which is all it writes for older posts. */
const RU_MONTHS: Record<string, number> = {
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6,
  июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12
}

// No \b after the word: JS word boundaries are ASCII, so "Сегодня," — Cyrillic
// followed by a comma — is not a boundary and the label would never match.
const TODAY_LABEL = /^(?:сегодня|today)\s*[,.]?/i
const YESTERDAY_LABEL = /^(?:вчера|yesterday)\s*[,.]?/i
const TIME_PART = /(\d{1,2}):(\d{2})/
const DAY_MONTH_YEAR = /^(\d{1,2})\s+([^\s.,]+)\.?\s+(\d{4})/
const NUMERIC_DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/

/**
 * Comment times are written in the site's own timezone (Moscow) and relative to
 * its own today, which the launcher cannot read from the string: "Вчера, 18:28"
 * is a different moment for a player in São Paulo. Resolving it here, against
 * Moscow's calendar day and with its offset attached, lets the renderer show
 * the reader's local time instead of the site's.
 */
export function parseCommentDate(text: string, now: Date = new Date()): string | undefined {
  const value = cleanText(text)
  if (!value) return undefined

  const time = TIME_PART.exec(value)
  const hours = time ? Number(time[1]) : 0
  const minutes = time ? Number(time[2]) : 0
  if (hours > 23 || minutes > 59) return undefined

  if (TODAY_LABEL.test(value)) return moscowMoment(moscowDay(now, 0), hours, minutes)
  if (YESTERDAY_LABEL.test(value)) return moscowMoment(moscowDay(now, -1), hours, minutes)

  const named = DAY_MONTH_YEAR.exec(value)
  if (named) {
    const month = RU_MONTHS[named[2].toLowerCase().slice(0, 3)]
    if (month) return moscowMoment({ year: Number(named[3]), month, day: Number(named[1]) }, hours, minutes)
  }

  const numeric = NUMERIC_DATE.exec(value)
  if (numeric) {
    return moscowMoment(
      { year: Number(numeric[3]), month: Number(numeric[2]), day: Number(numeric[1]) },
      hours,
      minutes
    )
  }

  return undefined
}

type CalendarDay = { year: number; month: number; day: number }

/** Moscow's calendar day, which is what "today" on the page refers to. */
function moscowDay(now: Date, offsetDays: number): CalendarDay {
  const moment = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000)
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(moment)

  const [year, month, day] = formatted.split('-').map(Number)
  return { year, month, day }
}

function moscowMoment(day: CalendarDay, hours: number, minutes: number): string | undefined {
  const pad = (value: number) => String(value).padStart(2, '0')
  const iso = `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(hours)}:${pad(minutes)}:00+03:00`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** "КОММЕНТАРИЕВ: 12" under the article, which counts the whole thread. */
const TOTAL_LABEL = /(?:комментари\w*|comments?)\s*:\s*(\d+)/i
const SKIN_VARIABLE = /dle_skin\s*=\s*'([\w.-]+)'/
const LOGIN_HASH_VARIABLE = /dle_login_hash\s*=\s*(['"])([^'"]*)\1/

/**
 * Where in the thread this markup sits.
 *
 * DLE writes its comment pager as links that call `CommentsPage('<page>', …)`
 * and leaves the page you are on as a bare `<span>`. That pager is the only
 * thing on the page that says which page it is showing — and it matters,
 * because the site opens an article on the newest page of its thread. Reading
 * it wrong meant asking the endpoint for pages past the end and getting an
 * empty thread back.
 *
 * A thread that fits on one page has no pager at all, which is page one.
 */
function parseNavigation($: cheerio.CheerioAPI): { currentPage?: number; pageCount?: number } {
  const pager = $('.dle-comments-navigation, nav.pagination').first()
  if (pager.length === 0) return {}

  const pages: number[] = []
  pager.find('a[onclick]').each((_index, element) => {
    const page = Number(/CommentsPage\(\s*['"](\d+)['"]/.exec(String($(element).attr('onclick') || ''))?.[1])
    if (Number.isFinite(page)) pages.push(page)
  })

  // The page you are on is the one the pager does not link to.
  let currentPage: number | undefined
  pager.find('span').each((_index, element) => {
    const page = Number(cleanText($(element).text()))
    if (Number.isFinite(page) && page > 0 && currentPage === undefined) currentPage = page
  })

  if (currentPage !== undefined) pages.push(currentPage)
  const pageCount = pages.length > 0 ? Math.max(...pages) : undefined

  return { currentPage, pageCount }
}

/**
 * What the page says about the thread as a whole, and about what this account
 * may do with it. A missing form alone does not mean the account is signed
 * out: the site can omit it for a signed-in account too.
 */
export function parseCommentsContext(html: string): StoreCommentsContext {
  const $ = cheerio.load(html)
  const form = $('#dle-comments-form').first()

  const totalText = cleanText($('.bottom-panel .comments, .comments-count, #dle-comm-link').first().text())
  const total = Number(TOTAL_LABEL.exec(totalText)?.[1] ?? /(\d+)/.exec(totalText)?.[1])

  return {
    newsId: cleanText(form.find('input[name="post_id"]').attr('value') || $('input[name="post_id"]').attr('value')) || undefined,
    skin: SKIN_VARIABLE.exec(html)?.[1],
    total: Number.isFinite(total) ? total : undefined,
    ...parseNavigation($),
    canPost: form.length > 0 && form.find('textarea[name="comments"]').length > 0,
    signedIn: Boolean(LOGIN_HASH_VARIABLE.exec(html)?.[2]),
    author: cleanText(form.find('input[name="name"]').attr('value')) || undefined
  }
}
