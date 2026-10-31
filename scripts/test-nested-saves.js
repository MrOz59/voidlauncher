const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  writeHeuristicSaveArchive,
  saveArchiveFolderName,
  restoreSaveDirectoryContents
} = require('../dist/main/heuristicSaveArchive.js')
const { unpackSaveBundle } = require('../dist/main/saveBundles.js')
const { isValidBackupZip } = require('../dist/main/backupIntegrity.js')

test('Stellaris: backup and restore keep empire/profile folders around .sav files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'void-stellaris-saves-'))
  try {
    const saveRoot = path.join(temp, 'OneDrive', 'Documentos', 'Paradox Interactive', 'Stellaris', 'save games')
    const empire = 'unitednationsofearth_-15512622'
    const otherEmpire = 'commonwealthofman_-212'
    fs.mkdirSync(path.join(saveRoot, empire), { recursive: true })
    fs.mkdirSync(path.join(saveRoot, otherEmpire), { recursive: true })
    const first = Buffer.from('stellaris-save-1\0\1')
    const second = Buffer.from('stellaris-save-2\2\3')
    fs.writeFileSync(path.join(saveRoot, empire, '2200.01.01.sav'), first)
    fs.writeFileSync(path.join(saveRoot, otherEmpire, '2201.02.02.sav'), second)

    const location = { path: saveRoot, type: 'unknown', confidence: 'high', saveFileCount: 2 }
    const zipPath = path.join(temp, 'backup.zip')
    await writeHeuristicSaveArchive({
      locations: [location],
      zipPath,
      gameKey: 'steam_281990',
      gameTitle: 'Stellaris',
      platform: process.platform
    })
    assert.equal(isValidBackupZip(zipPath), true)

    const staging = path.join(temp, 'extracted')
    const manifest = await unpackSaveBundle(zipPath, staging)
    assert.equal(manifest.gameKey, 'steam_281990')
    assert.equal(manifest.hierarchy, 'preserve-relative-tree')
    const folder = saveArchiveFolderName(location, 0)
    const archivedRoot = path.join(staging, folder)
    assert.deepEqual(fs.readFileSync(path.join(archivedRoot, empire, '2200.01.01.sav')), first)
    assert.deepEqual(fs.readFileSync(path.join(archivedRoot, otherEmpire, '2201.02.02.sav')), second)

    const info = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'))
    assert.equal(info.locations[0].archiveFolder, folder)
    assert.equal(info.locations[0].path, saveRoot)

    const restoredRoot = path.join(temp, 'Restored', 'Paradox Interactive', 'Stellaris', 'save games')
    fs.mkdirSync(path.join(restoredRoot, 'existing_empire'), { recursive: true })
    fs.writeFileSync(path.join(restoredRoot, 'existing_empire', 'not-in-backup.sav'), 'preserve')
    restoreSaveDirectoryContents(archivedRoot, restoredRoot)

    assert.deepEqual(fs.readFileSync(path.join(restoredRoot, empire, '2200.01.01.sav')), first)
    assert.deepEqual(fs.readFileSync(path.join(restoredRoot, otherEmpire, '2201.02.02.sav')), second)
    assert.equal(fs.readFileSync(path.join(restoredRoot, 'existing_empire', 'not-in-backup.sav'), 'utf8'), 'preserve')
    assert.equal(fs.existsSync(path.join(restoredRoot, folder)), false,
      'must not add the archive wrapper to the game save path')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('a nonexistent save root is an archive error, not a completed backup', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'void-missing-saves-'))
  try {
    const zipPath = path.join(temp, 'bad.zip')
    await assert.rejects(writeHeuristicSaveArchive({
      locations: [{ path: path.join(temp, 'missing'), type: 'unknown', confidence: 'high' }],
      zipPath,
      gameKey: 'title_example',
      gameTitle: 'Example',
      platform: process.platform
    }))
    assert.equal(fs.existsSync(zipPath), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
