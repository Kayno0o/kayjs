// Kay's reactive core: signals hold values, memos derive them, effects react to them.
// Writes apply at once; effects that depend on what changed run batched in a microtask, or right away through `flush()`.

type Equals<T> = false | ((previous: T, next: T) => boolean)

export interface SignalOptions<T> {
  // `false` notifies on every write; the default skips a write of the same value.
  equals?: Equals<T> | undefined
}

// A node others can depend on: a signal, or a memo.
interface Source {
  observers: Set<Computation> | undefined
}

interface SignalNode<T> extends Source {
  value: T
  equals: Equals<T>
  // Made outside any island's render, as at a module's top level: on the server it outlives the request, so what a request's render writes is kept for that request.
  shared: boolean
}

// What the server keeps per request it renders: the values its renders wrote to shared signals, its cookies and query, and where an error a `try` block caught goes.
export interface ServerScope {
  values: WeakMap<object, unknown>
  cookie: (name: string) => string | undefined
  // A query param as the page's `query` schema reads it, for `queryParam` and a persisted signal kept in the query.
  param: (name: string) => unknown
  report: (error: unknown) => void
  // The path of the page being rendered, percent-encoded as requested.
  path: string
}

const CLEAN = 0
// A source upstream may have changed: the sources are checked before running again.
const CHECK = 1
// A direct source changed: runs again.
const DIRTY = 2
const DISPOSED = 3

type State = typeof CLEAN | typeof CHECK | typeof DIRTY | typeof DISPOSED

// What owns child computations and cleanups: a root, a memo or an effect.
export interface Owner {
  owner: Owner | undefined
  children: Owner[] | undefined
  cleanups: (() => void)[] | undefined
  state: State
  // Set by `catchError`: what an effect under it throws goes there.
  catcher?: (error: unknown) => void
  // What a component provided, for what it renders to read.
  context?: Map<symbol, unknown>
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

// What the server's request scope, development's hot swap and an optimistic change each hook into signals, set by the function installing it, so a browser build that never calls one ships none of it.
interface Interceptor {
  // The server: what the request rendering now keeps of the shared signals it writes.
  values?: (() => WeakMap<object, unknown> | undefined) | undefined
  // An island rendering in development: a signal made, answering the value it starts with.
  created?: ((node: SignalNode<unknown>) => unknown) | undefined
  // An optimistic change applying: a signal about to be written, with how to write it back.
  writing?: ((node: SignalNode<unknown>, write: (value: unknown) => void) => void) | undefined
  // An optimistic change applying: a change made inside it, undone later, put a signal back from `from` to `to`.
  undone?: ((node: SignalNode<unknown>, from: unknown, to: unknown) => void) | undefined
}

let owner: Owner | undefined
let listener: Computation | undefined
let renderQueue: Computation[] = []
let userQueue: Computation[] = []
let scheduled = false
let batching = 0
// Set while an island renders on the server, where nothing reacts afterwards: effects there never run.
let serverRendering = 0
const MAX_ROUNDS = 100_000
let interceptor: Interceptor | undefined
let serverScope: (() => ServerScope | undefined) | undefined
let reporter: (error: unknown, island?: string) => void = error => console.error(error)
// Set while an island claims its server markup, with what waits for it to be done.
let hydrating = 0
let afterHydration: (() => void)[] = []

const defaultEquals = <T>(previous: T, next: T) => previous === next

export function createSignal<T>(value: T, options?: SignalOptions<T>): [read: () => T, write: (next: T) => void] {
  const node: SignalNode<T> = { value, observers: undefined, equals: options?.equals ?? defaultEquals, shared: serverRendering === 0 }

  if (interceptor?.created)
    node.value = interceptor.created(node as SignalNode<unknown>) as T

  const read = () => {
    track(node)

    const values = scopedValues(node)

    return values?.has(node) ? values.get(node) as T : node.value
  }

  const write = (next: T) => {
    const values = scopedValues(node)

    if (values) {
      values.set(node, next)

      return
    }

    if (node.equals !== false && node.equals(node.value, next))
      return

    interceptor?.writing?.(node as SignalNode<unknown>, write as (value: unknown) => void)
    node.value = next
    notify(node)
  }

  return [read, write]
}

// kay's own signal, such as a socket's status, which an edited island never takes back.
export function ownSignal<T>(value: T, options?: SignalOptions<T>): [read: () => T, write: (next: T) => void] {
  return unrecorded(() => createSignal(value, options))
}

// Runs `change`, giving back what undoes it: each signal it wrote goes back to what it held, unless something wrote it since. A change that throws is undone at once.
// Two changes over one signal undone out of order may leave the first one's value, its undo seeing the second's and keeping it.
export function undoable(change: () => void): () => void {
  const writes = new Map<SignalNode<unknown>, { before: unknown, write: (value: unknown) => void }>()
  const slot = interceptor ??= {}
  const { writing: outer, undone: parent } = slot
  let written: Map<SignalNode<unknown>, unknown> | undefined
  const undo = () => batch(() => {
    for (const [node, { before, write }] of writes) {
      if (written === undefined || node.value === written.get(node)) {
        parent?.(node, node.value, before)
        write(before)
      }
    }
  })

  // A change made inside another is part of it too, so undoing the outer one undoes both.
  slot.writing = (node, write) => {
    if (!writes.has(node))
      writes.set(node, { before: node.value, write })

    outer?.(node, write)
  }
  // What a change made inside this one puts back is this one's to undo still, and the enclosing change's too.
  slot.undone = (node, from, to) => {
    if (written?.has(node) && written.get(node) === from)
      written.set(node, to)

    parent?.(node, from, to)
  }

  try {
    batch(change)
  }
  catch (error) {
    undo()

    throw error
  }
  finally {
    slot.writing = outer
    slot.undone = parent
  }

  written = new Map([...writes.keys()].map(node => [node, node.value]))

  return undo
}

// A component's call: an owner of its own, so what it provides reaches what it renders and nothing beside it. `detached`, as an island is, it reads nothing provided above.
export function scope<T>(fn: () => T, detached = false): T {
  return runWithOwner(ownerUnder(detached ? undefined : owner, true), fn)
}

export function provideContext(key: symbol, value: unknown): void {
  if (!owner) {
    throw new Error('kay: provide() runs in a component\'s script, as it renders')
  }

  (owner.context ??= new Map()).set(key, value)
}

// The value the nearest component above provided under `key`, if any did.
export function readContext(key: symbol): { found: boolean, value?: unknown } {
  for (let node = owner; node; node = node.owner) {
    if (node.context?.has(key))
      return { found: true, value: node.context.get(key) }
  }

  return { found: false }
}

// The owner now, for a block rendered later to read what was provided where it was declared.
export function getOwner(): Owner | undefined {
  return owner
}

export function runWithOwner<T>(parent: Owner | undefined, fn: () => T): T {
  const previous = owner

  owner = parent

  try {
    return fn()
  }
  finally {
    owner = previous
  }
}

// Runs `fn` under an owner of its own, so an effect created in it that throws later hands the error to `handler` rather than the console.
export function catchError<T>(fn: (dispose: () => void) => T, handler: (error: unknown) => void): T {
  const node = ownerUnder(owner, true)

  node.catcher = handler

  return runWithOwner(node, () => fn(() => dispose(node)))
}

// An owner below `parent`; `attached`, it goes away with it.
function ownerUnder(parent: Owner | undefined, attached: boolean): Owner {
  const node: Owner = { owner: parent, children: undefined, cleanups: undefined, state: CLEAN }

  if (parent && attached)
    (parent.children ??= []).push(node)

  return node
}

// Logs an error no `try` block caught, or one it did, and hands it to what the page reports errors to, with the island it happened in when known.
export function reportError(error: unknown, island?: string): void {
  reporter(error, island)
}

// Installed by the browser's entry: where errors go besides the console.
export function setErrorReporter(report: (error: unknown, island?: string) => void): void {
  reporter = report
}

// Renders `fn` noting the signals it creates, the first ones taking `values` back in order; returns what reads their values now, for the next version of the island.
export function recordSignals<T>(fn: () => T, values?: unknown[]): { result: T, values: () => unknown[] } {
  const nodes: SignalNode<unknown>[] = []
  const slot = interceptor ??= {}
  const outer = slot.created
  let restoring = values && [...values]

  // A value kept from the last version while its kind matches the initial one; past the first mismatch the island's signals start afresh, its code having changed shape there.
  slot.created = (node) => {
    const { value } = node

    nodes.push(node)

    if (!restoring || restoring.length === 0)
      return value

    const kept = restoring.shift()

    // A signal made empty, as `signal<string>()`, takes whatever it held.
    if (value === undefined || (typeof kept === typeof value && (kept === null) === (value === null) && Array.isArray(kept) === Array.isArray(value)))
      return kept

    restoring = undefined

    return value
  }

  try {
    return { result: fn(), values: () => nodes.map(node => node.value) }
  }
  finally {
    slot.created = outer
  }
}

// Runs `fn` with the signals it creates left out of an island's recorded ones: kay's own, such as a socket's status, and those of a block that may render or not, or once per row, whose order says nothing about which is which.
export function unrecorded<T>(fn: () => T): T {
  const created = interceptor?.created

  if (!created)
    return fn()

  interceptor!.created = undefined

  try {
    return fn()
  }
  finally {
    interceptor!.created = created
  }
}

// Installed by the server: the scope of the request being rendered.
export function setServerScope(scope: () => ServerScope | undefined): void {
  serverScope = scope
  ;(interceptor ??= {}).values = () => scope()?.values
}

// The scope of the request rendering now, on the server.
export function currentServerScope(): ServerScope | undefined {
  return serverScope?.()
}

// Any write while a request renders, a page's script or an island's, stays with that request; the browser installs no scope.
function scopedValues(node: { shared: boolean }): WeakMap<object, unknown> | undefined {
  return node.shared ? interceptor?.values?.() : undefined
}

// Runs `fn` now, or once the islands claiming their server markup are done, so a value they did not render with never meets that markup.
export function whenHydrated(fn: () => void): void {
  if (hydrating > 0)
    afterHydration.push(fn)
  else
    fn()
}

// Brackets an island claiming its server markup.
export function hydrationStarted(): void {
  hydrating++
}

export function hydrationEnded(): void {
  if (--hydrating > 0)
    return

  const waiting = afterHydration

  afterHydration = []

  for (const fn of waiting)
    fn()
}

// A derived value, computed when read and cached until what it read changes.
export function memo<T>(fn: () => T, options?: SignalOptions<T>): () => T {
  const node = computation(fn, undefined, options?.equals ?? defaultEquals)
  const shared = serverRendering === 0

  node.state = DIRTY

  return () => {
    // A module's memo on the server would keep what one request's render derived for the next.
    if (shared && interceptor?.values?.() !== undefined)
      return untrack(fn)

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
  const node = ownerUnder(owner, false)

  return runWithOwner(node, () => untrack(() => fn(() => dispose(node))))
}

// Runs every effect whose sources changed, now.
export function flush(): void {
  scheduled = false

  let rounds = 0

  while (renderQueue.length > 0 || userQueue.length > 0) {
    // An effect writing what it reads, on every run, would never settle.
    if (++rounds > MAX_ROUNDS) {
      renderQueue = []
      userQueue = []
      console.error(`[kay] effects still writing what they read after ${MAX_ROUNDS} rounds: stopped`)

      return
    }

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
    let catcher: Owner | undefined = node.owner

    while (catcher && !catcher.catcher)
      catcher = catcher.owner

    if (!catcher) {
      reportError(error)

      return
    }

    // A `catch` block throwing in turn must not stop the effects still queued.
    try {
      catcher.catcher!(error)
    }
    catch (failure) {
      reportError(failure)
    }
  }
}

function run(node: Computation): void {
  reset(node)

  const previousOwner = owner
  const previousListener = listener
  const previous = node.value

  owner = node
  listener = node
  // Clean before it runs, so a write to what it already read marks it to run again, and a run that throws still runs on the next change.
  node.state = CLEAN

  try {
    node.value = node.fn()
  }
  finally {
    owner = previousOwner
    listener = previousListener
  }

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
