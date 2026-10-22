import type { SafeHtml } from './checks'

// The runtime mark of `SafeHtml`: a string is vouched for by value, since a symbol or a class would not survive the JSON an island's props travel as.
// Markup vouched for at run time lives in two generations of up to 8M characters each: a use of one in the older moves it to the newer, and one used by neither for a whole generation is forgotten. An icon's stays for good.
const GENERATION = 2 ** 23
const forever = new Set<string>()
let young = new Set<string>()
let old = new Set<string>()
let size = 0

// Set by markup an island hydrating cannot draw yet, such as Markdown whose renderer is loading, which stands in as text: the next `property` call leaves the server's own markup in place instead of writing it. A flag rather than a marker in the string, which would print wherever the string went.
let held = false

export function holdServerMarkup(): void {
  held = true
}

export function takeHeldMarkup(): boolean {
  const was = held

  held = false

  return was
}

export function vouch(markup: string, always = false): SafeHtml {
  if (always) {
    forever.add(markup)
  }
  else {
    young.add(markup)
    size += markup.length

    if (size > GENERATION) {
      old = young
      young = new Set()
      size = 0
    }
  }

  return markup as SafeHtml
}

// An icon's props with their markup vouched for for good.
export function vouchedIcon<T extends { innerHTML: string }>(icon: T): T {
  icon.innerHTML = vouch(icon.innerHTML, true)

  return icon
}

// Whether `value` is markup something vouched for with `trustHtml`, `sanitizeHtml` or an icon import; markup with nothing in it always is. A use keeps it unless `touch` is false.
export function isVouched(value: unknown, touch = true): value is SafeHtml {
  if (typeof value !== 'string')
    return false

  if (value === '' || forever.has(value) || young.has(value))
    return true

  if (!old.has(value))
    return false

  if (touch)
    vouch(value)

  return true
}
