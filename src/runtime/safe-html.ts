import type { SafeHtml } from './checks'

// The runtime mark of `SafeHtml`: a string is vouched for by value, since a symbol or a class would not survive the JSON an island's props travel as.
// A repeat of markup the newer generation already holds counts for nothing, so a hot path cannot push other markup out.
// Markup vouched for at run time lives in two generations of up to 8M characters each: a use of one in the older moves it to the newer, and one used by neither for a whole generation is forgotten. An icon's stays for good.
const GENERATION = 2 ** 23
const forever = new Set<string>()
let young = new Set<string>()
let old = new Set<string>()
let size = 0

export function vouch(markup: string, always = false): SafeHtml {
  if (always) {
    forever.add(markup)
  }
  else if (!young.has(markup)) {
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
