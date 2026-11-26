// The output folder's life: a build writes into a stage beside it, and swaps the stage in only once every step passed.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { relPosix } from './files'

/** The file kay writes into each folder it builds, so a later build knows the folder is its own to replace. */
export const OUTPUT_MARKER = '.kay-output'

const LEADING_SLASH_RE = /^\/+/

/** Throws unless `outDir` is missing, empty, or a folder kay built: replacing it must never delete someone's files. */
export function assertOwnOutDir(root: string, outDir: string, assetPrefix: string): void {
  if (!existsSync(outDir))
    return
  const names = new Set(readdirSync(outDir))
  if (names.size === 0 || names.has(OUTPUT_MARKER))
    return
  // A build made before the marker existed: a server build's manifest beside its server/ folder, or a static export's asset folder.
  const assetDir = assetPrefix.replace(LEADING_SLASH_RE, '').split('/')[0] ?? ''
  if ((names.has('manifest.json') && names.has('server')) || (assetDir !== '' && names.has(assetDir)))
    return
  throw new Error(`kay build: refusing to replace "${relPosix(root, outDir)}": it holds files kay did not build. Delete it, or set \`outDir\` in kay.config.ts to a folder of its own.`)
}

/** The stage folder a build writes into, beside `finalOutDir` so a rename swaps it in. */
export function stageDirFor(finalOutDir: string, suffix: string): string {
  return join(dirname(finalOutDir), `.${basename(finalOutDir)}.stage-${suffix}`)
}

/** A suffix naming the running process first, so a later build can tell a dead build's leftovers from a live one's. */
export function processSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM'
  }
}

/** Removes the folders under `parent` whose name is `prefix` then a process suffix, when that process has died. */
export function removeDeadProcessDirs(parent: string, prefix: string): void {
  if (!existsSync(parent))
    return
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix))
      continue
    const pid = Number.parseInt(name.slice(prefix.length), 10)
    if (Number.isInteger(pid) && pid !== process.pid && !isAlive(pid))
      rmSync(join(parent, name), { recursive: true, force: true })
  }
}

/** Removes the stage and backup folders a killed build left beside `finalOutDir`. */
export function removeStaleStages(finalOutDir: string): void {
  const parent = dirname(finalOutDir)
  removeDeadProcessDirs(parent, `.${basename(finalOutDir)}.stage-`)
  removeDeadProcessDirs(parent, `.${basename(finalOutDir)}.prev-`)
}

/** Marks `stageDir` as kay's output and renames it to `finalOutDir`, putting the previous folder back if the rename fails. */
export function swapStage(stageDir: string, finalOutDir: string, suffix: string): void {
  writeFileSync(join(stageDir, OUTPUT_MARKER), 'Built by kay. The next kay build replaces this folder.\n')
  if (!existsSync(finalOutDir)) {
    mkdirSync(dirname(finalOutDir), { recursive: true })
    renameSync(stageDir, finalOutDir)
    return
  }
  const backupDir = join(dirname(finalOutDir), `.${basename(finalOutDir)}.prev-${suffix}`)
  renameSync(finalOutDir, backupDir)
  try {
    renameSync(stageDir, finalOutDir)
  }
  catch (err) {
    renameSync(backupDir, finalOutDir)
    throw err
  }
  rmSync(backupDir, { recursive: true, force: true })
}
