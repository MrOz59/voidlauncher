#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')

const GAME_URL = 'https://online-fix.me/games/adventures/18237-tainted-grail-the-fall-of-avalon-po-seti.html'
const signedInHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'game-comments.html'), 'utf8')
const noFormHtml = signedInHtml.replace(/<form[^>]*id="dle-comments-form"[\s\S]*?<\/form>/, '')
const guestHtml = noFormHtml.replace(/(dle_login_hash\s*=\s*')[^']*'/, "$1'")

test('comments use the signed-in session and ignore a cached guest page', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'of-store-comments-'))
  const requests = []
  let pageHtml = guestHtml

  const storeSession = {
    cookies: { get: async () => [
      { name: 'dle_user_id', value: 'test-user' },
      { name: 'dle_password', value: 'test-password' }
    ] },
    fetch: async (url, init) => {
      requests.push({ url, init })
      const body = url.includes('/engine/ajax/addcomments.php') ? signedInHtml : pageHtml
      const bytes = Buffer.from(body)
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => userData },
        session: { fromPartition: () => storeSession }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  let catalog
  let comments
  try {
    catalog = require('../dist/main/store/catalog.js')
    comments = require('../dist/main/store/comments.js')
  } finally {
    Module._load = originalLoad
  }

  try {
    await catalog.fetchStoreHtml(GAME_URL)
    pageHtml = signedInHtml

    const thread = await comments.getStoreGameComments({ url: GAME_URL })
    assert.equal(thread.canPost, true)
    assert.equal(thread.signedIn, true)
    assert.equal(thread.author, 'MrOz')
    assert.equal(requests.length, 2, 'the thread makes a fresh request despite the cached page')
    assert.equal(requests[0].init.credentials, 'include')
    assert.equal(requests[1].init.credentials, 'include')
    assert.equal(requests[1].init.cache, 'no-store')
    assert.equal(requests[1].init.headers['X-Requested-With'], undefined)

    const result = await comments.postStoreGameComment({ url: GAME_URL, text: 'Works for me' })
    assert.ok(result.comment)
    assert.equal(requests.length, 4)
    assert.equal(requests[2].init.credentials, 'include')
    assert.equal(requests[3].init.credentials, 'include')
    assert.equal(requests[3].init.method, 'POST')
    assert.equal(new URLSearchParams(requests[3].init.body).get('comments'), 'Works for me')

    pageHtml = noFormHtml
    const unavailable = await comments.getStoreGameComments({ url: GAME_URL })
    assert.equal(unavailable.signedIn, true)
    assert.equal(unavailable.canPost, false)
    await assert.rejects(
      comments.postStoreGameComment({ url: GAME_URL, text: 'Should not send' }),
      { code: 'store-comment-unavailable' }
    )
    assert.equal(requests.length, 6, 'no POST is sent when the site omits the form')
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
