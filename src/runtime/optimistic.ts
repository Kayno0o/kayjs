import type { SignalNode } from './reactive'
import { batch, interception } from './reactive'

// The changes made one after another over a signal that are still to be undone or released, oldest first.
const unsettled = new WeakMap<SignalNode<unknown>, Pending[]>()
const entries = new WeakMap<() => void, Pending>()

interface Pending {
  writes: Map<SignalNode<unknown>, { before: unknown }>
}

function dropPending(entry: Pending): void {
  for (const node of entry.writes.keys()) {
    const list = unsettled.get(node)
    const at = list?.indexOf(entry) ?? -1

    if (at !== -1)
      list!.splice(at, 1)
  }
}

// Lets go of what `undoable` keeps to undo a change in order, once the change is certain.
export function released(undo: () => void): void {
  const entry = entries.get(undo)

  if (entry === undefined)
    return

  entries.delete(undo)
  dropPending(entry)
}

// Runs `change`, giving back what undoes it: each signal it wrote goes back to what it held, unless something wrote it since. A change that throws is undone at once.
// Changes over one signal undone out of order end where they began: a change found overwritten by a later one still waiting hands that one the value it started from, so it puts the signal back to it if it is undone too. A change that is certain is `released`.
export function undoable(change: () => void): () => void {
  const writes = new Map<SignalNode<unknown>, { before: unknown, write: (value: unknown) => void }>()
  const slot = interception()
  const { writing: outer, undone: parent } = slot
  let written: Map<SignalNode<unknown>, unknown> | undefined
  const entry: Pending = { writes }
  const undo = () => batch(() => {
    for (const [node, { before, write }] of writes) {
      const list = unsettled.get(node)
      const at = list?.indexOf(entry) ?? -1

      const next = at === -1 ? undefined : list![at + 1]

      // A change still waiting after this one owns the signal now: it takes the value this one started from, whatever it wrote, a write of the value the signal held included.
      if (next !== undefined && written !== undefined) {
        next.writes.get(node)!.before = before
      }
      else if (written === undefined || node.value === written.get(node)) {
        parent?.(node, node.value, before)
        write(before)
      }
    }

    dropPending(entry)
  })

  // A change made inside another is part of it too, so undoing the outer one undoes both.
  slot.writing = (node, write) => {
    if (!writes.has(node)) {
      writes.set(node, { before: node.value, write })

      if (outer === undefined)
        (unsettled.get(node) ?? unsettled.set(node, []).get(node)!).push(entry)
    }

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

  if (outer === undefined)
    entries.set(undo, entry)

  return undo
}

// Runs `change` now and hands back what puts the signals it wrote back, `undo`, for when the work it shows fails, and `keep` for when it went through: the way to show at once the change a form posting in place makes, `kay:action-start` making it and `kay:action-error` undoing it. Changes made one after another and undone in any order end where they began.
// kept: free
export function optimistic(change: () => void): { undo: () => void, keep: () => void } {
  const undo = undoable(change)

  return { undo, keep: () => released(undo) }
}
