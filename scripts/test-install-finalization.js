const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isValidFinalizedInstall } = require('../dist/main/installFinalization.js')

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-install-test-'))
  try {
    const marker = path.join(dir, '.of_game.json')
    fs.writeFileSync(marker, JSON.stringify({
      url: 'game://alpha', status: 'installed', downloadId: 42, installPath: dir
    }))
    fs.writeFileSync(path.join(dir, 'game.exe'), 'test-executable')
    const verify = (overrides = {}) => isValidFinalizedInstall({
      downloadId: 42, gameUrl: 'game://alpha', installDir: dir,
      hasPayload: true, hasExecutable: true, requireWindowsExecutable: true,
      ...overrides
    })
    fn({ dir, marker, verify })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('only the current download may finalize an installed game', () => fixture(({ verify }) => {
  assert.equal(verify(), true)
  assert.equal(verify({ downloadId: 41 }), false)
  assert.equal(verify({ gameUrl: 'game://beta' }), false)
}))

test('active extraction locks prohibit declaring success', () => fixture(({ dir, verify }) => {
  for (const lock of ['.of_extracting.json', '.of_update_extracting.json', '.extracting']) {
    fs.writeFileSync(path.join(dir, lock), 'locked')
    assert.equal(verify(), false)
    fs.unlinkSync(path.join(dir, lock))
  }
  assert.equal(verify(), true)
}))

test('unverified payloads and missing Windows EXE never count as installed', () => fixture(({ verify }) => {
  assert.equal(verify({ hasPayload: false }), false)
  assert.equal(verify({ hasExecutable: false }), false)
  assert.equal(verify({ hasExecutable: false, requireWindowsExecutable: false }), true)
}))

test('legacy or malformed completion markers never finalize a new download', () => fixture(({ marker, verify }) => {
  fs.writeFileSync(marker, JSON.stringify({ status: 'installed', url: 'game://alpha' }))
  assert.equal(verify(), false)
  fs.writeFileSync(marker, '{broken')
  assert.equal(verify(), false)
  fs.unlinkSync(marker)
  assert.equal(verify(), false)
}))
