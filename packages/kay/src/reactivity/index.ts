// Kay v2 reactive kernel: push-pull doubly-linked-list dependency graph.
// Glitch-free lazy computed values, O(1) link/unlink, compact internal fields for tiny bundle size.

import type { DepNode, Link, Owned, Owner, ReadonlySignal, Signal, SubNode } from './graph'
import { adopt, linkSub, throwErrors, unadopt, unlinkAll, unlinkRemaining, unobserve } from './graph'

export type { IdScope, Owner, ReadonlySignal, Signal } from './graph'

const enum F {
  CLEAN = 0,
  CHECK = 1,
  DIRTY = 2,
  RUNNING = 4,
  DISPOSED = 8,
  COMPUTED = 16,
  EFFECT = 32,
  QUEUED = 64,
  // A computed nothing subscribes to: it keeps its deps list but stays out of its sources' subscriber lists, checking versions on read.
  UNOBSERVED = 128,
  // Queued for the current flush round (distinct from QUEUED, which marks the next round).
  PENDING = 256,
}

let currentSub: SubNode | undefined
let currentOwner: Owner | undefined
let globalEpoch = 0
let batchDepth = 0
let q: SubNode[] = []
let qNext: SubNode[] = []
let flushing = false
// Signal writes so far: an unobserved computed that checked at the same count can skip its version walk.
let writes = 0
// Bumped after a flush that threw so observed computeds still left DIRTY/CHECK re-propagate downstream on recovery.
let propWave = 0

// A child effect can sit ahead of its parent in the queue; the parent runs first, since its run may dispose the child.
function runParentFirst(sub: SubNode): void {
  sub.f &= ~F.PENDING
  for (let o = sub.o; o; o = o.o) {
    if (o.f & (F.PENDING | F.QUEUED)) {
      runParentFirst(o as unknown as SubNode)
      break
    }
  }
  if (!(sub.f & F.DISPOSED) && shouldRun(sub))
    sub.r()
}

function enqueue(sub: SubNode): void {
  if (sub.f & (F.QUEUED | F.DISPOSED))
    return
  sub.f |= F.QUEUED
  q.push(sub)
}

function propagate(dep: DepNode, flag: number): void {
  for (let l = dep.s; l; l = l.ns) {
    const sub = l.s
    const f = sub.f
    if (f & F.DISPOSED)
      continue
    const prev = f & (F.DIRTY | F.CHECK)
    if (prev < flag)
      sub.f = (f & ~(F.DIRTY | F.CHECK)) | flag
    if (f & F.EFFECT) {
      enqueue(sub)
    }
    else if (f & F.COMPUTED) {
      const comp = sub as ComputedNode<unknown>
      if (prev === F.CLEAN || comp.pw !== propWave) {
        comp.pw = propWave
        propagate(comp, F.CHECK)
      }
    }
  }
}

// One effect throwing must not strand the rest of the queue: every node still runs, then a lone error is rethrown as is and several as one AggregateError.
function flush(): void {
  if (flushing || batchDepth > 0)
    return
  flushing = true
  const errors: unknown[] = []
  try {
    let rounds = 0
    while (q.length > 0) {
      if (++rounds > 1000) {
        errors.push(new Error('kay: reactive cycle'))
        break
      }
      const round = q
      q = qNext
      qNext = round
      for (const node of round)
        node.f = (node.f & ~F.QUEUED) | F.PENDING
      for (const node of round) {
        if (node.f & F.PENDING) {
          try {
            runParentFirst(node)
          }
          catch (err) {
            errors.push(err)
          }
        }
      }
      round.length = 0
    }
  }
  finally {
    flushing = false
    for (const node of q)
      node.f &= ~F.QUEUED
    q.length = 0
    if (errors.length > 0)
      propWave++
  }
  throwErrors(errors)
}

function shouldRun(sub: SubNode): boolean {
  const f = sub.f
  if (f & F.DISPOSED)
    return false
  if (f & F.DIRTY)
    return true
  if (!(f & F.CHECK) && (!(f & F.UNOBSERVED) || (sub as ComputedNode<unknown>).w === writes))
    return false
  const w = writes
  for (let l = sub.d; l; l = l.nd) {
    const dep = l.d
    if (dep.f & F.COMPUTED) {
      const comp = dep as unknown as ComputedNode<unknown>
      if (shouldRun(comp))
        comp.r()
    }
    if (dep.v !== l.v) {
      sub.f |= F.DIRTY
      return true
    }
  }
  sub.f &= ~F.CHECK
  if (f & F.UNOBSERVED)
    (sub as ComputedNode<unknown>).w = w
  return false
}

class SignalNode<T> implements DepNode, Signal<T> {
  v = 0
  s: Link | undefined
  st: Link | undefined
  le = -1
  f = 0
  declare u?: (() => void) | undefined
  _v: T

  constructor(initial: T) {
    this._v = initial
  }

  get value(): T {
    if (currentSub)
      linkSub(this, currentSub)
    return this._v
  }

  set value(next: T) {
    if (Object.is(this._v, next))
      return
    this._v = next
    this.v++
    writes++
    if (this.s) {
      propagate(this, F.DIRTY)
      flush()
    }
  }

  peek(): T {
    return this._v
  }
}

class ComputedNode<T> implements DepNode, SubNode, ReadonlySignal<T> {
  v = 0
  s: Link | undefined
  st: Link | undefined
  le = -1
  f = F.COMPUTED | F.DIRTY | F.UNOBSERVED
  e = -1
  d: Link | undefined
  dt: Link | undefined
  c: Link | undefined
  po: Owned | undefined
  no: Owned | undefined
  o: Owner | undefined
  _f: () => T
  _v!: T
  _i = false
  w = -1
  pw = 0

  constructor(fn: () => T, owner: Owner | undefined) {
    this._f = fn
    if (owner)
      adopt(this, owner)
  }

  r(observe?: boolean): void {
    if (this.f & F.DISPOSED)
      return
    if (this.f & F.RUNNING)
      throw new Error('kay: cyclic computed')
    const prevSub = currentSub
    const prevOwner = currentOwner
    const w = writes
    // A first run for an observed reader links straight into its sources; roll back if the compute throws.
    const direct = observe && !this.d
    if (direct)
      this.f &= ~F.UNOBSERVED
    this.f = (this.f | F.RUNNING) & ~(F.DIRTY | F.CHECK)
    this.e = ++globalEpoch
    this.c = this.d
    currentSub = this
    currentOwner = undefined
    let ok = false
    try {
      const next = (this._f)()
      if (!this._i || !Object.is(this._v, next)) {
        this._v = next
        this._i = true
        this.v++
      }
      this.w = w
      ok = true
    }
    finally {
      unlinkRemaining(this)
      this.f &= ~F.RUNNING
      if (!ok) {
        this.f |= F.DIRTY
        if (direct && !this.s)
          unobserve(this)
      }
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }

  get value(): T {
    if (!(this.f & F.DISPOSED)) {
      const sub = currentSub
      if (shouldRun(this))
        this.r(!!sub && !(sub.f & (F.UNOBSERVED | F.DISPOSED)))
      if (!(this.f & F.DISPOSED)) {
        if (sub)
          linkSub(this, sub)
        if (!this.s && !(this.f & F.UNOBSERVED))
          unobserve(this)
      }
    }
    return this._v
  }

  peek(): T {
    if (!(this.f & F.DISPOSED) && shouldRun(this))
      this.r()
    return this._v
  }
}

// An effect is also the owner of what its run creates (effects, onCleanup), released before the next run.
class EffectNode implements SubNode, Owner {
  f = F.EFFECT | F.DIRTY
  e = -1
  d: Link | undefined
  dt: Link | undefined
  c: Link | undefined
  po: Owned | undefined
  no: Owned | undefined
  o: Owner | undefined
  fs: Owned | undefined
  cl: (() => void)[] | undefined
  _f: () => void | (() => void)

  constructor(fn: () => void | (() => void), owner: Owner | undefined) {
    this._f = fn
    if (owner)
      adopt(this, owner)
  }

  r(): void {
    if (this.f & F.DISPOSED)
      return
    this.f &= ~(F.DIRTY | F.CHECK)
    releaseOwned(this)
    if (this.f & F.DISPOSED)
      return
    const prevSub = currentSub
    const prevOwner = currentOwner
    this.f |= F.RUNNING
    this.e = ++globalEpoch
    this.c = this.d
    currentSub = this
    currentOwner = this
    try {
      const ret = (this._f)()
      if (typeof ret === 'function') {
        if (this.f & F.DISPOSED)
          ret()
        else
          ;(this.cl ??= []).unshift(ret)
      }
    }
    finally {
      unlinkRemaining(this)
      this.f &= ~F.RUNNING
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }
}

export function createOwner(parent: Owner | undefined = currentOwner): Owner {
  const owner: Owner = { f: 0 }
  if (parent)
    adopt(owner, parent)
  return owner
}

// Disposes an owner, an effect or a computed: leaves its owner, drops its sources, releases what it owns, runs its cleanup.
export function disposeOwner(node: Owner): void {
  const f = node.f
  if (f & F.DISPOSED)
    return
  node.f |= F.DISPOSED
  unadopt(node)
  if (f & (F.COMPUTED | F.EFFECT))
    unlinkAll(node as unknown as SubNode)
  if (!(f & F.COMPUTED))
    releaseOwned(node)
}

// Pops the head each time, so a cleanup that disposes a sibling cannot cut the walk short; every child and cleanup runs even if one throws.
function releaseOwned(owner: Owner): void {
  let errors: unknown[] | undefined
  let node: Owned | undefined
  while ((node = owner.fs)) {
    unadopt(node)
    try {
      disposeOwner(node as Owner)
    }
    catch (err) {
      ;(errors ??= []).push(err)
    }
  }

  const fns = owner.cl
  if (fns) {
    owner.cl = undefined
    for (let i = fns.length - 1; i >= 0; i--) {
      try {
        fns[i]!()
      }
      catch (err) {
        ;(errors ??= []).push(err)
      }
    }
  }

  throwErrors(errors)
}

export function runWithOwner<T>(owner: Owner | undefined, fn: () => T): T {
  const prevOwner = currentOwner
  const prevSub = currentSub
  currentOwner = owner
  currentSub = undefined
  try {
    return fn()
  }
  finally {
    currentOwner = prevOwner
    currentSub = prevSub
  }
}

export function getOwner(): Owner | undefined {
  return currentOwner
}

export function isTracking(): boolean {
  return currentSub !== undefined
}

/** Internal: true when the active subscriber will attach to any source it reads (observed and not disposed). */
export function isObserving(): boolean {
  return !!currentSub && !(currentSub.f & (F.UNOBSERVED | F.DISPOSED))
}

/** Internal: signal that runs `onUnsub` and bumps its version when its last subscriber detaches. */
export function watchedSignal<T>(initial: T, onUnsub: () => void): Signal<T> {
  const s = new SignalNode(initial)
  s.u = () => {
    s.v++
    writes++
    onUnsub()
  }
  return s
}

export function root<T>(fn: (dispose: () => void) => T): T {
  const owner = createOwner(undefined)
  return runWithOwner(owner, () => fn(() => disposeOwner(owner)))
}

export function signal<T>(initial: T): Signal<T> {
  return new SignalNode(initial)
}

export function computed<T>(fn: () => T): ReadonlySignal<T> {
  return new ComputedNode(fn, currentOwner)
}

declare const KAY_BROWSER: boolean | undefined

let serverRenders = 0

/** Internal: runs an island's server render, during which `effect` and `onMount` do nothing. */
export function renderOnServer<T>(fn: () => T): T {
  serverRenders++
  try {
    return fn()
  }
  finally {
    serverRenders--
  }
}

function noop(): void {}

// An effect skips the server render, as onMount does: a timer or request it starts would outlive the response. The client build defines KAY_BROWSER, which drops the check.
export function effect(fn: () => void | (() => void)): () => void {
  if ((typeof KAY_BROWSER === 'undefined' || !KAY_BROWSER) && serverRenders > 0)
    return noop
  if (process.env.NODE_ENV !== 'production' && !currentOwner && currentSub && (currentSub.f & F.COMPUTED))
    console.warn('kay: effect() created while a computed runs has no owner and is never disposed. Create it in a component or an effect.')
  const node = new EffectNode(fn, currentOwner)
  node.r()
  return () => disposeOwner(node)
}

// An error thrown by fn wins over one thrown by the effects it triggered, which is logged instead.
export function batch<T>(fn: () => T): T {
  batchDepth++
  let result: T
  try {
    result = fn()
  }
  catch (err) {
    if (--batchDepth === 0) {
      try {
        flush()
      }
      catch (flushErr) {
        console.error(flushErr)
      }
    }
    throw err
  }
  if (--batchDepth === 0)
    flush()
  return result
}

export function untrack<T>(fn: () => T): T {
  const prev = currentSub
  currentSub = undefined
  try {
    return fn()
  }
  finally {
    currentSub = prev
  }
}

export function onCleanup(fn: () => void): void {
  if (!currentOwner) {
    if (process.env.NODE_ENV !== 'production')
      console.warn('kay: onCleanup() called outside a component or effect never runs.')
    return
  }
  if (currentOwner.f & F.DISPOSED) {
    fn()
    return
  }
  ;(currentOwner.cl ??= []).push(fn)
}

// A render creates its nodes and inserts them in the same task, so a microtask later they are in the document.
export function onMount(fn: () => void | (() => void)): void {
  if (((typeof KAY_BROWSER === 'undefined' || !KAY_BROWSER) && serverRenders > 0) || typeof document === 'undefined')
    return
  const owner = currentOwner
  queueMicrotask(() => {
    if (owner && owner.f & F.DISPOSED)
      return
    runWithOwner(owner, () => {
      const cleanup = fn()
      if (typeof cleanup === 'function')
        onCleanup(cleanup)
    })
  })
}
