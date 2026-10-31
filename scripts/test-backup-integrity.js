const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const archiver = require('archiver')
const { isValidBackupZip, safeRemoteZipFilename } = require('../dist/main/backupIntegrity.js')

async function withArchive(hasEntry, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-save-test-'))
  const file = path.join(dir, 'backup.zip')
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file)
      const archive = archiver('zip', { zlib: { level: 1 } })
      out.on('close', resolve)
      out.on('error', reject)
      archive.on('error', reject)
      archive.pipe(out)
      if (hasEntry) archive.append('save state', { name: 'save/game.sav' })
      archive.finalize()
    })
    await callback(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('valid populated ZIP is acceptable for upload', async () => {
  await withArchive(true, file => assert.equal(isValidBackupZip(file), true))
})

test('empty ZIP must not replace a valid cloud backup', async () => {
  await withArchive(false, file => assert.equal(isValidBackupZip(file), false))
})

test('truncated or non-ZIP files must not be uploaded or restored', async () => {
  await withArchive(true, file => {
    const original = fs.readFileSync(file)
    fs.writeFileSync(file, original.subarray(0, Math.max(0, original.length - 22)))
    assert.equal(isValidBackupZip(file), false)
    fs.writeFileSync(file, '<html>Download failed</html>')
    assert.equal(isValidBackupZip(file), false)
  })
})

test('remote names cannot escape local save directories', () => {
  assert.equal(safeRemoteZipFilename('ludusavi_123.zip'), 'ludusavi_123.zip')
  for (const bad of ['../evil.zip', '..\\evil.zip', 'folder/file.zip', '', 'backup.txt']) {
    assert.equal(safeRemoteZipFilename(bad), null)
  }
})
