import type { Subprocess } from 'bun'
import type { FSWatcher } from 'node:fs'
import { watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { IGNORED_DIRS } from '../build/files'
import { writeShadowTypes } from '../check'

export interface DevOptions {
  // The server entry, relative to the root.
  entry?: string
  // Page and public file directories relative to the root, for the regenerated `.kay/types`.
  routes?: string
  publicDir?: string
  // Called with each server process once it is spawned.
  onRestart?: (child: Subprocess) => void
}

// Long enough to gather the few events one save makes.
const DEBOUNCE_MS = 30
const SPARE = join(import.meta.dir, 'spare.ts')
// The root files Bun reads as a process starts.
const STARTUP_FILE = /^(?:\.env.*|package\.json|bunfig\.toml|tsconfig\.json)$/

// Runs the server entry in development and restarts it on every change; a fresh process is the only way to drop modules Bun has loaded.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  const entry = resolve(root, options.entry ?? 'src/server.ts')
  let child: Subprocess<'pipe'> | undefined
  let spare: Subprocess<'pipe'> | undefined
  let timer: Timer | undefined
  let changed = false
  // Bun reads these as a process starts, so changing one needs a process started after it.
  let startupChanged = false
  let restarting: Promise<void> | undefined

  const spawn = () => Bun.spawn([process.execPath, '--preload', SPARE, entry], { cwd: root, env: { ...process.env, NODE_ENV: 'development' }, stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
  // Each restart takes the process waiting with kay loaded, and readies the next one.
  const start = () => {
    if (startupChanged || spare === undefined || spare.exitCode !== null) {
      spare?.kill()
      spare = spawn()
      startupChanged = false
    }

    child = spare
    void child.stdin.write('start\n')
    void child.stdin.flush()
    spare = spawn()
    options.onRestart?.(child)
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten.
  const restart = async () => {
    child?.kill()
    await child?.exited
    start()
    await regenerateTypes(root, options)
  }
  // Changes landing during a restart trigger one more, never two restarts at once.
  const drain = async () => {
    while (changed) {
      changed = false
      await restart()
    }

    restarting = undefined
  }
  const watchers = await watchProject(root, (file) => {
    startupChanged ||= STARTUP_FILE.test(file)
    clearTimeout(timer)
    timer = setTimeout(() => {
      changed = true
      restarting ??= drain()
    }, DEBOUNCE_MS)
  })

  await regenerateTypes(root, options)
  start()

  return async () => {
    clearTimeout(timer)
    for (const watcher of watchers)
      watcher.close()
    await restarting
    child?.kill()
    spare?.kill()
    await Promise.all([child?.exited, spare?.exited])
  }
}

// Keeps editors and `tsgo` in step with the `.kay` sources; type errors themselves are `kay check`'s job.
async function regenerateTypes(root: string, { routes, publicDir }: DevOptions) {
  try {
    await writeShadowTypes(root, { routes, publicDir })
  }
  catch (error) {
    console.error(error)
  }
}

// One recursive watcher per top-level directory, so dependencies and generated output are never walked.
// `onChange` gets the changed path relative to the root.
async function watchProject(root: string, onChange: (file: string) => void): Promise<FSWatcher[]> {
  const entries = await readdir(root, { withFileTypes: true })

  return entries
    .filter(entry => entry.isDirectory() ? !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.') : !entry.name.startsWith('.') || entry.name.startsWith('.env'))
    .map(entry => watch(join(root, entry.name), { recursive: entry.isDirectory() }, (_event, file) => onChange(entry.isDirectory() ? `${entry.name}/${file ?? ''}` : entry.name)))
}
