// Kay v2 reactive kernel: push-pull doubly-linked-list dependency graph.
// Glitch-free lazy computed values, O(1) link/unlink, compact internal fields for tiny bundle size.

const CLEAN = 0
const CHECK = 1
const DIRTY = 2
const RUNNING = 4
const DISPOSED = 8
const COMPUTED = 16
const EFFECT = 32
const QUEUED = 64
// A computed nothing subscribes to: it keeps its deps list but stays out of its sources' subscriber lists, checking versions on read.
const UNOBSERVED = 128
// Queued for the current flush round (distinct from QUEUED, which marks the next round).
const PENDING = 256

interface Link {
  d: DepNode
  s: SubNode
  v: number // dep version at link time
  e: number // sub run epoch
  pd: Link | undefined
  nd: Link | undefined
  ps: Link | undefined
  ns: Link | undefined
}

interface DepNode {
  v: number // version
  s: Link | undefined // subs head
  st: Link | undefined // subs tail
  le: number // lastEpoch
  f: number // flags (0 on SignalNode, bitmask on ComputedNode)
}

// Anything an owner holds: a child owner, an effect or a computed.
interface Owned {
  f: number // flags
  o: Owner | undefined // owner
  po: Owned | undefined // prevOwned
  no: Owned | undefined // nextOwned
  k: (() => void) | undefined // cleanup returned by the effect
}

interface SubNode extends Owned {
  e: number // epoch
  d: Link | undefined // deps head
  dt: Link | undefined // deps tail
  c: Link | undefined // cursor
  r(): void // run
}

export interface IdScope {
  p: string
  n: number
}

export interface Owner extends Owned {
  fs: Owned | undefined // first owned
  cl: (() => void)[] | undefined // cleanups
  cx?: Map<symbol, unknown> | undefined // context values provided at this owner
  id?: IdScope | undefined // deterministic useId() scope
}

export interface Signal<T> {
  value: T
  peek(): T
}

export interface ReadonlySignal<T> {
  readonly value: T
  peek(): T
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

function linkSub(dep: DepNode, sub: SubNode): void {
  if (dep.le === sub.e)
    return

  dep.le = sub.e

  const cur = sub.c
  if (cur !== undefined && cur.d === dep) {
    cur.e = sub.e
    cur.v = dep.v
    sub.c = cur.nd
    return
  }

  const link: Link = {
    d: dep,
    s: sub,
    v: dep.v,
    e: sub.e,
    pd: undefined,
    nd: undefined,
    ps: undefined,
    ns: undefined,
  }

  if (!(sub.f & UNOBSERVED))
    addSub(link)

  if (cur !== undefined) {
    const prev = cur.pd
    link.pd = prev
    link.nd = cur
    cur.pd = link
    if (prev !== undefined)
      prev.nd = link
    else
      sub.d = link
  }
  else {
    const tail = sub.dt
    link.pd = tail
    if (tail !== undefined)
      tail.nd = link
    else
      sub.d = link
    sub.dt = link
  }
}

// Puts a link at the end of its source's subscriber list; a computed gaining its first subscriber follows its own sources again.
function addSub(link: Link): void {
  const dep = link.d
  const tail = dep.st
  link.ps = tail
  link.ns = undefined
  if (tail !== undefined) {
    tail.ns = link
    dep.st = link
    return
  }
  dep.s = dep.st = link
  if (dep.f & UNOBSERVED) {
    const comp = dep as unknown as SubNode
    comp.f &= ~UNOBSERVED
    for (let l = comp.d; l !== undefined; l = l.nd)
      addSub(l)
  }
}

function unobserve(comp: SubNode): void {
  comp.f |= UNOBSERVED
  for (let l = comp.d; l !== undefined; l = l.nd)
    removeSub(l)
}

// Takes a link out of its source's subscriber list; a computed losing its last subscriber lets go of its own sources.
function removeSub(link: Link): void {
  const { d, ps, ns } = link
  if (ps !== undefined)
    ps.ns = ns
  else
    d.s = ns
  if (ns !== undefined)
    ns.ps = ps
  else
    d.st = ps
  link.ps = link.ns = undefined
  if (d.s === undefined && (d.f & (COMPUTED | UNOBSERVED)) === COMPUTED)
    unobserve(d as unknown as SubNode)
}

function unlink(l: Link): void {
  const { s, pd, nd } = l
  if (pd !== undefined)
    pd.nd = nd
  else
    s.d = nd
  if (nd !== undefined)
    nd.pd = pd
  else
    s.dt = pd
  if (!(s.f & UNOBSERVED))
    removeSub(l)
}

function unlinkRemaining(sub: SubNode): void {
  let l = sub.c
  const e = sub.e
  sub.c = undefined
  while (l !== undefined) {
    const next = l.nd
    if (l.e !== e)
      unlink(l)
    l = next
  }
}

function unlinkAll(sub: SubNode): void {
  let l = sub.d
  sub.d = sub.dt = sub.c = undefined
  if (sub.f & UNOBSERVED)
    return
  while (l !== undefined) {
    const next = l.nd
    removeSub(l)
    l = next
  }
}

// A child effect can sit ahead of its parent in the queue; the parent runs first, since its run may dispose the child.
function runParentFirst(sub: SubNode): void {
  sub.f &= ~PENDING
  for (let o = sub.o; o !== undefined; o = o.o) {
    if (o.f & (PENDING | QUEUED)) {
      runParentFirst(o as unknown as SubNode)
      break
    }
  }
  if (!(sub.f & DISPOSED) && shouldRun(sub))
    sub.r()
}

function enqueue(sub: SubNode): void {
  if (sub.f & (QUEUED | DISPOSED))
    return
  sub.f |= QUEUED
  q.push(sub)
}

function propagate(dep: DepNode, flag: number): void {
  let l = dep.s
  while (l !== undefined) {
    const sub = l.s
    const f = sub.f
    if (!(f & DISPOSED)) {
      if (f & EFFECT) {
        if ((f & (DIRTY | CHECK)) < flag)
          sub.f = (f & ~(DIRTY | CHECK)) | flag
        enqueue(sub)
      }
      else if (f & COMPUTED) {
        const prev = f & (DIRTY | CHECK)
        if (prev < flag) {
          sub.f = (f & ~(DIRTY | CHECK)) | flag
          if (prev === CLEAN)
            propagate(sub as unknown as DepNode, CHECK)
        }
      }
    }
    l = l.ns
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
        node.f = (node.f & ~QUEUED) | PENDING
      for (const node of round) {
        if (node.f & PENDING) {
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
      node.f &= ~QUEUED
    q.length = 0
  }
  if (errors.length === 1)
    throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, `kay: ${errors.length} effects threw`)
}

function shouldRun(sub: SubNode): boolean {
  const f = sub.f
  if (f & DISPOSED)
    return false
  if (f & DIRTY)
    return true
  if (!(f & CHECK) && (!(f & UNOBSERVED) || (sub as ComputedNode<unknown>).w === writes))
    return false
  const w = writes
  let l = sub.d
  while (l !== undefined) {
    const dep = l.d
    if (dep.f & COMPUTED) {
      const comp = dep as unknown as ComputedNode<unknown>
      if (shouldRun(comp))
        comp.r()
    }
    if (dep.v !== l.v) {
      sub.f |= DIRTY
      return true
    }
    l = l.nd
  }
  sub.f &= ~CHECK
  if (f & UNOBSERVED)
    (sub as ComputedNode<unknown>).w = w
  return false
}

class SignalNode<T> implements DepNode, Signal<T> {
  v = 0
  s: Link | undefined = undefined
  st: Link | undefined = undefined
  le = -1
  f = 0
  _v: T

  constructor(initial: T) {
    this._v = initial
  }

  get value(): T {
    if (currentSub !== undefined)
      linkSub(this, currentSub)
    return this._v
  }

  set value(next: T) {
    if (Object.is(this._v, next))
      return
    this._v = next
    this.v++
    writes++
    if (this.s !== undefined) {
      propagate(this, DIRTY)
      flush()
    }
  }

  peek(): T {
    return this._v
  }
}

class ComputedNode<T> implements DepNode, SubNode, ReadonlySignal<T> {
  v = 0
  s: Link | undefined = undefined
  st: Link | undefined = undefined
  le = -1
  f = COMPUTED | DIRTY | UNOBSERVED
  e = -1
  d: Link | undefined = undefined
  dt: Link | undefined = undefined
  c: Link | undefined = undefined
  po: Owned | undefined = undefined
  no: Owned | undefined = undefined
  k: (() => void) | undefined = undefined
  o: Owner | undefined = undefined
  _f: () => T
  _v!: T
  _i = false
  w = -1

  constructor(fn: () => T, owner: Owner | undefined) {
    this._f = fn
    if (owner !== undefined)
      adopt(this, owner)
  }

  r(observe?: boolean): void {
    if (this.f & DISPOSED)
      return
    if (this.f & RUNNING)
      throw new Error('kay: cyclic computed')
    const prevSub = currentSub
    const prevOwner = currentOwner
    const w = writes
    // A first run for an observed reader links straight into its sources; roll back if the compute throws.
    const direct = observe && this.d === undefined
    if (direct)
      this.f &= ~UNOBSERVED
    this.f = (this.f | RUNNING) & ~(DIRTY | CHECK)
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
      this.f &= ~RUNNING
      if (direct && !ok && this.s === undefined)
        unobserve(this)
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }

  get value(): T {
    if (!(this.f & DISPOSED)) {
      if (shouldRun(this))
        this.r(currentSub !== undefined && !(currentSub.f & UNOBSERVED))
      if (currentSub !== undefined && !(this.f & DISPOSED))
        linkSub(this, currentSub)
    }
    return this._v
  }

  peek(): T {
    if (!(this.f & DISPOSED) && shouldRun(this))
      this.r()
    return this._v
  }
}

// An effect is also the owner of what its run creates (effects, onCleanup), released before the next run.
class EffectNode implements SubNode, Owner {
  f = EFFECT | DIRTY
  e = -1
  d: Link | undefined = undefined
  dt: Link | undefined = undefined
  c: Link | undefined = undefined
  po: Owned | undefined = undefined
  no: Owned | undefined = undefined
  k: (() => void) | undefined = undefined
  o: Owner | undefined = undefined
  fs: Owned | undefined = undefined
  cl: (() => void)[] | undefined = undefined
  _f: () => void | (() => void)

  constructor(fn: () => void | (() => void), owner: Owner | undefined) {
    this._f = fn
    if (owner !== undefined)
      adopt(this, owner)
  }

  r(): void {
    if (this.f & DISPOSED)
      return
    this.f &= ~(DIRTY | CHECK)
    releaseOwned(this)
    if (this.k !== undefined) {
      const fn = this.k
      this.k = undefined
      fn()
    }
    if (this.f & DISPOSED)
      return
    const prevSub = currentSub
    const prevOwner = currentOwner
    this.f |= RUNNING
    this.e = ++globalEpoch
    this.c = this.d
    currentSub = this
    currentOwner = this
    try {
      const ret = (this._f)()
      if (typeof ret === 'function') {
        if (this.f & DISPOSED)
          ret()
        else
          this.k = ret
      }
    }
    finally {
      unlinkRemaining(this)
      this.f &= ~RUNNING
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }
}

// A node adopted by a disposed owner is born disposed; otherwise it joins the head of the owner's list.
function adopt(node: Owned, owner: Owner): void {
  if (owner.f & DISPOSED) {
    node.f |= DISPOSED
    return
  }
  node.o = owner
  const first = owner.fs
  node.no = first
  if (first !== undefined)
    first.po = node
  owner.fs = node
}

export function createOwner(parent: Owner | undefined = currentOwner): Owner {
  const owner: Owner = { f: 0, o: undefined, po: undefined, no: undefined, k: undefined, fs: undefined, cl: undefined }
  if (parent !== undefined)
    adopt(owner, parent)
  return owner
}

function unadopt(node: Owned): void {
  const owner = node.o
  if (owner === undefined)
    return
  const { po, no } = node
  if (po !== undefined)
    po.no = no
  else if (owner.fs === node)
    owner.fs = no
  if (no !== undefined)
    no.po = po
  node.o = node.po = node.no = undefined
}

// Disposes an owner, an effect or a computed: leaves its owner, drops its sources, releases what it owns, runs its cleanup.
export function disposeOwner(node: Owner): void {
  const f = node.f
  if (f & DISPOSED)
    return
  node.f |= DISPOSED
  unadopt(node)
  if (f & (COMPUTED | EFFECT))
    unlinkAll(node as unknown as SubNode)
  if (!(f & COMPUTED))
    releaseOwned(node)
  if (node.k !== undefined) {
    const fn = node.k
    node.k = undefined
    fn()
  }
}

// Pops the head each time, so a cleanup that disposes a sibling cannot cut the walk short.
function releaseOwned(owner: Owner): void {
  let node: Owned | undefined
  while ((node = owner.fs) !== undefined) {
    unadopt(node)
    disposeOwner(node as Owner)
  }

  if (owner.cl !== undefined) {
    const fns = owner.cl
    owner.cl = undefined
    for (let i = fns.length - 1; i >= 0; i--)
      fns[i]!()
  }
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

export function effect(fn: () => void | (() => void)): () => void {
  if (process.env.NODE_ENV !== 'production' && currentOwner === undefined && currentSub !== undefined && (currentSub.f & COMPUTED))
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
  if (currentOwner === undefined) {
    if (process.env.NODE_ENV !== 'production')
      console.warn('kay: onCleanup() called outside a component or effect never runs.')
    return
  }
  if (currentOwner.f & DISPOSED) {
    fn()
    return
  }
  ;(currentOwner.cl ??= []).push(fn)
}

// A render creates its nodes and inserts them in the same task, so a microtask later they are in the document.
export function onMount(fn: () => void | (() => void)): void {
  if (typeof document === 'undefined')
    return
  const owner = currentOwner
  queueMicrotask(() => {
    if (owner !== undefined && owner.f & DISPOSED)
      return
    runWithOwner(owner, () => {
      const cleanup = fn()
      if (typeof cleanup === 'function')
        onCleanup(cleanup)
    })
  })
}
