import type { Owner } from './reactive'
import { skew } from './build'
import { blockIn, claiming, HydrationMismatchError, islandOf, Range, Region, release, swap } from './dom'
import { ISLAND, PART_END, PART_START } from './markers'
import { getOwner, onCleanup, reportError, runWithOwner, unrecorded } from './reactive'
import { savesDataInBrowser } from './save-data'

// A component whose code loads the first time it draws: its own module, as it weighs on a page whose islands draw every component at once.

type Component = (props: never) => unknown

interface Loadable {
  load: () => Promise<{ default: unknown }>
  component?: Component | undefined
  loading?: Promise<{ default: unknown }> | undefined
}

// How long to wait before each new try of a chunk that failed to load.
const RETRY_WAITS_MS = [1000, 3000]

// One entry per key, which every module importing that component shares: a module that loaded it is a load for all.
const loadables = new Map<string, Loadable>()
// The keys each island's module imports lazily, by island id, which a visitor reaching for the island loads ahead.
const scopes = new Map<string, Set<string>>()
// The keys a failed intent load left, tried once: a hover must not ask again and again for a chunk that is not there.
const refused = new Set<string>()

// Loads a component's chunk, the same load for every caller; a failure is dropped so the next call tries again.
async function ensure(loadable: Loadable): Promise<Component> {
  if (loadable.component)
    return loadable.component

  const attempt = loadable.loading ??= loadable.load()

  try {
    loadable.component = (await attempt).default as Component
    ;(globalThis as { $kayLazyLoaded?: boolean }).$kayLazyLoaded = true
  }
  catch (error) {
    // Only its own attempt is dropped: another caller may have started a new one since.
    if (loadable.loading === attempt)
      loadable.loading = undefined

    throw error
  }

  return loadable.component
}

let watching = false
// Bumped whenever a module registers keys, so an island warmed before it is warmed again.
let version = 0
const warmed = new Map<string, number>()

// The first sign a visitor reaches for something in an island loads the lazy parts of that island, so a click finds the code in. A visitor saving data loads a part when it opens.
function warmOnIntent(): void {
  if (watching || typeof document === 'undefined')
    return

  watching = true

  const warm = (event: Event) => {
    const island = event.target instanceof Element ? event.target.closest<HTMLElement>(ISLAND) : null

    if (island?.dataset.component !== undefined && !savesDataInBrowser())
      void warmScope(island.dataset.component)
  }

  for (const name of ['pointerover', 'pointerdown', 'focusin'])
    document.addEventListener(name, warm, { capture: true, passive: true })
}

// The keys of an island and of the modules that are no island on the page, which are the components it draws.
function keysFor(id: string): string[] {
  const own = new Set<string>()

  for (const [scope, keys] of scopes) {
    if (scope === id || !document.querySelector(`${ISLAND}[data-component="${CSS.escape(scope)}"]`)) {
      for (const key of keys) {
        own.add(key)
      }
    }
  }

  return [...own]
}

async function warmScope(id: string): Promise<void> {
  if (warmed.get(id) === version)
    return

  await Promise.all(keysFor(id).map(async (key) => {
    const loadable = loadables.get(key)

    if (!loadable || loadable.component || loadable.loading || refused.has(key))
      return

    try {
      await ensure(loadable)
      // What the loaded module imports lazily in turn belongs to the same island.
      await warmScope(id)
    }
    catch {
      // Drawn when it opens, which tries again and reports.
      refused.add(key)
    }
  }))
  warmed.set(id, version)
}

// A component imported as `KayLazy(key, () => import('./it.kay'))`: it draws as the component does once loaded, and before that a place the component renders into when it arrives.
// A visitor reaching for the island loads it ahead, and one the server drew is loaded before its island's module is done (`ready`), so the markup is claimed as it stands.
export function lazy(key: string, load: () => Promise<{ default: unknown }>): (props: never) => unknown {
  let loadable = loadables.get(key)

  if (!loadable)
    loadables.set(key, loadable = { load })

  const entry = loadable

  warmOnIntent()

  return (props: never) => {
    if (entry.component)
      return entry.component(props)

    // The island was told the keys the server drew, which it loads first: one left is a markup the code was not there to claim, so the island draws afresh.
    if (claiming())
      throw new HydrationMismatchError(`the server drew ${key} but its code did not load before the island hydrated`)

    return placeholder(entry, props, key)
  }
}

// Hands an error to the nearest `catch` block above `owner`, or reports it when there is none, as an effect of the owner would.
function handleError(owner: Owner | undefined, error: unknown): void {
  let catcher = owner

  while (catcher && !catcher.catcher)
    catcher = catcher.owner

  if (!catcher) {
    reportError(error)

    return
  }

  try {
    catcher.catcher!(error)
  }
  catch (failure) {
    reportError(failure)
  }
}

// An empty range, the component rendered between its ends once its code is in.
function placeholder(entry: Loadable, props: never, key: string): Range {
  const start = document.createComment(PART_START)
  const end = document.createComment(PART_END)
  const parent = getOwner()

  // The ends are siblings, as a range's nodes are, so the parent places both and what draws between them.
  document.createDocumentFragment().append(start, end)

  const block = blockIn(new Region(null, start, end))
  let gone = false

  onCleanup(() => {
    gone = true
    release(block)
  })

  void track(land(entry, key, start, () => gone, (component) => {
    // A part taken out of its parent has nowhere to draw.
    if (!start.parentNode)
      return

    // A render error goes to the nearest `catch` above the place, as an eager component's does, and is no load failure.
    try {
      runWithOwner(parent, () => unrecorded(() => swap(block, () => component(props), true)))
      focusArrival(start)
    }
    catch (error) {
      handleError(parent, error)
    }
  }))

  return new Range(start, end)
}

const FOCUSABLE = '[autofocus], a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

// A part arriving in a dialog opened a moment ago, where the focus waits on the dialog itself, gives it to its first control, unless the visitor moved it meanwhile.
function focusArrival(anchor: Node): void {
  const dialog = anchor.parentElement?.closest('dialog')

  if (dialog?.open && document.activeElement === dialog)
    dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus()
}

// The places waiting for their component, which a test's `settle()` waits for through `$kayLazyIdle`.
const inflight = new Set<Promise<void>>()

async function track(drawing: Promise<void>): Promise<void> {
  inflight.add(drawing)

  try {
    await drawing
  }
  finally {
    inflight.delete(drawing)
  }
}

;(globalThis as { $kayLazyIdle?: () => Promise<void> }).$kayLazyIdle = async () => {
  while (inflight.size > 0)
    await Promise.allSettled(inflight)
}

// Loads the component, trying again after a failure, then draws it; a render error is no load failure and goes where any render error of the branch goes. The one that failed to load for good is reported, and a deploy that dropped the chunk reloads the page.
async function land(entry: Loadable, key: string, anchor: Node, gone: () => boolean, draw: (component: Component) => void): Promise<void> {
  let component: Component | undefined
  let failure: unknown

  for (const wait of [0, ...RETRY_WAITS_MS]) {
    if (wait > 0)
      await new Promise(resolve => setTimeout(resolve, wait))

    if (gone())
      return

    try {
      component = await ensure(entry)

      break
    }
    catch (error) {
      failure = error

      if (await skew())
        return
    }
  }

  if (component === undefined) {
    reportError(failure, islandOf(anchor))
    console.error(`[kay] ${key} failed to load, it draws when it is opened again`)

    return
  }

  if (!gone())
    draw(component)
}

// Loads the keys the server markup of the page drew, and what their modules import in turn, so the markup is claimed as it stands. A chunk that fails to load is left: its branch draws afresh and loads again, which retries and reports.
async function loadDrawn(): Promise<void> {
  const asked = typeof document === 'undefined' ? [] : [...document.querySelectorAll<HTMLElement>('[data-lazy]')].flatMap(element => element.dataset.lazy!.split(' '))
  const tried = new Set<string>()

  // The modules loaded may register keys the markup drew, which load in the next round.
  for (;;) {
    const round = asked.filter(key => loadables.has(key) && !tried.has(key) && !loadables.get(key)!.component)

    if (round.length === 0)
      return

    for (const key of round)
      tried.add(key)

    await Promise.allSettled(round.map(async key => ensure(loadables.get(key)!)))
  }
}

// What a module with lazy imports awaits at its top level: it records the keys it imports lazily for the island `id`, which a visitor reaching for the island loads ahead, and the module is not done until what the server drew is loaded. A page that swaps in an island of a module already run finds its drawn keys not loaded, and the island draws afresh.
export async function ready(id: string, keys: readonly string[]): Promise<void> {
  scopes.set(id, new Set([...scopes.get(id) ?? [], ...keys]))
  version++
  await loadDrawn()
}
