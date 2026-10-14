import type { SafeHtml } from './checks'

// The runtime mark of `SafeHtml`: a string is vouched for by value, since a symbol or a class would not survive the JSON an island's props travel as.
// Markup vouched for at run time is kept while it is among the most recent 16M characters, as each use refreshes it; an icon's stays for good, as the installed sets are finite.
// Each string maps to the characters it counts for, none for good, in `globalThis`, so the bundle a test mounts and the test itself, or two copies of kay on a page, share what was vouched for.
const key = Symbol.for('kay.vouched')
const store = ((globalThis as { [key]?: { marks: Map<string, number>, size: number } })[key] ??= { marks: new Map(), size: 0 })

export function vouch(markup: string, forever = false): SafeHtml {
  const { marks } = store
  const before = marks.get(markup) ?? 0
  const counted = forever || (before === 0 && marks.has(markup)) ? 0 : markup.length

  store.size += counted - before
  marks.delete(markup)
  marks.set(markup, counted)

  for (const [text, size] of marks) {
    if (store.size <= 2 ** 24 || text === markup)
      break

    if (size) {
      marks.delete(text)
      store.size -= size
    }
  }

  return markup as SafeHtml
}

// Whether `value` is markup something vouched for with `trustHtml`, `sanitizeHtml` or an icon import; markup with nothing in it always is.
export function isVouched(value: unknown): value is SafeHtml {
  const size = typeof value === 'string' ? store.marks.get(value) : undefined

  if (size !== undefined)
    vouch(value as string, size === 0)

  return value === '' || size !== undefined
}
