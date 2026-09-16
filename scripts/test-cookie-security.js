#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')

test('legacy cookies migrate only into the store session and cannot be read for another host', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'void-cookie-security-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const legacyFile = path.join(userData, 'cookies.json')
  fs.writeFileSync(legacyFile, JSON.stringify([
    { name: 'dle_user_id', value: 'user-1', domain: '.online-fix.me', path: '/', secure: true, httpOnly: true },
    { name: 'dle_password', value: 'secret', domain: 'online-fix.me', path: '/', secure: true, httpOnly: true },
    { name: 'foreign', value: 'do-not-import', domain: 'example.com', path: '/', secure: true }
  ]))

  const storeCookies = []
  const removedFromDefault = []
  let clearedStore = false
  const storeSession = {
    cookies: {
      get: async () => storeCookies,
      set: async details => storeCookies.push(details),
      flushStore: async () => {}
    },
    clearStorageData: async () => { clearedStore = true }
  }
  const defaultSession = {
    cookies: {
      get: async () => [
        { name: 'old-store', value: 'x', domain: '.online-fix.me', path: '/', secure: true },
        { name: 'keep-me', value: 'y', domain: 'example.com', path: '/', secure: true }
      ],
      remove: async (url, name) => removedFromDefault.push({ url, name })
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => userData },
        session: {
          defaultSession,
          fromPartition: partition => {
            assert.equal(partition, 'persist:online-fix')
            return storeSession
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  let cookies
  try {
    delete require.cache[require.resolve('../dist/main/cookieManager.js')]
    cookies = require('../dist/main/cookieManager.js')
  } finally {
    Module._load = originalLoad
  }

  await cookies.migrateLegacyCookies()
  assert.deepEqual(storeCookies.map(cookie => cookie.name), ['dle_user_id', 'dle_password'])
  assert.equal(fs.existsSync(legacyFile), false, 'plaintext cookie export is removed after migration')
  assert.match(await cookies.getCookieHeaderForUrl('https://online-fix.me/games/example.html'), /dle_user_id=user-1/)
  await assert.rejects(cookies.getCookieHeaderForUrl('https://example.com/'), /restricted/)
  await assert.rejects(cookies.getCookieHeaderForUrl('http://online-fix.me/'), /restricted/)

  await cookies.clearCookiesAndFile()
  assert.equal(clearedStore, true)
  assert.deepEqual(removedFromDefault.map(entry => entry.name), ['old-store'])
})
