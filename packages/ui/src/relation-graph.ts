import type { NewTab } from './outside'
import type { Tone } from './tone'

// What a RelationGraph draws at its middle: the item whose neighbours the graph shows.
export interface RelationNode {
  label: string
  // Makes the item a link.
  href?: string | undefined
  newTab?: NewTab | undefined
  tone?: Tone | undefined
  // Any CSS colour, replacing the tone's: the item and its line are drawn in it.
  color?: string | undefined
}

// One item around the middle, joined to it by a line, in the order the keyboard and screen readers read them.
export interface RelationNeighbour extends RelationNode {
  key: string | number
  // An item that points nowhere yet: drawn muted with a dashed line, never a link or a button.
  missing?: boolean | undefined
}

// Where the `index`th of `count` neighbours sits on the ring, in percent of the graph's side, the first at the top and the rest clockwise.
export function ringAt(index: number, count: number, radius = 36): { x: number, y: number } {
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2

  return { x: Math.round((50 + Math.cos(angle) * radius) * 100) / 100, y: Math.round((50 + Math.sin(angle) * radius) * 100) / 100 }
}

// The colour each tone gives `--node-color`, and the muted one of a missing item, on whichever element carries `data-tone` or `data-missing`.
export const NODE_TONES = 'data-[tone=neutral]:[--node-color:var(--color-muted)] data-[tone=accent]:[--node-color:var(--color-accent)] data-[tone=success]:[--node-color:var(--color-success)] data-[tone=warning]:[--node-color:var(--color-warning)] data-[tone=danger]:[--node-color:var(--color-danger)] data-[tone=info]:[--node-color:var(--color-info)] data-missing:[--node-color:var(--color-muted)]'
