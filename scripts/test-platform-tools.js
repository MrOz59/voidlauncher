const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const legendaryEntry = entry => typeof entry === 'string'
  ? entry.includes('vendor/legendary')
  : String(entry?.from || '').replace(/\\/g, '/') === 'vendor/legendary'

test('Windows distribution does not download Legendary', () => {
  assert.doesNotMatch(manifest.scripts['dist:win'], /fetch:legendary|fetch-legendary/i)
  assert.match(manifest.scripts['dist:win'], /fetch:ludusavi/)
})

test('Windows packaging cannot include a previously vendored Legendary binary', () => {
  assert.equal((manifest.build.extraResources || []).some(legendaryEntry), false,
    'Legendary must not be a cross-platform extraResource')
  assert.equal((manifest.build.win?.extraResources || []).some(legendaryEntry), false,
    'Windows resources must not contain Legendary')
})

test('Linux and macOS retain existing Legendary/EOS support', () => {
  assert.equal((manifest.build.linux?.extraResources || []).some(legendaryEntry), true)
  assert.equal((manifest.build.mac?.extraResources || []).some(legendaryEntry), true)
  assert.match(manifest.scripts['dist:linux'], /fetch:legendary/)
  assert.match(manifest.scripts['dist:appimage'], /fetch:legendary/)
  assert.match(manifest.scripts['dist:rpm'], /fetch:legendary/)
  assert.match(manifest.scripts['dist:pacman'], /fetch:legendary/)
})
