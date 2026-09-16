#!/usr/bin/env node
/**
 * Parser checks for the new store, run against saved fixtures.
 * Capture real pages with `npm run store:capture` inside the app and drop them
 * in scripts/fixtures to catch template changes here instead of in production.
 */
const fs = require('fs')
const path = require('path')
const { parseListing, parseGamePage } = require('../dist/main/store/parser.js')
const { parseComments, parseCommentsContext, parseCommentDate } = require('../dist/main/store/commentsParser.js')
const { mapRequirements, parseRequirements } = require('../dist/main/store/requirements.js')

const BASE = 'https://online-fix.me/'
let failures = 0

function check(condition, label, detail) {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}`)
  if (!condition) {
    failures++
    if (detail !== undefined) console.log('        got:', JSON.stringify(detail))
  }
}

const listingHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-listing.html'), 'utf8')
const listing = parseListing(listingHtml, BASE)
const byId = Object.fromEntries(listing.items.map((item) => [item.id, item]))

console.log('listing')
check(listing.items.length === 3, 'finds the three catalogue entries', listing.items.map((i) => i.id))
check(!byId['1111'], 'ignores links inside comments')
check(!byId['9999'], 'ignores links inside the menu')
check(byId['1234']?.title === 'Nome Do Jogo', 'reads the title', byId['1234']?.title)
check(
  byId['1234']?.imageUrl === 'https://online-fix.me/uploads/posts/2026-01/1234.jpg',
  'prefers the lazy-loaded cover over the data: placeholder',
  byId['1234']?.imageUrl
)
check(byId['1234']?.publishedAt === '12 января 2026', 'reads the listing date', byId['1234']?.publishedAt)
check(
  byId['5678']?.title === 'Outro Jogo Com Titulo Longo',
  'merges the cover and title links, keeping the fuller title',
  byId['5678']?.title
)
check(byId['5678']?.publishedAt?.startsWith('2026-02-03'), 'reads <time datetime>', byId['5678']?.publishedAt)
check(byId['4242'] && !byId['4242'].imageUrl, 'keeps entries without a cover', byId['4242'])
check(listing.nextPageUrl === 'https://online-fix.me/page/2/', 'finds the next page', listing.nextPageUrl)

console.log('\nlisting captured from the real store')
const realHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'listing-real.html'), 'utf8')
const real = parseListing(realHtml, 'https://online-fix.me/')

check(real.items.length === 3, 'reads the three captured cards', real.items.length)
check(
  real.items.every((item) => item.title && !/\d{4}/.test(item.title)),
  'titles come from the heading, with no date glued to them',
  real.items.map((i) => i.title)
)
check(real.items.every((item) => item.imageUrl && !item.imageUrl.startsWith('data:')), 'covers come from the lazy-loaded attribute')
check(real.items.every((item) => item.publishedAt), 'every card has a date', real.items.map((i) => i.publishedAt))
check(
  real.items.every((item) => !/\d{6,}/.test(item.publishedAt || '')),
  'the view/comment counters are not mistaken for the date',
  real.items.map((i) => i.publishedAt)
)
check(real.items.some((item) => item.updatedAt), 'picks up the "updated" line when present')
check(real.nextPageUrl === 'https://online-fix.me/page/2/', 'finds the next page', real.nextPageUrl)

console.log('\ngame page')
const gameHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-game-page.html'), 'utf8')
const details = parseGamePage(gameHtml, 'https://online-fix.me/1234-nome-do-jogo.html')
check(details.version === '1.0.266', 'reads the version from the labelled line', details.version)
check(details.title === 'Test Game', 'reads the title', details.title)

console.log('\ngame page captured from the real store')
const realGame = parseGamePage(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'game-real.html'), 'utf8'),
  'https://online-fix.me/games/officialservers/18211-aliens-fireteam-elite-2-po-seti.html'
)

check(realGame.version === '1.0.0', 'version stops before the next word', realGame.version)
check(realGame.releaseDate === '25.08.2026', 'reads the release date', realGame.releaseDate)
check(
  (realGame.torrentUrl || '').includes('/torrents/'),
  'finds the torrent the download flow can use',
  realGame.torrentUrl
)
check(
  (realGame.directUrl || '').includes('/uploads/') && !(realGame.directUrl || '').includes('/torrents/'),
  'keeps the direct file separate from the torrent',
  realGame.directUrl
)
check((realGame.videoUrl || '').includes('KG55MXH8cME'), 'finds the trailer', realGame.videoUrl)

console.log('\nversion written as a build number')
const buildVersion = parseGamePage(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'game-build-version.html'), 'utf8'),
  'https://online-fix.me/games/officialservers/18224-wheelmates-po-seti.html'
)

check(buildVersion.version === 'Build 02092026', 'reads a version that is not a number', buildVersion.version)
check(buildVersion.releaseDate === '01.09.2026', 'the release date is not read as the version', buildVersion.releaseDate)
check(buildVersion.launchExecutable === 'LyraGame.exe', 'still reads the binary the steps name', buildVersion.launchExecutable)

const versionPage = (line) =>
  `<!doctype html><html><body><div id="dle-content"><article><h1>Jogo</h1>` +
  `<div class="full-story-content"><div itemprop="articleBody">${line}` +
  `<a href="https://uploads.online-fix.me:2053/torrents/X/">Скачать Torrent</a></div></div>` +
  `</article></div></body></html>`

const versionOf = (line) => parseGamePage(versionPage(line), 'https://online-fix.me/1-x.html').version

check(versionOf('<b>Game version: 1.0.0.69333</b>') === '1.0.0.69333', 'reads the English label', versionOf('<b>Game version: 1.0.0.69333</b>'))
check(versionOf('<b>Версия игры:</b>1.0.266') === '1.0.266', 'reads a value glued to the label', versionOf('<b>Версия игры:</b>1.0.266'))
check(versionOf('<b>Версия игры: v1.2.3-beta</b>') === 'v1.2.3-beta', 'keeps a prefixed, suffixed version', versionOf('<b>Версия игры: v1.2.3-beta</b>'))
check(versionOf('<b>Игра через:</b> Steam') === undefined, 'no labelled version means none', versionOf('<b>Игра через:</b> Steam'))
check(versionOf('<b>Версия игры:</b> уточняется') === undefined, 'prose after the label is not a version', versionOf('<b>Версия игры:</b> уточняется'))

console.log('\nretired game page')
const closed = parseGamePage(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'game-closed.html'), 'utf8'),
  'https://online-fix.me/games/officialservers/18232-halloween-the-game-online.html'
)

check(
  /Руководство закрыто/.test(closed.unavailableNotice || ''),
  'reads the notice that the guide was closed',
  closed.unavailableNotice
)
check(
  (closed.torrentUrl || '').includes('/torrents/'),
  'the download buttons are still on the page, which is why the notice matters',
  closed.torrentUrl
)
check(
  !(closed.instructions || []).some((line) => /закрыт|покупайте/i.test(line)),
  'the notice is not read back as a step',
  closed.instructions
)
check(realGame.unavailableNotice === undefined, 'a live page carries no notice', realGame.unavailableNotice)
check(closed.version === '1.0.0.69333', 'reads the version through the English label', closed.version)
check(closed.releaseDate === '08.09.2026', 'reads the date behind the "Game release" label', closed.releaseDate)

const editedPage = (reason, body) =>
  `<!doctype html><html><body><div id="dle-content"><article><h1>Jogo</h1>` +
  `<div class="lightedited"><div class="edited-block">Обновлено: Вчера, 13:22. Причина: ${reason}</div></div>` +
  `<div class="full-story-content"><div itemprop="articleBody">${body}</div></div>` +
  `</article></div></body></html>`

const noticeOf = (reason, body) =>
  parseGamePage(editedPage(reason, body), 'https://online-fix.me/1-x.html').unavailableNotice

check(
  noticeOf('Обновлено до версии 1.2', 'Запускаем игру через Game.exe.') === undefined,
  'an ordinary edit reason is not a closure',
  noticeOf('Обновлено до версии 1.2', 'Запускаем игру через Game.exe.')
)
check(
  noticeOf('Обновлено до версии 1.2', 'Тема закрыта, играйте в другие игры.') === 'Тема закрыта, играйте в другие игры.',
  'the body notice is found even when the edit reason says nothing',
  noticeOf('Обновлено до версии 1.2', 'Тема закрыта, играйте в другие игры.')
)
check(
  noticeOf('The guide is closed, buy the game.', 'Launch the game using Game.exe.') === 'The guide is closed, buy the game.',
  'reads the English wording from the edit reason',
  noticeOf('The guide is closed, buy the game.', 'Launch the game using Game.exe.')
)

console.log('\ngame page instructions')
const withSteps = parseGamePage(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'game-instructions.html'), 'utf8'),
  'https://online-fix.me/games/officialservers/1234-nome-do-jogo.html'
)
const steps = withSteps.instructions || []

check(steps[0] === '1. Запускаем Steam, заходим в свой профиль.', 'starts at the launch section, not at the top of the block', steps[0])
check(
  !steps.some((line) => /Пароль един|Смотри FAQ|Скачать|Страница игры/i.test(line)),
  'drops the archive password, the Steam line and the download buttons',
  steps
)
check(!steps.some((line) => /Версия игры/i.test(line)), 'drops the labelled metadata', steps)
check(steps.includes('Подключение:') && steps.includes('Создание сервера:'), 'keeps the short sub-headings', steps)
check(
  steps.some((line) => /Говорим другу/.test(line)),
  'reaches the last step instead of running out of budget',
  steps
)
check(!steps.some((line) => /КООП|МУЛЬТИПЛЕЕР|сетевых режимах/i.test(line)), 'leaves out the network-modes block', steps)
check(!steps.some((line) => /(.{4,})\1/.test(line)), 'no line repeats itself', steps)
check(steps.some((line) => /официальных серверах/.test(line)), 'keeps the notes that follow the modes block', steps)

console.log('\nlaunch executable named by the steps')
const stepsPage = (lines) =>
  `<!doctype html><html><body><div id="dle-content"><article><h1>Jogo</h1>` +
  `<div class="full-story-content"><div>Как запускать:</div>` +
  lines.map((line) => `<div>${line}</div>`).join('') +
  `</div></article></div></body></html>`

const launchExeOf = (lines) => parseGamePage(stepsPage(lines), 'https://online-fix.me/1-x.html').launchExecutable

check(withSteps.launchExecutable === 'ExemploGame.exe', 'reads the binary the steps name', withSteps.launchExecutable)
check(
  launchExeOf(['Не запускайте Cheat.exe перед стартом игры.']) === undefined,
  'ignores a binary the steps warn against',
  launchExeOf(['Не запускайте Cheat.exe перед стартом игры.'])
)
check(
  launchExeOf(['Запускаем setup.exe для установки.', 'Запускаем игру через RealGame.exe.']) === 'RealGame.exe',
  'skips the installer and takes the game binary',
  launchExeOf(['Запускаем setup.exe для установки.', 'Запускаем игру через RealGame.exe.'])
)
check(
  launchExeOf(['Запускаем игру через "My Game.exe" и играем.']) === 'My Game.exe',
  'a quoted name may carry spaces',
  launchExeOf(['Запускаем игру через "My Game.exe" и играем.'])
)
check(
  launchExeOf(['Запускаем Steam, заходим в свой профиль.']) === undefined,
  'no binary named means no hint',
  launchExeOf(['Запускаем Steam, заходим в свой профиль.'])
)

console.log('\ncomment thread captured from a real game page')
const commentsHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'game-comments.html'), 'utf8')
const GAME_URL = 'https://online-fix.me/games/adventures/18237-tainted-grail-the-fall-of-avalon-po-seti.html'
const thread = parseComments(commentsHtml, GAME_URL)
const context = parseCommentsContext(commentsHtml)
const [first, second, third] = thread

check(thread.length === 3, 'reads every comment in the thread', thread.length)
check(first?.author === 'FeldOtto55', 'reads the author', first?.author)
check(first?.number === 21, 'keeps the number the site gave it', first?.number)
check(
  first?.permalink === `${GAME_URL.replace('18237-', 'page,1,1,18237-')}#comment-id-407695`,
  'keeps the link to the comment',
  first?.permalink
)
check(first?.avatarUrl === undefined, 'the template default avatar is not an avatar', first?.avatarUrl)
check(
  first?.body[0]?.segments[0]?.text === 'Do you need to download the modification for it as well,\nor is that included in the torrent already?',
  'a <br> is a line break inside the comment, not two comments',
  first?.body[0]?.segments[0]
)

check(second?.authorColor === '#843232', 'keeps the colour of the author group', second?.authorColor)
check(second?.avatarUrl === 'https://online-fix.me/uploads/fotos/foto_1561717.png', 'reads a real avatar', second?.avatarUrl)

const secondSegments = second?.body[0]?.segments || []
check(
  secondSegments[0]?.kind === 'mention' && secondSegments[0]?.name === 'FeldOtto55',
  'the answer button writes a mention, not an "@" and a link',
  secondSegments[0]
)
check(
  secondSegments.some((segment) => segment.kind === 'link' && segment.url === 'https://example.com/patchnotes'),
  'an outbound link is unwrapped from the site redirector',
  secondSegments.filter((segment) => segment.kind === 'link')
)
check(
  secondSegments.some((segment) => segment.kind === 'image' && segment.inline === true),
  'a smiley stays an inline image',
  secondSegments.filter((segment) => segment.kind === 'image')
)

check(third?.body[0]?.kind === 'quote', 'a quoted reply comes back as a quote block', third?.body.map((block) => block.kind))
check(third?.body[0]?.title === 'FeldOtto55', 'the quote keeps its attribution', third?.body[0]?.title)
check(
  third?.body[1]?.kind === 'text' && /font looks weird/.test(third?.body[1]?.segments[0]?.text || ''),
  'the answer under the quote is its own block',
  third?.body[1]
)

check(context.total === 23, 'reads how many comments the thread has', context.total)
check(context.currentPage === 2, 'the page the site served is the one its pager marks', context.currentPage)
check(context.pageCount === 2, 'reads how many pages the thread has', context.pageCount)
check(first?.number === 21, 'so the comments on it are not numbered from one', first?.number)
check(context.newsId === '18237', 'reads the article id the comment endpoint needs', context.newsId)
check(context.skin === 'FixLand', 'reads the template name that endpoint needs', context.skin)
check(context.canPost === true, 'the form on the page means this account may post', context.canPost)
check(context.signedIn === true, 'the page recognises the signed-in account', context.signedIn)
check(context.author === 'MrOz', 'reads the name a comment would be posted under', context.author)

// What a signed-out reader gets: the same thread, and no form anywhere on it.
const noFormHtml = commentsHtml.replace(/<form[^>]*id="dle-comments-form"[\s\S]*?<\/form>/, '')
const guestHtml = noFormHtml.replace(/(dle_login_hash\s*=\s*')[^']*'/, "$1'")
const guestContext = parseCommentsContext(guestHtml)
check(parseComments(guestHtml, GAME_URL).length === 3, 'a signed-out reader still gets the thread')
check(guestContext.canPost === false, 'no form means this account may not post', guestContext.canPost)
check(guestContext.signedIn === false, 'an empty login token identifies a guest', guestContext.signedIn)
const noFormContext = parseCommentsContext(noFormHtml)
check(noFormContext.canPost === false && noFormContext.signedIn === true,
  'a signed-in account can also receive no comment form', noFormContext)

// A thread that fits on one page has no pager, and that page is the first one.
const onePage = parseCommentsContext(commentsHtml.replace(/<nav class="pagination[\s\S]*?<\/nav>/, ''))
check(onePage.currentPage === undefined, 'no pager means nothing to say about pages', onePage.currentPage)

console.log('\ncomment times')
const NOW = new Date('2026-09-11T09:00:00Z')
check(parseCommentDate('Вчера, 18:28', NOW) === '2026-09-10T15:28:00.000Z', 'yesterday, in the site\'s own timezone', parseCommentDate('Вчера, 18:28', NOW))
check(parseCommentDate('Сегодня, 07:13', NOW) === '2026-09-11T04:13:00.000Z', 'today, in the site\'s own timezone', parseCommentDate('Сегодня, 07:13', NOW))
check(parseCommentDate('10 сен 2026, 23:43', NOW) === '2026-09-10T20:43:00.000Z', 'a dated post with a Russian month name', parseCommentDate('10 сен 2026, 23:43', NOW))
check(parseCommentDate('какая-то ерунда', NOW) === undefined, 'an unreadable date is left to the site\'s own wording', parseCommentDate('какая-то ерунда', NOW))

console.log('\nsystem requirements, from a saved Steam payload')
const steam = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'steam-requirements.json'), 'utf8'))
const requirements = mapRequirements(steam)
const minimum = requirements?.minimum || []
const labelled = Object.fromEntries(minimum.filter((row) => row.label).map((row) => [row.label, row.value]))

check(minimum.length === 8, 'reads every line of the minimum block', minimum.length)
check(labelled['Processor'] === 'i5 8th gen or AMD equivalent', 'splits a row into its label and its value', labelled['Processor'])
check(labelled['Memory'] === '12 GB RAM', 'reads the memory row', labelled['Memory'])
check(
  minimum.some((row) => !row.label && /64-bit processor/.test(row.value)),
  'a line the publisher wrote without a label is kept as a note',
  minimum.filter((row) => !row.label)
)
check(
  !minimum.some((row) => /^Minimum$/i.test(row.label || '')),
  'the heading above the list is not a row',
  minimum[0]
)
check(
  requirements?.recommended?.some((row) => row.label === 'Graphics' && row.value === 'RTX 2070 Super'),
  'reads the recommended block as well',
  requirements?.recommended
)
check(parseRequirements(steam.mac_requirements.minimum) === undefined, 'an empty list is no requirements at all', parseRequirements(steam.mac_requirements.minimum))
check(parseRequirements(undefined) === undefined, 'a game with no block at all is handled')
check(
  parseRequirements(steam.prose_requirements.minimum)?.length === 3,
  'an entry written as prose instead of a list still reads back',
  parseRequirements(steam.prose_requirements.minimum)
)

console.log(failures === 0 ? '\nall parser checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
