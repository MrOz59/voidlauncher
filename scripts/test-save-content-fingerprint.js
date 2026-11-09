const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const archiver = require('archiver')
const {
  fingerprintSaveRoots,
  fingerprintLudusaviSnapshot,
  fingerprintExtractedSaveBundle
} = require('../dist/main/saveContentFingerprint.js')
const { writeHeuristicSaveArchive } = require('../dist/main/heuristicSaveArchive.js')
const { unpackSaveBundle } = require('../dist/main/saveBundles.js')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'void-save-fingerprint-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }
  return { root, put }
}

async function writeZip(file, contents) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file)
    const zip = archiver('zip')
    output.on('close', resolve)
    output.on('error', reject)
    zip.on('error', reject)
    zip.pipe(output)
    for (const [name, contentsOfFile] of Object.entries(contents)) {
      zip.append(contentsOfFile, { name })
    }
    void zip.finalize().catch(reject)
  })
}

test('byte-identical nested saves match despite root paths, mtimes and order', async t => {
  const { root, put } = fixture(t)
  const source = path.join(root, 'local', 'Stellaris', 'save games')
  const moved = path.join(root, 'remote machine', 'Stellaris', 'save games')
  put(path.join(source, 'empire', '2200.sav'), Buffer.from('save-data-01'))
  put(path.join(source, 'empire', '2201.sav'), Buffer.from('save-data-02'))
  put(path.join(moved, 'empire', '2200.sav'), Buffer.from('save-data-01'))
  put(path.join(moved, 'empire', '2201.sav'), Buffer.from('save-data-02'))
  fs.utimesSync(path.join(moved, 'empire', '2200.sav'), new Date(1000), new Date(1000))
  assert.equal(await fingerprintSaveRoots([source]), await fingerprintSaveRoots([moved]))
  const extraRoot = path.join(root, 'other')
  put(path.join(extraRoot, 'settings.dat'), 'settings')
  assert.equal(
    await fingerprintSaveRoots([source, extraRoot]),
    await fingerprintSaveRoots([extraRoot, moved])
  )
})

test('same timestamp with different bytes is never considered equal', async t => {
  const { root, put } = fixture(t)
  const a = path.join(root, 'a')
  const b = path.join(root, 'b')
  const fileA = put(path.join(a, 'empire', 'save.sav'), 'version-a')
  const fileB = put(path.join(b, 'empire', 'save.sav'), 'version-b')
  const fixedTime = new Date('2026-11-08T15:07:50.000Z')
  fs.utimesSync(fileA, fixedTime, fixedTime)
  fs.utimesSync(fileB, fixedTime, fixedTime)
  assert.notEqual(await fingerprintSaveRoots([a]), await fingerprintSaveRoots([b]))
  put(path.join(b, 'empire', 'additional.sav'), 'more-data')
  assert.notEqual(await fingerprintSaveRoots([a]), await fingerprintSaveRoots([b]))
  assert.equal(await fingerprintSaveRoots([path.join(root, 'missing')]), null)
})

test('heuristic archives compare with local Stellaris saves without restoring', async t => {
  const { root, put } = fixture(t)
  const saveRoot = path.join(root, 'Stellaris', 'save games')
  const file = put(path.join(saveRoot, 'empire', '2200.sav'), 'stable-snapshot')
  const backup = path.join(root, 'backup.zip')
  await writeHeuristicSaveArchive({
    locations: [{ path: saveRoot, type: 'unknown', confidence: 'high' }],
    zipPath: backup, gameKey: 'steam_281990', gameTitle: 'Stellaris', platform: process.platform
  })
  const extracted = path.join(root, 'extracted')
  const manifest = await unpackSaveBundle(backup, extracted)
  const expected = { gameKey: 'steam_281990', format: 'heuristic-bundle', platform: process.platform }
  const archived = await fingerprintExtractedSaveBundle(extracted, manifest, expected)
  const live = await fingerprintSaveRoots([saveRoot])
  assert.equal(archived, live)
  assert.equal(await fingerprintExtractedSaveBundle(extracted, manifest, {
    ...expected, gameKey: 'another_game'
  }), null)
  fs.writeFileSync(file, 'changed-snapshot')
  assert.notEqual(await fingerprintSaveRoots([saveRoot]), archived)
})

test('Ludusavi ZIP snapshots compare by extracted contents, not ZIP name or timestamps', async t => {
  const { root, put } = fixture(t)
  const snapshotA = path.join(root, 'snapshot-a')
  const snapshotB = path.join(root, 'snapshot-b')
  const a = path.join(snapshotA, 'Stellaris')
  const b = path.join(snapshotB, 'Stellaris')
  put(path.join(a, 'mapping.yaml'), 'timestamp: 1\n')
  put(path.join(b, 'mapping.yaml'), 'timestamp: 2\n')
  await writeZip(path.join(a, 'backup-2026-11-08.zip'), {
    'drive-C/Users/A/Documents/Stellaris/save.sav': 'save-stable'
  })
  await writeZip(path.join(b, 'backup-2026-11-09.zip'), {
    'drive-C/Users/A/Documents/Stellaris/save.sav': 'save-stable'
  })
  assert.equal(await fingerprintLudusaviSnapshot(snapshotA), await fingerprintLudusaviSnapshot(snapshotB))
  await writeZip(path.join(b, 'backup-2026-11-09.zip'), {
    'drive-C/Users/A/Documents/Stellaris/save.sav': 'changed-save'
  })
  assert.notEqual(await fingerprintLudusaviSnapshot(snapshotA), await fingerprintLudusaviSnapshot(snapshotB))
})

test('symlink saves cannot be silently certified as equal', async t => {
  const { root, put } = fixture(t)
  const dir = path.join(root, 'saves')
  const target = put(path.join(root, 'other', 'save.sav'), 'game state')
  fs.mkdirSync(dir, { recursive: true })
  try { fs.symlinkSync(target, path.join(dir, 'save.sav')) } catch { return } // Windows privileges
  assert.equal(await fingerprintSaveRoots([dir]), null)
})
