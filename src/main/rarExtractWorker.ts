/**
 * Worker thread for RAR extraction.
 * Runs node-unrar-js in a separate thread to avoid blocking the main process UI.
 */
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createExtractorFromFile as createRarExtractor } from 'node-unrar-js'

interface WorkerInput {
  rarPath: string
  destDir: string
  password?: string
}

function moveDirContentsOverwrite(srcDir: string, destDir: string) {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    try {
      if (entry.isDirectory()) {
        moveDirContentsOverwrite(srcPath, destPath)
        try { fs.rmSync(srcPath, { recursive: true, force: true }) } catch {}
      } else {
        try {
          if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true })
        } catch {}
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        try {
          fs.renameSync(srcPath, destPath)
        } catch {
          fs.cpSync(srcPath, destPath, { force: true })
          try { fs.rmSync(srcPath, { force: true }) } catch {}
        }
      }
    } catch (err) {
      console.warn('[RarWorker] Failed to move extracted entry', srcPath, '->', destPath, err)
      throw err // Never signal 'done' after partial copy/move.
    }
  }
}

async function run() {
  const { rarPath, destDir, password } = workerData as WorkerInput

  console.log('[RarWorker] Starting', { rarPath, destDir })

  try {
    fs.mkdirSync(destDir, { recursive: true })
  } catch {}

  const tmpDir = path.join(destDir, `.of_extract_tmp_${crypto.randomBytes(4).toString('hex')}`)
  try { fs.mkdirSync(tmpDir, { recursive: true }) } catch {}

  try {
    const extractor = await createRarExtractor({
      filepath: rarPath,
      targetPath: tmpDir,
      password: password || 'online-fix.me'
    })

    const headersGen = extractor.getFileList().fileHeaders || []
    const entries = Array.from(headersGen as Iterable<any>)
    let processed = 0
    const total = entries.length || 1

    parentPort?.postMessage({ type: 'progress', percent: 0 })

    const iterator = extractor.extract().files || []
    for (const entry of iterator) {
      processed++
      const percent = Math.min(95, Math.max(0, (processed / total) * 100))
      parentPort?.postMessage({ type: 'progress', percent })
      console.log('[RarWorker] extracted', entry.fileHeader?.name, percent.toFixed(1) + '%')
    }

    if (processed === 0 || entries.length === 0) {
      throw new Error('RAR archive contained no extractable game files')
    }
    moveDirContentsOverwrite(tmpDir, destDir)
    parentPort?.postMessage({ type: 'progress', percent: 100 })
    parentPort?.postMessage({ type: 'done' })
    console.log('[RarWorker] finished', { rarPath, destDir })
  } catch (err: any) {
    parentPort?.postMessage({ type: 'error', error: err?.message || String(err) })
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

run()
