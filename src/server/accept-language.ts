// A BCP 47 tag such as `fr` or `pt-BR`.
export const LOCALE_TAG = /^[a-z]{2,3}(?:-[a-z\d]{1,8})*$/i
const LOCALE_MAX_LENGTH = 35
const QUALITY = /;\s*q=([\d.]+)/

export function validLocale(tag: string): boolean {
  return tag.length <= LOCALE_MAX_LENGTH && LOCALE_TAG.test(tag)
}

// The tags of an `Accept-Language` header, most wanted first, as written: `*`, malformed tags and those refused with `q=0` left out.
export function acceptedLocales(header: string): string[] {
  return header.split(',').map((part, index) => {
    const quality = QUALITY.exec(part)

    return { tag: before(part, ';').trim(), quality: quality ? Number(quality[1]) : 1, index }
  }).filter(range => range.quality > 0 && validLocale(range.tag)).sort((a, b) => b.quality - a.quality || a.index - b.index).map(range => range.tag)
}

// The first of `locales` matching a tag of `wanted`, taken in order: the same tag first, then one of the same language, `fr` for `fr-CA` and the other way.
export function matchLocale(locales: readonly string[], wanted: readonly string[]): string | undefined {
  for (const tag of wanted) {
    const lower = tag.toLowerCase()
    const language = before(lower, '-')
    const match = locales.find(locale => locale.toLowerCase() === lower) ?? locales.find(locale => before(locale.toLowerCase(), '-') === language)

    if (match !== undefined)
      return match
  }

  return undefined
}

function before(text: string, separator: string): string {
  const end = text.indexOf(separator)

  return end === -1 ? text : text.slice(0, end)
}
