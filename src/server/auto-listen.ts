import type { AnyElysia } from 'elysia'
import process from 'node:process'

// On `globalThis`, as `kay dev`'s preload reads it from its own copy of this module.
const PENDING = Symbol.for('kay.autoListen')
// How long an app `pages()` returned may go unused before it is taken to be the whole app.
const UNUSED_MS = 200
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

  app.listen({ port: Number(process.env.PORT ?? 3000), ...HOST !== undefined && { hostname: HOST } })
  // An entry reaching its own `listen` after an `await` finds the server it asked for.
  app.listen = (() => app) as AnyElysia['listen']
}

// The apps of a run that a reload replaced are not listened: their servers were stopped to be taken over.
export function forgetIdleApps(): void {
  pending().clear()
}

// Listens every app waiting at once, as `kay dev` does right after a reload, whose entry ran to its end, and compares the servers started with the run before.
export function listenIdleApps(): void {
  const apps = pending()

  for (const plugin of apps.keys()) {
    apps.delete(plugin)

    const app = rootOf(plugin)

    if (!listening(app))
      listen(app)
  }
}

// An app is listened a turn after it was seen in the entry's app, as an `await` on `pages()` returns a turn after it was made, or past `UNUSED_MS` when it is the entry's whole app.
function settle(): void {
  const apps = pending()

  timer = undefined

  for (const [plugin, idle] of apps) {
    const app = rootOf(plugin)
    const used = app !== plugin

    if (listening(app) || (used && idle.seen) || (!used && Date.now() - idle.since > UNUSED_MS)) {
      apps.delete(plugin)

      if (!listening(app))
        listen(app)
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
