const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const archiver = require('archiver')
const { makeSaveBundle, unpackSaveBundle, hasLudusaviMapping } = require('../dist/main/saveBundles.js')

test('Ludusavi archive keeps its mapping.yaml and game ZIP together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-ludusavi-bundle-test-'))
  try {
    const snapshot = path.join(dir, 'snapshot')
    const game = path.join(snapshot, 'Example Game')
    fs.mkdirSync(game, { recursive: true })
    fs.writeFileSync(path.join(game, 'mapping.yaml'), 'name: Example Game\n')
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(path.join(game, 'backup.zip'))
      const archive = archiver('zip')
      output.on('close', resolve)
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.append('save content', { name: 'save.dat' })
      archive.finalize()
    })
    assert.equal(hasLudusaviMapping(snapshot), true)
    const backup = path.join(dir, 'cloud.zip')
    await makeSaveBundle(snapshot, backup, {
      version: 2, format: 'ludusavi-bundle',
      platform: process.platform, gameKey: 'steam_123'
    })
    const recovered = path.join(dir, 'unpacked')
    const manifest = await unpackSaveBundle(backup, recovered)
    assert.equal(manifest.gameKey, 'steam_123')
    assert.equal(hasLudusaviMapping(recovered), true)
    assert.equal(fs.readFileSync(path.join(recovered, 'Example Game', 'mapping.yaml'), 'utf8'), 'name: Example Game\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
