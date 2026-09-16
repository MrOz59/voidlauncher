/**
 * Shape of a comment thread as it crosses the IPC boundary.
 *
 * Lives in shared because three places need the same answer: the parser that
 * reads the site's markup, the handler that hands the result to the renderer,
 * and the game page that draws it. A comment arrives as typed blocks rather
 * than as HTML — it is text written by strangers on another site, and the
 * renderer draws it inside the launcher's own window.
 */

export type StoreCommentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string }
  /** "@name", which the site writes as a link to that profile. */
  | { kind: 'mention'; name: string }
  /** `inline` marks the site's smileys, which are text-sized, not pictures. */
  | { kind: 'image'; url: string; alt?: string; inline?: boolean }

export type StoreCommentBlock = {
  kind: 'text' | 'quote' | 'spoiler'
  /** Who is being quoted, or the spoiler's own caption. */
  title?: string
  segments: StoreCommentSegment[]
}

export type StoreComment = {
  id: string
  author: string
  authorUrl?: string
  /** Staff and donors are coloured by their group; the name alone loses that. */
  authorColor?: string
  avatarUrl?: string
  /** The site's own wording, always present ("Вчера, 18:28"). */
  dateText: string
  /** The same moment as an ISO string when it could be read. */
  date?: string
  /** Position in the whole thread, as the site numbers it (#1, #21, …). */
  number?: number
  permalink?: string
  body: StoreCommentBlock[]
}

export type StoreCommentsThread = {
  url: string
  page: number
  pageCount: number
  total: number
  /** Oldest first, exactly as the site orders a thread. */
  comments: StoreComment[]
  /** Whether this account may post, which is the page's answer, not a guess. */
  canPost: boolean
  /** Whether the page recognises the account as signed in. */
  signedIn: boolean
  /** The name a comment would be posted under. */
  author?: string
}

export type StoreCommentPostResult = {
  /** The comment as the site rendered it back, when it published immediately. */
  comment?: StoreComment
  /** The site accepted it but holds it for a moderator. */
  pending?: boolean
  /** The site's own wording for that, worth showing verbatim. */
  notice?: string
}
