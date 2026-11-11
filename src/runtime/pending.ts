import { announce } from './announce'

// What shows a `pending` block: it is hidden in the markup and unhidden here, so no style rule is involved and a strict `style-src` leaves it working.
// Each thing a form waits on counts apart, so the block stays shown until the last one ends: the in-place post, an `onSubmit` promise being held, and a call of the form's action.
export type PendingSource = 'post' | 'hold' | 'call'

const waiting = /* @__PURE__ */ new WeakMap<Element, Set<PendingSource>>()

export function pendingBlock(block: Element, source: PendingSource, on: boolean): void {
  let sources = waiting.get(block)

  if (!sources)
    waiting.set(block, sources = new Set())

  if (on)
    sources.add(source)
  else
    sources.delete(source)

  const showing = sources.size > 0

  // Judged by the attribute, as a page swap may have put it back on a block that is still waited on.
  if (showing === !block.hasAttribute('hidden'))
    return

  block.toggleAttribute('hidden', !showing)

  if (showing) {
    const text = block.textContent.trim()

    if (text !== '')
      announce(text, block)
  }
}

export function pendingBlocks(form: Element, source: PendingSource, on: boolean): void {
  for (const block of form.querySelectorAll('[data-kay-pending]'))
    pendingBlock(block, source, on)
}

// Follows the calls of a form's action, read reactively: an island's block shows while `action.pending()`.
export function pendingCall(block: Element, action: unknown): void {
  pendingBlock(block, 'call', typeof action === 'function' && (action as { pending?: () => boolean }).pending?.() === true)
}
