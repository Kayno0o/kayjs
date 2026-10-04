// Kay's reactive core: signals hold values, memos derive them, effects react to them.
// Writes apply at once; effects that depend on what changed run batched in a microtask, or right away through `flush()`.

type Equals<T> = false | ((previous: T, next: T) => boolean)

export interface SignalOptions<T> {
  // `false` notifies on every write; the default skips a write of the same value.
  equals?: Equals<T>
}

// A node others can depend on: a signal, or a memo.
interface Source {
  observers: Set<Computation> | undefined
}

interface SignalNode<T> extends Source {
  value: T
  equals: Equals<T>
}

const CLEAN = 0
// A source upstream may have changed: the sources are checked before running again.
const CHECK = 1
// A direct source changed: runs again.
const DIRTY = 2
const DISPOSED = 3

type State = typeof CLEAN | typeof CHECK | typeof DIRTY | typeof DISPOSED

// What owns child computations and cleanups: a root, a memo or an effect.
interface Owner {
  owner: Owner | undefined
  children: Owner[] | undefined
  cleanups: (() => void)[] | undefined
  state: State
}

interface Computation extends Owner, Source {
  fn: () => unknown
  value: unknown
  sources: Source[]
  // Typed per memo where it is made; compared as unknown values here.
  equals: Equals<never>
  // Effects run when what they read changes; memos only when read.
  effect: 'render' | 'user' | undefined
}

let owner: Owner | undefined
let listener: Computation | undefined
let renderQueue: Computation[] = []
let userQueue: Computation[] = []
let scheduled = false
let batching = 0
// Set while an island renders on the server, where nothing reacts afterwards: effects there never run.
let serverRendering = 0

const defaultEquals = <T>(previous: T, next: T) => previous === next

export function createSignal<T>(value: T, options?: SignalOptions<T>): [read: () => T, write: (next: T) => void] {
  const node: SignalNode<T> = { value, observers: undefined, equals: options?.equals ?? defaultEquals }

  const read = () => {
    track(node)

    return node.value
  }

  const write = (next: T) => {
    if (node.equals !== false && node.equals(node.value, next))
      return

    node.value = next
    notify(node)
  }

  return [read, write]
}

// A derived value, computed when read and cached until what it read changes.
export function memo<T>(fn: () => T, options?: SignalOptions<T>): () => T {
  const node = computation(fn, undefined, options?.equals ?? defaultEquals)

  node.state = DIRTY

  return () => {
    if (node.state !== DISPOSED) {
      update(node)
      track(node)
    }

    return node.value as T
  }
}

// Runs `fn` once the current render is done, then again whenever what it read changes; never on the server.
export function effect(fn: () => void): void {
  if (serverRendering > 0)
    return

  const node = computation(fn, 'user', false)

  node.state = DIRTY
  enqueue(node)
}

// Runs `fn` now, then again whenever what it read changes: what the DOM bindings islands build run on.
export function renderEffect(fn: () => void): void {
  const node = computation(fn, 'render', false)

  run(node)
}

// Runs once, after the component's markup is in place.
export function onMount(fn: () => void): void {
  effect(() => untrack(fn))
}

// Runs when the computation or root it is registered in runs again or goes away.
export function onCleanup(fn: () => void): void {
  if (owner)
    (owner.cleanups ??= []).push(fn)
}

// Reads signals without making the current computation depend on them.
export function untrack<T>(fn: () => T): T {
  const previous = listener

  listener = undefined

  try {
    return fn()
  }
  finally {
    listener = previous
  }
}

// Whether a computation would depend on a signal read now.
export function tracking(): boolean {
  return listener !== undefined
}

// Applies every write `fn` makes, then runs the effects they touch once, before returning.
export function batch<T>(fn: () => T): T {
  batching++

  try {
    return fn()
  }
  finally {
    if (--batching === 0)
      flush()
  }
}

// An owner of its own: what `fn` creates lives until `dispose` is called.
export function root<T>(fn: (dispose: () => void) => T): T {
  const node: Owner = { owner, children: undefined, cleanups: undefined, state: CLEAN }
  const previousOwner = owner
  const previousListener = listener

  owner = node
  listener = undefined

  try {
    return fn(() => dispose(node))
  }
  finally {
    owner = previousOwner
    listener = previousListener
  }
}

// Runs every effect whose sources changed, now.
export function flush(): void {
  scheduled = false

  while (renderQueue.length > 0 || userQueue.length > 0) {
    const render = renderQueue
    const user = userQueue

    renderQueue = []
    userQueue = []

    for (const node of render)
      runEffect(node)

    for (const node of user)
      runEffect(node)
  }
}

// Effects created while `fn` runs are dropped: an island rendering on the server renders once.
export function renderOnServer<T>(fn: () => T): T {
  serverRendering++

  try {
    return untrack(fn)
  }
  finally {
    serverRendering--
  }
}

function computation<T>(fn: () => T, kind: Computation['effect'], equals: Equals<T>): Computation {
  const node: Computation = { fn, value: undefined, sources: [], observers: undefined, equals, effect: kind, owner, children: undefined, cleanups: undefined, state: CLEAN }

  if (owner)
    (owner.children ??= []).push(node)

  return node
}

function track(source: Source): void {
  if (!listener)
    return

  const sources = listener.sources

  // A source read again in the same run is already there, most often as the last one read.
  if (sources[sources.length - 1] === source || sources.includes(source))
    return

  sources.push(source)
  ;(source.observers ??= new Set()).add(listener)
}

function notify(source: Source): void {
  if (!source.observers)
    return

  for (const observer of source.observers)
    stale(observer, DIRTY)

  schedule()
}

function stale(node: Computation, state: typeof CHECK | typeof DIRTY): void {
  if (node.state >= state)
    return

  if (node.state === CLEAN && node.effect)
    enqueue(node)

  node.state = state

  if (node.observers) {
    for (const observer of node.observers)
      stale(observer, CHECK)
  }
}

function enqueue(node: Computation): void {
  if (node.effect === 'render')
    renderQueue.push(node)
  else
    userQueue.push(node)

  schedule()
}

function schedule(): void {
  if (scheduled || batching > 0)
    return

  scheduled = true
  queueMicrotask(flush)
}

// Brings a memo or effect up to date: checks the memos it read when one may have changed, runs it again when one did.
function update(node: Computation): void {
  if (node.state === CHECK) {
    for (const source of node.sources) {
      if ('fn' in source)
        update(source as Computation)

      if ((node.state as State) === DIRTY)
        break
    }
  }

  if (node.state === DIRTY)
    run(node)
  else if (node.state === CHECK)
    node.state = CLEAN
}

function runEffect(node: Computation): void {
  if (node.state === DISPOSED)
    return

  try {
    update(node)
  }
  catch (error) {
    console.error(error)
  }
}

function run(node: Computation): void {
  reset(node)

  const previousOwner = owner
  const previousListener = listener
  const previous = node.value

  owner = node
  listener = node

  try {
    node.value = node.fn()
  }
  finally {
    owner = previousOwner
    listener = previousListener
  }

  node.state = CLEAN

  // A memo whose value changed makes what read it run again.
  if (!node.effect && node.observers && (node.equals === false || !(node.equals as (previous: unknown, next: unknown) => boolean)(previous, node.value))) {
    for (const observer of node.observers)
      observer.state = DIRTY
  }
}

// Before running again: what the last run created goes away, and its sources are read afresh.
function reset(node: Computation): void {
  disposeChildren(node)

  for (const source of node.sources)
    source.observers?.delete(node)

  node.sources = []
}

function disposeChildren(node: Owner): void {
  if (node.children) {
    for (const child of node.children)
      dispose(child)

    node.children = undefined
  }

  if (node.cleanups) {
    const cleanups = node.cleanups

    node.cleanups = undefined

    for (const cleanup of cleanups)
      cleanup()
  }
}

function dispose(node: Owner): void {
  if (node.state === DISPOSED)
    return

  disposeChildren(node)

  if ('sources' in node) {
    for (const source of (node as Computation).sources)
      source.observers?.delete(node as Computation)

    ;(node as Computation).sources = []
  }

  node.state = DISPOSED
}
