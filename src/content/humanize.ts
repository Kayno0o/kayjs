// The words of a key: `publishedAt` gives `Published at`, `seoURL` gives `Seo URL`, an acronym keeping its capitals; `_` and `-` only separate.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z\d]+/g

// The same words the CMS labels a field with, `packages/cms/src/fields.ts`, which runs in the browser and cannot import this; `tests/entry-refusals.test.ts` holds the two together.
export function humanize(key: string): string {
  const words = (key.match(WORD) ?? [key]).map(word => word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()).join(' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}
