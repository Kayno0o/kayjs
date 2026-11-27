// Internal dependency-graph links, flags, and ownership list primitives for the reactive kernel.

const enum F {
  DISPOSED = 8,
  COMPUTED = 16,
  UNOBSERVED = 128,
}

export interface Link {
  d: DepNode
  s: SubNode
  v: number // dep version at link time
  e: number // sub run epoch
  pd: Link | undefined
  nd: Link | undefined
  ps: Link | undefined
  ns: Link | undefined
}

export interface DepNode {
  v: number // version
  s: Link | undefined // subs head
  st: Link | undefined // subs tail
  le: number // lastEpoch
  f: number // flags (0 on SignalNode, bitmask on ComputedNode)
  u?: (() => void) | undefined // called when the last subscriber detaches
}

// Anything an owner holds: a child owner, an effect or a computed.
export interface Owned {
  f: number // flags
  o?: Owner | undefined // owner
  po?: Owned | undefined // prevOwned
  no?: Owned | undefined // nextOwned
}

export interface SubNode extends Owned {
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
  fs?: Owned | undefined // first owned
  cl?: (() => void)[] | undefined // cleanups
  cx?: Map<symbol, unknown> | undefined // context values provided at this owner
  id?: IdScope | undefined // deterministic useId() scope
  eh?: ((error: unknown) => void) | undefined // error handler of a <Catch>
}

export interface Signal<T> {
  value: T
  peek(): T
}

export interface ReadonlySignal<T> {
  readonly value: T
  peek(): T
}

export function linkSub(dep: DepNode, sub: SubNode): void {
  if (sub.f & F.DISPOSED)
    return

  const e = sub.e
  if (dep.le === e)
    return

  // A nested computed or effect may have bumped dep.le past sub.e; scan links already added in this run to avoid duplicates.
  if (dep.le > e) {
    for (let l = sub.d; l && l !== sub.c; l = l.nd) {
      if (l.d === dep) {
        dep.le = e
        return
      }
    }
  }

  dep.le = e

  const cur = sub.c
  if (cur && cur.d === dep) {
    cur.e = e
    cur.v = dep.v
    sub.c = cur.nd
    return
  }

  const link: Link = {
    d: dep,
    s: sub,
    v: dep.v,
    e,
    pd: undefined,
    nd: undefined,
    ps: undefined,
    ns: undefined,
  }

  if (!(sub.f & F.UNOBSERVED))
    addSub(link)

  if (cur) {
    const prev = cur.pd
    link.pd = prev
    link.nd = cur
    cur.pd = link
    if (prev)
      prev.nd = link
    else
      sub.d = link
  }
  else {
    const tail = sub.dt
    link.pd = tail
    if (tail)
      tail.nd = link
    else
      sub.d = link
    sub.dt = link
  }
}

// Puts a link at the end of its source's subscriber list; a computed gaining its first subscriber follows its own sources again.
export function addSub(link: Link): void {
  const dep = link.d
  const tail = dep.st
  link.ps = tail
  link.ns = undefined
  if (tail) {
    tail.ns = link
    dep.st = link
    return
  }
  dep.s = dep.st = link
  if (dep.f & F.UNOBSERVED) {
    const comp = dep as unknown as SubNode
    comp.f &= ~F.UNOBSERVED
    for (let l = comp.d; l; l = l.nd)
      addSub(l)
  }
}

export function unobserve(comp: SubNode): void {
  comp.f |= F.UNOBSERVED
  for (let l = comp.d; l; l = l.nd)
    removeSub(l)
}

// Takes a link out of its source's subscriber list; a computed losing its last subscriber lets go of its own sources.
export function removeSub(link: Link): void {
  const { d, ps, ns } = link
  if (ps)
    ps.ns = ns
  else
    d.s = ns
  if (ns)
    ns.ps = ps
  else
    d.st = ps
  link.ps = link.ns = undefined
  if (!d.s) {
    if ((d.f & (F.COMPUTED | F.UNOBSERVED)) === F.COMPUTED)
      unobserve(d as unknown as SubNode)
    else if (d.u)
      d.u()
  }
}

function unlink(l: Link): void {
  const { s, pd, nd } = l
  if (pd)
    pd.nd = nd
  else
    s.d = nd
  if (nd)
    nd.pd = pd
  else
    s.dt = pd
  if (!(s.f & F.UNOBSERVED))
    removeSub(l)
}

export function unlinkRemaining(sub: SubNode): void {
  let l = sub.c
  const e = sub.e
  sub.c = undefined
  while (l) {
    const next = l.nd
    if (l.e !== e)
      unlink(l)
    l = next
  }
}

export function unlinkAll(sub: SubNode): void {
  let l = sub.d
  sub.d = sub.dt = sub.c = undefined
  if (sub.f & F.UNOBSERVED)
    return
  while (l) {
    const next = l.nd
    removeSub(l)
    l = next
  }
}

// A node adopted by a disposed owner is born disposed; otherwise it joins the head of the owner's list.
export function adopt(node: Owned, owner: Owner): void {
  if (owner.f & F.DISPOSED) {
    node.f |= F.DISPOSED
    return
  }
  node.o = owner
  const first = owner.fs
  node.no = first
  if (first)
    first.po = node
  owner.fs = node
}

export function unadopt(node: Owned): void {
  const owner = node.o
  if (!owner)
    return
  const { po, no } = node
  if (po)
    po.no = no
  else if (owner.fs === node)
    owner.fs = no
  if (no)
    no.po = po
  node.o = node.po = node.no = undefined
}

export function throwErrors(errors: unknown[] | undefined): void {
  if (!errors || !errors.length)
    return
  if (errors.length === 1)
    throw errors[0]
  throw new AggregateError(errors, `kay: ${errors.length} errors`)
}
