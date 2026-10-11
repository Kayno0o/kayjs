const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i
const LOCALE_MAX_LENGTH = 35
const QUALITY = /;\s*q=([\d.]+)/

// A BCP 47 tag such as `fr` or `pt-BR`.
export function validLocale(tag: string): boolean {
  return tag.length <= LOCALE_MAX_LENGTH && LOCALE.test(tag)
}

// The tags of an `Accept-Language` header, most wanted first.
export function acceptedLocales(header: string): string[] {
  return header.split(',')
    .map((part, index) => ({ tag: before(part, ';').trim(), quality: Number(QUALITY.exec(part)?.[1] ?? 1), index }))
    .filter(entry => entry.quality > 0 && validLocale(entry.tag))
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(entry => entry.tag)
}

// The first of `available` matching a wanted tag, exactly or by its language alone, else the first of `available`.
export function pickLocale(available: readonly string[], wanted: readonly (string | null | undefined)[]): string {
  for (const tag of wanted) {
    if (!tag)
      continue

    const lower = tag.toLowerCase()
    const exact = available.find(locale => locale.toLowerCase() === lower)

    if (exact)
      return exact

    const sameLanguage = available.find(locale => language(locale) === language(tag))

    if (sameLanguage)
      return sameLanguage
  }

  return available[0]!
}

// The language of a tag alone, lowercase: `pt` for `pt-BR`.
export function language(tag: string): string {
  return before(tag, '-').toLowerCase()
}

function before(text: string, separator: string): string {
  const index = text.indexOf(separator)

  return index === -1 ? text : text.slice(0, index)
}
