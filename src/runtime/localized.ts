// A site default written once, or once per locale: `'What the site is'` or `{ en: 'What the site is', fr: 'Ce qu\'est le site' }`.
export type Localized = string | Readonly<Record<string, string>>

// The text for a locale: a locale the record lacks reads the default locale's, then the first one written.
export function localizedText(value: Localized | undefined, locale: string | undefined, defaultLocale: string | undefined): string | undefined {
  if (typeof value !== 'object')
    return value

  return (locale === undefined ? undefined : value[locale]) ?? (defaultLocale === undefined ? undefined : value[defaultLocale]) ?? Object.values(value)[0]
}

// Every text a value holds, one per locale.
export function localizedTexts(value: Localized | undefined): string[] {
  if (value === undefined)
    return []

  return typeof value === 'string' ? [value] : Object.values(value)
}
