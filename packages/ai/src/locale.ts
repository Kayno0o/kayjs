import { configError } from 'kay/library'

// A BCP 47 tag in its canonical case (`fr-fr` is `fr-FR`), or a config error naming the option that held a tag the standard refuses.
export function canonicalLocale(locale: string, what: string): string {
  try {
    const [tag] = Intl.getCanonicalLocales(locale)

    if (tag !== undefined)
      return tag
  }
  catch {}

  throw configError('ai', 'locale', `${what} is ${JSON.stringify(locale)}; it takes a BCP 47 tag such as fr or pt-BR`)
}

// The code speech providers take, ISO 639-1 such as `fr`: the tag's language, its region and script dropped.
export function speechLanguage(locale: string, what: string): string {
  const tag = canonicalLocale(locale, what)
  const dash = tag.indexOf('-')

  return dash === -1 ? tag : tag.slice(0, dash)
}

// The language as a model reads it in a prompt, its own English name such as `French (France)`, the tag itself when the runtime has no name for it.
export function languageName(locale: string, what: string): string {
  const tag = canonicalLocale(locale, what)

  return new Intl.DisplayNames('en', { type: 'language' }).of(tag) ?? tag
}
