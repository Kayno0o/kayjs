import type { AnyElysia } from 'elysia'
import process from 'node:process'
import { kayLog } from '../runtime/log'

// On `globalThis`, as `kay dev`'s preload reads it from its own copy of this module.
const PENDING = Symbol.for('kay.autoListen')
const SERVES = Symbol.for('kay.autoListen.serves')

interface WithParent {
  getParent?: () => AnyElysia | null | undefined
}

interface Holder {
  [PENDING]?: Map<AnyElysia, number>
  [SERVES]?: number
}

// The apps `pages()` returned in an entry that may not listen, with how many `Bun.serve` calls had been made when each was.
function pending(): Map<AnyElysia, number> {
  return (globalThis as Holder)[PENDING] ??= new Map()
}

// Counts the servers started through `Bun.serve`, which Elysia's `listen` goes through too: an entry serving `app.fetch` itself has started one, so its app is not listened a second time.
function serves(): number {
  const holder = globalThis as Holder

  if (holder[SERVES] === undefined) {
    const serve = Bun.serve.bind(Bun)

    holder[SERVES] = 0
    Bun.serve = ((...args: Parameters<typeof Bun.serve>) => {
      holder[SERVES] = (holder[SERVES] ?? 0) + 1

      return serve(...args)
    }) as typeof Bun.serve
  }

  return holder[SERVES]
}

// The app `pages()` was used in, however deep: Elysia gives a used instance its parent, which is not in its types and which `tests/auto-listen.test.ts` pins.
export function rootOf(app: AnyElysia): AnyElysia {
  let root = app

  for (let parent = (root as unknown as WithParent).getParent?.(); parent !== undefined && parent !== null; parent = (root as unknown as WithParent).getParent?.())
    root = parent

  return root
}

function listening(app: AnyElysia): boolean {
  return app.server !== null && app.server !== undefined
}

// On `PORT` (3000 by default) and on `HOST` when it is set.
function listen(app: AnyElysia): void {
  const { HOST } = process.env

  const original = app.listen

  app.listen({ port: Number(process.env.PORT ?? 3000), ...HOST !== undefined && { hostname: HOST } })
  // An entry reaching its own `listen` after it ran to its end replaces the server kay started with the one it asks for.
  app.listen = ((...args: Parameters<AnyElysia['listen']>) => {
    void app.server?.stop(true)
    app.server = null
    app.listen = original

    return original(...args)
  }) as AnyElysia['listen']
}

function listenSafely(app: AnyElysia): void {
  try {
    listen(app)
  }
  catch (error) {
    kayLog('error', 'the server could not listen', error)
  }
}

// The apps of a run that a reload replaced are not listened: their servers were stopped to be taken over.
export function forgetIdleApps(): void {
  pending().clear()
}

// Listens every app waiting that its entry left idle, right after the entry ran to its end: one that listened, or that served through `Bun.serve`, is left alone.
export function listenIdleApps(): void {
  const apps = pending()
  const now = serves()

  for (const [plugin, before] of apps) {
    apps.delete(plugin)

    const app = rootOf(plugin)

    if (!listening(app) && now === before)
      listenSafely(app)
  }
}

// Notes the app `pages()` returned, to be listened on `PORT` and `HOST` by `listenIdleApps` once the entry ran to its end.
// `afterEntry` listens it there itself, by importing the main module, which resolves when its evaluation ends: the executable has no entry module to import and calls `listenIdleApps` instead.
export function listenWhenIdle(plugin: AnyElysia, afterEntry: boolean): void {
  pending().set(plugin, serves())

  if (afterEntry)
    void listenAfterEntry()
}

async function listenAfterEntry(): Promise<void> {
  try {
    await import(Bun.main)
  }
  catch (error) {
    // The entry failing reports itself; this says it left the app unlistened.
    kayLog('error', 'the server was not listened, as its entry did not run to its end', error)

    return
  }

  listenIdleApps()
}
