import type { AnyElysia } from 'elysia'
import process from 'node:process'
import { kayLog } from '../runtime/log'

// On `globalThis`, as `kay dev`'s preload reads it from its own copy of this module.
const PENDING = Symbol.for('kay.autoListen')
// How long an app `pages()` returned may go unused before it is left alone.
const UNUSED_MS = 200
// One turn of the event loop, enough for an entry to reach its `listen` after `await pages()`.
const TURN_MS = 5

interface WithParent {
  getParent?: () => AnyElysia | null | undefined
}

interface Idle {
  since: number
  // The app was seen holding the pages for a turn of the event loop, which is the entry's own code reaching its `listen`.
  seen: boolean
}

let timer: Timer | undefined

function pending(): Map<AnyElysia, Idle> {
  const holder = globalThis as { [PENDING]?: Map<AnyElysia, Idle> }

  return holder[PENDING] ??= new Map()
}

// The app `pages()` was used in, however deep: Elysia gives a used instance its parent, which is not in its types.
function rootOf(app: AnyElysia): AnyElysia {
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
  // An entry reaching its own `listen` after an `await` replaces the server kay started with the one it asks for.
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

// Listens every app waiting at once, for `kay dev` right after a reload, whose entry ran to its end.
export function listenIdleApps(): void {
  const apps = pending()

  for (const plugin of apps.keys()) {
    apps.delete(plugin)

    const app = rootOf(plugin)

    if (!listening(app))
      listen(app)
  }
}

// An app is listened a turn after it was seen in the entry's app, as an `await` on `pages()` returns a turn after it was made, or dropped past `UNUSED_MS` when no app ever used it.
function settle(): void {
  const apps = pending()

  timer = undefined

  for (const [plugin, idle] of apps) {
    const app = rootOf(plugin)
    const used = app !== plugin

    if (listening(app) || (used && idle.seen) || (!used && Date.now() - idle.since > UNUSED_MS)) {
      apps.delete(plugin)

      if (used && !listening(app))
        listenSafely(app)
    }
    else if (used) {
      idle.seen = true
    }
  }

  if (apps.size > 0)
    timer = setTimeout(settle, TURN_MS)
}

// Has the app `pages()` returned listened on `PORT` and `HOST` once the entry's own code had its turn, unless it listened itself.
export function listenWhenIdle(plugin: AnyElysia): void {
  pending().set(plugin, { since: Date.now(), seen: false })
  timer ??= setTimeout(settle, TURN_MS)
}
