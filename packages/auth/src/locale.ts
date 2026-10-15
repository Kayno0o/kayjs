import { matchLocale } from 'kay/library'

export { acceptedLocales, validLocale } from 'kay/library'

// The first of `available` matching a wanted tag, exactly or by its language alone, else the first of `available`.
export function pickLocale(available: readonly string[], wanted: readonly (string | null | undefined)[]): string {
  return matchLocale(available, wanted.filter((tag): tag is string => typeof tag === 'string' && tag !== '')) ?? available[0]!
}

// The language of a tag alone, lowercase: `pt` for `pt-BR`.
export function language(tag: string): string {
  const end = tag.indexOf('-')

  return (end === -1 ? tag : tag.slice(0, end)).toLowerCase()
}
