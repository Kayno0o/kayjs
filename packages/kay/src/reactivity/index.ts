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
  ls: SubNode | undefined // lastSub
  le: number // lastEpoch
  f?: number // flags (only on ComputedNode)
}

interface SubNode {
  f: number // flags
  e: number // epoch
  d: Link | undefined // deps head
  dt: Link | undefined // deps tail
  c: Link | undefined // cursor
  no: SubNode | undefined // nextOwned
  nq: SubNode | undefined // nextQueued
  cl: (() => void) | undefined // effect cleanup
  o: Owner | undefined // owner
  r(): void // run
}

export interface Owner {
  p: Owner | undefined // parent
  fc: Owner | undefined // firstChild
  ns: Owner | undefined // nextSibling
  fs: SubNode | undefined // firstSub
  cl: (() => void)[] | undefined // cleanups
  x: boolean // disposed
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
let qHead: SubNode | undefined
let qTail: SubNode | undefined
let flushing = false

function linkSub(dep: DepNode, sub: SubNode): void {
  if (dep.ls === sub && dep.le === sub.e)
    return

  dep.ls = sub
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
    ps: dep.st,
    ns: undefined,
  }

  if (dep.st !== undefined)
    dep.st.ns = link
  else
    dep.s = link
  dep.st = link

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

function unlink(l: Link): void {
  const { d, s, pd, nd, ps, ns } = l
  if (pd !== undefined)
    pd.nd = nd
  else
    s.d = nd
  if (nd !== undefined)
    nd.pd = pd
  else
    s.dt = pd
  if (ps !== undefined)
    ps.ns = ns
  else
    d.s = ns
  if (ns !== undefined)
    ns.ps = ps
  else
    d.st = ps
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
  while (l !== undefined) {
    const next = l.nd
    const { d, ps, ns } = l
    if (ps !== undefined)
      ps.ns = ns
    else
      d.s = ns
    if (ns !== undefined)
      ns.ps = ps
    else
      d.st = ps
    l = next
  }
}

function enqueue(sub: SubNode): void {
  if (sub.f & (QUEUED | DISPOSED))
    return
  sub.f |= QUEUED
  sub.nq = undefined
  if (qTail !== undefined) {
    qTail.nq = sub
    qTail = sub
  }
  else {
    qHead = qTail = sub
  }
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

function flush(): void {
  if (flushing || batchDepth > 0)
    return
  flushing = true
  try {
    let rounds = 0
    while (qHead !== undefined) {
      if (++rounds > 1000)
        throw new Error('kay: reactive cycle')
      let node: SubNode | undefined = qHead
      qHead = qTail = undefined
      while (node !== undefined) {
        const next: SubNode | undefined = node.nq
        node.nq = undefined
        node.f &= ~QUEUED
        if (!(node.f & DISPOSED) && shouldRun(node))
          node.r()
        node = next
      }
    }
  }
  finally {
    flushing = false
    qHead = qTail = undefined
  }
}

function shouldRun(sub: SubNode): boolean {
  const f = sub.f
  if (f & DIRTY)
    return true
  if (!(f & CHECK))
    return false
  let l = sub.d
  while (l !== undefined) {
    const dep = l.d
    if (dep.f !== undefined && (dep.f & COMPUTED)) {
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
  return false
}

class SignalNode<T> implements DepNode, Signal<T> {
  v = 0
  s: Link | undefined = undefined
  st: Link | undefined = undefined
  ls: SubNode | undefined = undefined
  le = -1
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
  ls: SubNode | undefined = undefined
  le = -1
  f = COMPUTED | DIRTY
  e = -1
  d: Link | undefined = undefined
  dt: Link | undefined = undefined
  c: Link | undefined = undefined
  no: SubNode | undefined = undefined
  nq: SubNode | undefined = undefined
  cl: (() => void) | undefined = undefined
  o: Owner | undefined = undefined
  _f: () => T
  _v!: T
  _i = false

  constructor(fn: () => T) {
    this._f = fn
  }

  r(): void {
    if (this.f & RUNNING)
      throw new Error('kay: cyclic computed')
    const prevSub = currentSub
    const prevOwner = currentOwner
    this.f = (this.f | RUNNING) & ~(DIRTY | CHECK)
    this.e = ++globalEpoch
    this.c = this.d
    currentSub = this
    currentOwner = undefined
    try {
      const next = (this._f)()
      if (!this._i || !Object.is(this._v, next)) {
        this._v = next
        this._i = true
        this.v++
      }
    }
    finally {
      unlinkRemaining(this)
      this.f &= ~RUNNING
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }

  get value(): T {
    if (shouldRun(this))
      this.r()
    if (currentSub !== undefined)
      linkSub(this, currentSub)
    return this._v
  }

  peek(): T {
    if (shouldRun(this))
      this.r()
    return this._v
  }
}

class EffectNode implements SubNode {
  f = EFFECT | DIRTY
  e = -1
  d: Link | undefined = undefined
  dt: Link | undefined = undefined
  c: Link | undefined = undefined
  no: SubNode | undefined = undefined
  nq: SubNode | undefined = undefined
  cl: (() => void) | undefined = undefined
  o: Owner | undefined
  _f: () => void | (() => void)

  constructor(fn: () => void | (() => void), owner: Owner | undefined) {
    this._f = fn
    this.o = owner
    if (owner !== undefined) {
      this.no = owner.fs
      owner.fs = this
    }
  }

  r(): void {
    if (this.f & DISPOSED)
      return
    if (this.cl !== undefined) {
      const fn = this.cl
      this.cl = undefined
      fn()
    }
    const prevSub = currentSub
    const prevOwner = currentOwner
    this.f = (this.f | RUNNING) & ~(DIRTY | CHECK)
    this.e = ++globalEpoch
    this.c = this.d
    currentSub = this
    currentOwner = this.o
    try {
      const ret = (this._f)()
      if (typeof ret === 'function')
        this.cl = ret
    }
    finally {
      unlinkRemaining(this)
      this.f &= ~RUNNING
      currentSub = prevSub
      currentOwner = prevOwner
    }
  }
}

export function createOwner(parent: Owner | undefined = currentOwner): Owner {
  const owner: Owner = {
    p: parent,
    fc: undefined,
    ns: undefined,
    fs: undefined,
    cl: undefined,
    x: false,
  }
  if (parent !== undefined) {
    owner.ns = parent.fc
    parent.fc = owner
  }
  return owner
}

export function disposeOwner(owner: Owner): void {
  if (owner.x)
    return
  owner.x = true

  let child = owner.fc
  owner.fc = undefined
  while (child !== undefined) {
    const next = child.ns
    child.ns = undefined
    disposeOwner(child)
    child = next
  }

  let sub = owner.fs
  owner.fs = undefined
  while (sub !== undefined) {
    const next = sub.no
    sub.no = undefined
    sub.f |= DISPOSED
    unlinkAll(sub)
    if (sub.cl !== undefined) {
      const fn = sub.cl
      sub.cl = undefined
      fn()
    }
    sub = next
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

export function root<T>(fn: (dispose: () => void) => T): T {
  const owner = createOwner(undefined)
  return runWithOwner(owner, () => fn(() => disposeOwner(owner)))
}

export function signal<T>(initial: T): Signal<T> {
  return new SignalNode(initial)
}

export function computed<T>(fn: () => T): ReadonlySignal<T> {
  return new ComputedNode(fn)
}

export function effect(fn: () => void | (() => void)): () => void {
  const node = new EffectNode(fn, currentOwner)
  node.r()
  return () => {
    if (node.f & DISPOSED)
      return
    node.f |= DISPOSED
    unlinkAll(node)
    if (node.cl !== undefined) {
      const cb = node.cl
      node.cl = undefined
      cb()
    }
  }
}

export function batch<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  }
  finally {
    if (--batchDepth === 0)
      flush()
  }
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
  if (currentOwner === undefined)
    return
  if (currentOwner.x) {
    fn()
    return
  }
  ;(currentOwner.cl ??= []).push(fn)
}

export function onMount(fn: () => void | (() => void)): void {
  if (typeof document === 'undefined')
    return
  const cleanup = untrack(fn)
  if (typeof cleanup === 'function')
    onCleanup(cleanup)
}
