// `kay start`: serves the built app, and reloads it in-process when a `kay build` swaps a new outDir in, so a deploy needs no restart.

import type { FSWatcher } from 'node:fs'
import type { KayApp, KayServer } from './http'
import { existsSync, watch } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { startBuiltApp } from './loader'

/** How long a swap may leave the outDir missing before the server goes back to the build it had. */
const SWAP_TIMEOUT_MS = 2000

export interface StartOptions {
  root: string
  port: number
  hostname: string
}

/** The server, and an app that forwards to whichever build it serves, for `handleSignals()`. */
export async function startServer(options: StartOptions): Promise<{ app: KayApp, server: KayServer }> {
  const first = await startBuiltApp({ root: options.root })
  let current = first.app
  const server = current.serve(options.port, options.hostname)
  const app: KayApp = {
    handle: async (request, remoteIp) => current.handle(request, remoteIp),
    serve: () => server,
    closeStreams: async () => current.closeStreams?.(),
    dispose: async () => {
      watcher?.close()
      await current.dispose?.()
    },
  }
  // A `--static` export is read from disk on each request, so it serves the new files with no reload.
  const watcher = first.entry !== undefined && current.reloadInto !== undefined
    ? watchSwaps(first.outDir, () => current, next => current = next, options.root, server)
    : undefined
  return { app, server }
}

/** Watches the folder holding `outDir` for the rename a build's swap makes, then loads the new build and swaps its handlers in. */
function watchSwaps(outDir: string, current: () => KayApp, setCurrent: (app: KayApp) => void, root: string, server: KayServer): FSWatcher {
  const name = basename(outDir)
  const shown = relative(root, outDir) || '.'
  let held: { promise: Promise<KayApp>, resolve: (app: KayApp) => void } | undefined
  let loading = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // From the first rename until the new build answers, requests wait for it: no page of the old build links an asset the new one dropped.
  const hold = (): void => {
    if (held !== undefined)
      return
    const { promise, resolve } = Promise.withResolvers<KayApp>()
    held = { promise, resolve }
    server.reload({ routes: {}, fetch: async (request: Request) => (await promise).handle(request, server.requestIP(request)?.address) })
  }

  const swapIn = async (): Promise<void> => {
    if (loading) {
      again = true
      return
    }
    loading = true
    const prev = current()
    try {
      if (!existsSync(join(outDir, 'manifest.json')))
        throw new Error(`${shown}/manifest.json is missing`)
      setCurrent((await startBuiltApp({ root, outDir })).app)
      console.log(`kay start: serving the new build in ${shown}/`)
    }
    catch (err) {
      console.error(`kay start: the build in ${shown}/ failed to load, so the previous one keeps answering: ${err instanceof Error ? err.message : String(err)}`)
    }
    loading = false
    if (again) {
      again = false
      void swapIn()
      return
    }
    current().reloadInto!(server)
    held?.resolve(current())
    held = undefined
    if (current() !== prev) {
      await prev.closeStreams?.()
      await prev.dispose?.()
    }
  }

  const watcher = watch(dirname(outDir), (_event, file) => {
    if (file !== name)
      return
    hold()
    clearTimeout(timer)
    // The swap renames the old folder away, then the stage in: the second rename brings the manifest back.
    timer = setTimeout(() => void swapIn(), existsSync(join(outDir, 'manifest.json')) ? 0 : SWAP_TIMEOUT_MS)
  })
  watcher.on('error', err => console.error(`kay start: stopped watching ${shown}/ for new builds: ${err.message}`))
  return watcher
}
