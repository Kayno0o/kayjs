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
  // Page directory relative to the root, for the regenerated `.kay/types`.
  routes?: string
  // Called with each server process once it is spawned.
  onRestart?: (child: Subprocess) => void
}

const DEBOUNCE_MS = 80

// Runs the server entry in development and restarts it on every change; a fresh process is the only way to drop modules Bun has loaded.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  const entry = resolve(root, options.entry ?? 'src/server.ts')
  let child: Subprocess | undefined
  let timer: Timer | undefined
  let changed = false
  let restarting: Promise<void> | undefined

  const start = () => {
    child = Bun.spawn([process.execPath, entry], { cwd: root, env: { ...process.env, NODE_ENV: 'development' }, stdout: 'inherit', stderr: 'inherit' })
    options.onRestart?.(child)
  }
  const restart = async () => {
    child?.kill()
    await Promise.all([child?.exited, regenerateTypes(root, options.routes)])
    start()
  }
  // Changes landing during a restart trigger one more, never two restarts at once.
  const drain = async () => {
    while (changed) {
      changed = false
      await restart()
    }

    restarting = undefined
  }
  const watchers = await watchProject(root, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      changed = true
      restarting ??= drain()
    }, DEBOUNCE_MS)
  })

  await regenerateTypes(root, options.routes)
  start()

  return async () => {
    clearTimeout(timer)
    for (const watcher of watchers)
      watcher.close()
    await restarting
    child?.kill()
    await child?.exited
  }
}

// Keeps editors and `tsgo` in step with the `.kay` sources; type errors themselves are `kay check`'s job.
async function regenerateTypes(root: string, routes: string | undefined) {
  try {
    await writeShadowTypes(root, { routes })
  }
  catch (error) {
    console.error(error)
  }
}

// One recursive watcher per top-level directory, so dependencies and generated output are never walked.
async function watchProject(root: string, onChange: () => void): Promise<FSWatcher[]> {
  const entries = await readdir(root, { withFileTypes: true })

  return entries
    .filter(entry => entry.isDirectory() ? !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.') : !entry.name.startsWith('.') || entry.name.startsWith('.env'))
    .map(entry => watch(join(root, entry.name), { recursive: entry.isDirectory() }, onChange))
}
