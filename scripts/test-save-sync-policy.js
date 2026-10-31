const test = require('node:test')
const assert = require('node:assert/strict')
const { chooseSafeSaveAction } = require('../dist/main/saveSyncPolicy.js')

const snapshot = (exists, modifiedMs = null) => ({ exists, modifiedMs })

test('no local saves can safely recover a remote backup', () => {
  assert.equal(chooseSafeSaveAction(snapshot(false), snapshot(true, 5000)), 'restore')
})

test('never auto-overwrite existing local data even if cloud reports a newer snapshot', () => {
  assert.equal(chooseSafeSaveAction(snapshot(true, 1000), snapshot(true, 5000)), 'ask')
})

test('a newer local save must be preserved', () => {
  assert.equal(chooseSafeSaveAction(snapshot(true, 100000), snapshot(true, 5000)), 'local')
})

test('unknown timestamps are not proof that the cloud is newer', () => {
  assert.equal(chooseSafeSaveAction(snapshot(true), snapshot(true)), 'ask')
  assert.equal(chooseSafeSaveAction(snapshot(true, 3000), snapshot(true)), 'ask')
  assert.equal(chooseSafeSaveAction(snapshot(true), snapshot(true, 3000)), 'ask')
})

test('a missing remote backup never triggers restore', () => {
  assert.equal(chooseSafeSaveAction(snapshot(false), snapshot(false)), 'none')
  assert.equal(chooseSafeSaveAction(snapshot(true, 1), snapshot(false)), 'local')
})

test('close timestamps require explicit choice, not blind replacement', () => {
  assert.equal(chooseSafeSaveAction(snapshot(true, 50000), snapshot(true, 50100)), 'ask')
})
