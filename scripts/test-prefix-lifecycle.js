#!/usr/bin/env node
// Exercise real prefix metadata and IPC handlers in a temporary home. Wine,
// Winetricks and the database are replaced so these checks never touch games.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

function load(file, mocks, processEnv) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/main', file), 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id),
    process: { ...process, platform: 'linux', env: processEnv },
    console: { log() {}, warn() {}, error() {} },
    Buffer, setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename: file })
  return module.exports
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'of-prefix-test-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const put = (file, data = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
    return file
  }
  const runtime = path.join(home, 'runtime')
  const runtime2 = path.join(home, 'runtime2')
  for (const dir of [runtime, runtime2]) {
    put(path.join(dir, 'proton'))
    put(path.join(dir, 'files/bin/wine'))
    put(path.join(dir, 'files/bin/wineserver'))
  }
  const winetricks = put(path.join(home, 'bin/winetricks'))
  const install = path.join(home, 'game')
  put(path.join(install, 'Game.exe'))
  const calls = []
  const failures = new Set()
  const state = { winebootFails: false, winetricksAvailable: true }
  const initialize = prefix => {
    for (const name of ['wineboot.exe', 'ntdll.dll', 'kernel32.dll']) {
      put(path.join(prefix, 'drive_c/windows/system32', name))
    }
  }
  const spawn = (cmd, args, options) => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    proc.unref = () => {}
    const call = { cmd, args: [...args], env: { ...options.env } }
    calls.push(call)
    setImmediate(() => {
      const isBoot = args.includes('wineboot')
      if (isBoot && !state.winebootFails) initialize(path.join(options.env.STEAM_COMPAT_DATA_PATH, 'pfx'))
      proc.emit('close', (isBoot && state.winebootFails) || args.some(a => failures.has(a)) ? 1 : 0)
    })
    return proc
  }
  const findFilesRecursive = (dir, pattern) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? findFilesRecursive(file, pattern) : pattern.test(entry.name) ? [file] : []
  })
  const env = { PATH: path.join(home, 'bin') }
  const db = { getSetting: () => runtime, setSetting() {} }
  const mocks = {
    fs: new Proxy(fs, { get(target, key) {
      if (key === 'existsSync') return file => {
        if (String(file) === winetricks && !state.winetricksAvailable) return false
        // Never discover the host's Wine, display tools or Steam installation.
        return String(file).startsWith(home + path.sep) && target.existsSync(file)
      }
      return target[key]
    } }),
    os: { ...os, homedir: () => home },
    child_process: { spawn, spawnSync: () => ({ status: state.winetricksAvailable ? 0 : 1 }) },
    './db': db,
    './downloadManager': { findFilesRecursive }
  }
  const manager = load('protonManager.js', mocks, env)
  const prepare = (retry = false, stored, rt = runtime, allowIncomplete = false) =>
    manager.ensureGamePrefixFromDefault('game_123', rt, undefined, retry, undefined, install, stored, allowIncomplete)
  const components = () => calls.filter(c => c.cmd === winetricks).flatMap(c => c.args.filter(a => !a.startsWith('-')))
  const metaPath = prefix => path.join(prefix, '.of_default_deps_v2')
  const metadata = prefix => JSON.parse(fs.readFileSync(metaPath(prefix), 'utf8'))
  const handlers = new Map()
  const events = []
  const game = { game_id: '123', url: 'game-url', title: 'Game', install_path: install, proton_runtime: runtime }
  const jobs = new Map()
  const { registerProtonHandlers } = load('ipc/protonHandlers.js', {
    fs: mocks.fs,
    './trustedIpc': { trustedIpcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    '../db': { getGame: () => game, updateGameInfo: (_, patch) => Object.assign(game, patch), extractGameIdFromUrl: () => '123' },
    '../protonManager': manager
  }, env)
  registerProtonHandlers({ inFlightPrefixJobs: jobs, sendPrefixJobStatus: e => events.push(e) })
  return { home, put, runtime, runtime2, install, calls, failures, state, initialize, manager, prepare, components, metadata, metaPath, handlers, events, game, jobs }
}

test('installation, settings refresh and subsequent launches reuse one prepared prefix', async t => {
  const f = fixture(t)
  f.put(path.join(f.install, 'vcruntime140.dll'))
  f.put(path.join(f.install, 'Game.exe.config'), '<supportedRuntime version="v4.0"/>')
  const redist = f.put(path.join(f.install, '_CommonRedist/vcredist/vc_redist.x64.exe'))
  const prefix = await f.prepare()
  assert.ok(f.components().includes('dotnet48'))
  assert.equal(f.calls.filter(c => c.args.includes(redist)).length, 1)
  f.game.proton_prefix = prefix
  f.calls.length = 0
  const result = await f.handlers.get('proton-create-game-prefix')(null, f.game.url, 'Game')
  assert.equal(result.success, true)
  assert.equal(result.prefix, prefix)
  await f.prepare(false, result.prefix)
  await f.prepare(false, result.prefix)
  assert.equal(f.calls.length, 0, 'no Wine or installers run again')
  assert.ok(f.metadata(prefix).installedComponents.includes('vcrun2022'))
  assert.equal(f.jobs.size, 0)
})

test('partial failures preserve successes; launch does not retry; refresh retries only failures', async t => {
  const f = fixture(t)
  f.failures.add('vcrun2022')
  await assert.rejects(f.prepare(), /Falha ao preparar/)
  const prefix = f.manager.getManagedPrefixPath('game_123', f.runtime)
  assert.deepEqual(f.components(), ['corefonts', 'vcrun2022', 'vcrun2022'])
  f.calls.length = 0
  await f.prepare(false, prefix, f.runtime, true)
  assert.equal(f.calls.length, 0)
  f.failures.clear()
  await f.prepare(true, prefix)
  assert.deepEqual(f.components(), ['vcrun2022'])
  f.calls.length = 0
  await f.prepare(false, prefix)
  assert.equal(f.calls.length, 0)
})

test('a game update installs only newly detected dependencies', async t => {
  const f = fixture(t)
  const prefix = await f.prepare()
  f.put(path.join(f.install, 'xaudio2_7.dll'))
  f.calls.length = 0
  await f.prepare(false, prefix)
  assert.deepEqual(f.components(), ['xact'])
  f.calls.length = 0
  await f.prepare(false, prefix)
  assert.equal(f.calls.length, 0)
})

test('switching Proton keeps the configured prefix, saves and successful components', async t => {
  const f = fixture(t)
  const prefix = await f.prepare()
  const save = f.put(path.join(prefix, 'pfx/drive_c/users/steamuser/save.dat'), 'save data')
  f.game.proton_prefix = prefix
  f.game.proton_runtime = f.runtime2
  f.calls.length = 0
  const result = await f.handlers.get('proton-create-game-prefix')(null, f.game.url)
  assert.equal(result.success, true)
  assert.equal(result.prefix, prefix)
  assert.equal(fs.readFileSync(save, 'utf8'), 'save data')
  assert.equal(f.calls.filter(c => c.args.includes('wineboot')).length, 1)
  assert.equal(f.components().length, 0)
  f.calls.length = 0
  await f.prepare(false, prefix, f.runtime2)
  assert.equal(f.calls.length, 0)
  await f.handlers.get('proton-open-winecfg')(null, f.game.url)
  assert.equal(f.calls[0].env.WINE, path.join(f.runtime2, 'files/bin/wine'))
})

test('legacy aggregate metadata is migrated without repeating successful setup', async t => {
  const f = fixture(t)
  const prefix = f.manager.getManagedPrefixPath('game_123', f.runtime)
  f.initialize(path.join(prefix, 'pfx'))
  f.put(f.metaPath(prefix), JSON.stringify({ schema: 3, proton: path.join(f.runtime, 'proton'), winebootDone: true, vcredist: { ok: true } }))
  await f.prepare(false, prefix)
  assert.equal(f.calls.length, 0)
  assert.equal(f.metadata(prefix).components.vcrun2022.ok, true)
})

test('a missing prefix cannot be considered ready just because metadata still exists', async t => {
  const f = fixture(t)
  const redist = f.put(path.join(f.install, '_CommonRedist/vcredist/vc_redist.x64.exe'))
  const prefix = await f.prepare()
  fs.rmSync(path.join(prefix, 'pfx'), { recursive: true })
  f.calls.length = 0
  await f.prepare(false, prefix)
  assert.equal(f.calls.filter(c => c.args.includes('wineboot')).length, 1)
  assert.equal(f.calls.filter(c => c.args.includes(redist)).length, 1)
})

test('metadata accidentally moved into pfx is repaired even when configured path ends in pfx', async t => {
  const f = fixture(t)
  const prefix = await f.prepare()
  const pfx = path.join(prefix, 'pfx')
  fs.renameSync(f.metaPath(prefix), f.metaPath(pfx))
  f.calls.length = 0
  await f.prepare(false, pfx)
  assert.equal(f.calls.length, 0)
  assert.ok(f.manager.getPrefixStatus(pfx).installedComponents.includes('vcrun2022'))
  assert.ok(fs.existsSync(f.metaPath(prefix)))
})

test('failed Wine initialization is reported as error by the settings handler', async t => {
  const f = fixture(t)
  f.state.winebootFails = true
  const result = await f.handlers.get('proton-create-game-prefix')(null, f.game.url)
  assert.equal(result.success, false)
  assert.equal(f.game.proton_prefix, undefined)
  assert.equal(f.events.at(-1).status, 'error')
  assert.equal(f.events.some(e => e.status === 'done'), false)
  assert.equal(f.jobs.size, 0)
  f.state.winebootFails = false
  assert.equal((await f.handlers.get('proton-create-game-prefix')(null, f.game.url)).success, true)
})

test('concurrent preparation and refresh serialize on the destination prefix', async t => {
  const f = fixture(t)
  const [first, second] = await Promise.all([f.prepare(), f.prepare(true)])
  assert.equal(first, second)
  assert.equal(f.calls.filter(c => c.args.includes('wineboot')).length, 1)
  assert.deepEqual(f.components(), ['corefonts', 'vcrun2022'])
})

test('bundled installers accept either game root or _CommonRedist and retry only failed entries', async t => {
  const f = fixture(t)
  const common = path.join(f.install, '_CommonRedist')
  const redist = f.put(path.join(common, 'vc_redist.x64.exe'))
  f.failures.add(redist)
  await assert.rejects(f.prepare())
  const prefix = f.manager.getManagedPrefixPath('game_123', f.runtime)
  f.calls.length = 0
  const skipped = await f.manager.ensureGameCommonRedists(common, prefix, f.runtime)
  assert.equal(skipped.ok, false)
  assert.equal(f.calls.length, 0)
  f.failures.clear()
  const refreshed = await f.manager.ensureGameCommonRedists(common, prefix, f.runtime, undefined, true)
  assert.equal(refreshed.ok, true)
  assert.equal(f.calls.length, 1)
  await f.manager.ensureGameCommonRedists(f.install, prefix, f.runtime)
  assert.equal(f.calls.length, 1)
})

test('manually installed components use the selected runtime and are remembered on launch', async t => {
  const f = fixture(t)
  const prefix = await f.prepare()
  f.game.proton_prefix = prefix
  f.game.proton_runtime = f.runtime2
  f.calls.length = 0
  const result = await f.handlers.get('winetricks-run')(null, f.game.url, ['xact'])
  assert.equal(result.success, true)
  assert.equal(f.calls[0].env.WINE, path.join(f.runtime2, 'files/bin/wine'))
  assert.ok(f.metadata(prefix).installedComponents.includes('xact'))
  f.put(path.join(f.install, 'xaudio2_7.dll'))
  f.calls.length = 0
  await f.prepare(false, prefix)
  assert.equal(f.calls.length, 0)
  assert.equal(f.handlers.has('proton-tricks-status'), false)
  assert.equal(f.handlers.has('winetricks-status'), true)
})

test('a shared default prefix is never modified by game preparation', async t => {
  const f = fixture(t)
  const shared = await f.manager.ensureDefaultPrefix(f.runtime)
  const before = fs.readFileSync(f.metaPath(shared), 'utf8')
  const prefix = await f.prepare(false, shared)
  assert.notEqual(prefix, shared)
  assert.equal(fs.readFileSync(f.metaPath(shared), 'utf8'), before)
})

test('missing Winetricks is not reported ready but does not prevent launch of a healthy prefix', async t => {
  const f = fixture(t)
  f.state.winetricksAvailable = false
  await assert.rejects(f.prepare())
  const prefix = f.manager.getManagedPrefixPath('game_123', f.runtime)
  f.calls.length = 0
  await f.prepare(false, prefix, f.runtime, true)
  assert.equal(f.calls.length, 0)
  f.state.winetricksAvailable = true
  await f.prepare(true, prefix)
  assert.deepEqual(f.components(), ['corefonts', 'vcrun2022'])
})

test('a custom compatdata directory is initialized and reused at its configured location', async t => {
  const f = fixture(t)
  const custom = path.join(f.home, 'custom-prefix')
  assert.equal(await f.prepare(false, custom), custom)
  assert.ok(f.calls.every(c => c.env.WINEPREFIX === path.join(custom, 'pfx')))
  f.calls.length = 0
  await f.prepare(true, custom)
  await f.prepare(false, custom)
  assert.equal(f.calls.length, 0)
})

test('recreating the default prefix initializes it once instead of preparing then deleting it', async t => {
  const f = fixture(t)
  const result = await f.handlers.get('proton-default-prefix')(null, true)
  assert.equal(result.success, true)
  assert.equal(f.calls.filter(c => c.args.includes('wineboot')).length, 1)
  assert.deepEqual(f.components(), ['corefonts', 'vcrun2022'])
})
