import type { CheckedHref, Register } from './checks'

// What the server and the browser share of i18n: message lookup, formatting through `Intl`, and locale paths.

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
// A message by the count it is given: `{ one: '{count} item', other: '{count} items' }`, `zero` taking 0 even where the language has no such form.
export type Plural = { readonly other: string } & Readonly<Partial<Record<Exclude<PluralCategory, 'other'>, string>>>
export type Message = string | Plural

export interface MessageTree {
  readonly [key: string]: Message | MessageTree
}

// What a `{name}` placeholder takes: text as it is, a number or a date formatted for the locale.
export type MessageValue = string | number | Date

// How the site's locales reach the URL.
export interface LocaleSettings {
  locales: readonly string[]
  defaultLocale: string
  // The default locale under its own prefix too, `/fr/about` rather than `/about`.
  prefixDefault: boolean
  // The host serving each locale, when locales go by domain rather than prefix.
  hosts?: Readonly<Record<string, string>> | undefined
  // A page's path in the locales translating it, by the pattern kay serves the page under: `{ '/about': { fr: '/a-propos' } }`.
  paths?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined
}

// What a translation reads: the messages of its locale by dotted key, then the default locale's for a key it lacks.
export interface Translations {
  locale: string
  messages: ReadonlyMap<string, Message>
  fallback?: ReadonlyMap<string, Message>
}

// The default locale's messages, which every other locale's mirror, once `kay check` registers them.
type Messages = Register extends { messages: infer Tree extends MessageTree } ? Tree : never
export type Locale = Register extends { locales: infer Names extends string } ? Names : string

type IsPlural<Value> = Value extends { readonly other: string } ? Exclude<keyof Value, PluralCategory> extends never ? true : false : false
type KeysOf<Tree, Prefix extends string = ''> = { [Key in keyof Tree & string]: Tree[Key] extends string ? `${Prefix}${Key}` : IsPlural<Tree[Key]> extends true ? `${Prefix}${Key}` : KeysOf<Tree[Key], `${Prefix}${Key}.`> }[keyof Tree & string]
type At<Tree, Key extends string> = Key extends `${infer Head}.${infer Rest}` ? Head extends keyof Tree ? At<Tree[Head], Rest> : never : Key extends keyof Tree ? Tree[Key] : never
type Placeholders<Text> = Text extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never
type ParamsOf<Value> = Value extends string ? Placeholders<Value> : 'count' | Placeholders<Value[keyof Value] & string>
// A plural's `count` picks its form, so it is a number; any other placeholder takes text, a number or a date.
type ParamArgs<Value, Names extends string = ParamsOf<Value>> = [Names] extends [never] ? [] : [params: { [Name in Names]: Name extends 'count' ? Value extends string ? MessageValue : number : MessageValue }]

export type MessageKey = [Messages] extends [never] ? string : KeysOf<Messages>
// A key of the default locale's messages, then the values its placeholders take; without registered messages, any key and any values.
export type Translate = [Messages] extends [never]
  ? (key: string, params?: Record<string, MessageValue>) => string
  : <Key extends KeysOf<Messages>>(key: Key, ...params: ParamArgs<At<Messages, Key>>) => string
// The messages `b` lays over `a`, key by key: a library's catalog under the app's, which `kay check` registers when an extension brings messages.
export type MergeMessages<A, B> = {
  readonly [Key in keyof A | keyof B]: Key extends keyof B
    ? Key extends keyof A ? IsGroup<A[Key]> extends true ? IsGroup<B[Key]> extends true ? MergeMessages<A[Key], B[Key]> : B[Key] : B[Key] : B[Key]
    : Key extends keyof A ? A[Key] : never
}
type IsGroup<Value> = Value extends string ? false : IsPlural<Value> extends true ? false : true
export type Localize = <const Href extends string>(href: Href & CheckedHref<Href>, locale?: Locale) => string

const PLACEHOLDER = /\{(\w+)\}/g

const PLURAL_CATEGORIES: ReadonlySet<string> = new Set<PluralCategory>(['zero', 'one', 'two', 'few', 'many', 'other'])
const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const pluralRules = new Map<string, Intl.PluralRules>()
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()
const listFormats = new Map<string, Intl.ListFormat>()
const directions = new Map<string, Direction>()
// Scripts written right to left: Arabic, Hebrew, Thaana, Syriac, N'Ko, Adlam, Hanifi Rohingya, Mandaic and Samaritan.
const RTL_SCRIPTS: ReadonlySet<string> = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr'])
// Where a link's path ends and its query or fragment starts.
const PATH_END = /[?#]/
const OPTIONAL_MARK = /\?$/
// Each unit with its length in seconds, a relative time taking the largest one the span reaches.
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]]

export type Direction = 'ltr' | 'rtl'

// What `formatRelativeTime` takes besides `Intl`'s options: the moment the time is relative to, now by default.
export interface RelativeTimeOptions extends Intl.RelativeTimeFormatOptions {
  now?: Date | number | undefined
}

// The message files' default export: it keeps the literal text, so `t` knows each message's placeholders.
export function defineMessages<const Tree extends MessageTree>(messages: Tree): Tree {
  return messages
}

// The tree as dotted keys, `nav.home`, each leaf a message.
export function flattenMessages(tree: MessageTree, prefix = ''): Map<string, Message> {
  const flat = new Map<string, Message>()

  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string' || isPlural(value)) {
      flat.set(`${prefix}${key}`, value)

      continue
    }

    for (const [inner, message] of flattenMessages(value, `${prefix}${key}.`))
      flat.set(inner, message)
  }

  return flat
}

// An object of plural forms only, `other` among them; anything else is a group of messages.
export function isPlural(value: unknown): value is Plural {
  return typeof value === 'object' && value !== null && typeof (value as Plural).other === 'string' && Object.keys(value).every(key => PLURAL_CATEGORIES.has(key))
}

// The message at `key` with its placeholders filled.
export function translate(translations: Translations, key: string, params: Record<string, MessageValue> = {}): string {
  const message = translations.messages.get(key) ?? translations.fallback?.get(key)

  if (message === undefined)
    return missingMessage(key)

  const text = typeof message === 'string' ? message : pluralForm(translations.locale, message, params.count)

  return text.replace(PLACEHOLDER, (placeholder, name: string) => name in params ? formatValue(translations.locale, params[name]!) : placeholder)
}

// A key no locale has, which `kay check` cannot see when the key is computed. Production shows it as itself rather than failing the page; development and tests fail the render on the server, and log it in the browser, where a test page fails on it.
function missingMessage(key: string): string {
  if (process.env.NODE_ENV === 'production')
    return key

  if (typeof window === 'undefined')
    throw new Error(`kay: no locale has the message ${JSON.stringify(key)}; production would show the key itself`)

  console.error(`[kay] no locale has the message ${JSON.stringify(key)}; production shows the key itself`)

  return key
}

function pluralForm(locale: string, plural: Plural, count: MessageValue | undefined): string {
  if (typeof count !== 'number')
    return plural.other

  if (count === 0 && plural.zero !== undefined)
    return plural.zero

  return plural[cached(pluralRules, locale, () => new Intl.PluralRules(locale)).select(count)] ?? plural.other
}

function formatValue(locale: string, value: MessageValue): string {
  if (typeof value === 'number')
    return formatNumber(locale, value)

  return value instanceof Date ? formatDate(locale, value) : value
}

export function formatNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return cached(numberFormats, `${locale}\n${options === undefined ? '' : JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options)).format(value)
}

// A date as the locale writes it, `medium` by default: `4 oct. 2026`.
export function formatDate(locale: string, value: Date | number, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return cached(dateFormats, `${locale}\n${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options)).format(value)
}

// A date relative to now in the largest unit it reaches, `3 days ago`, or a value in the unit given; `numeric: 'auto'` by default, so a day back reads `yesterday`.
export function formatRelativeTime(locale: string, value: Date | number, unitOrOptions?: Intl.RelativeTimeFormatUnit | RelativeTimeOptions, options?: Intl.RelativeTimeFormatOptions): string {
  const { now, ...format } = typeof unitOrOptions === 'object' ? unitOrOptions : { ...options, now: undefined }
  const formatter = cached(relativeFormats, `${locale}\n${JSON.stringify(format)}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', ...format }))

  if (typeof unitOrOptions === 'string')
    return formatter.format(Number(value), unitOrOptions)

  const seconds = (Number(value) - Number(now ?? Date.now())) / 1000
  const [unit, length] = RELATIVE_UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['second', 1]

  // Rounded alike either side of now, so a day and a half reads `2 days ago` as it reads `in 2 days`.
  return formatter.format(Math.sign(seconds) * Math.round(Math.abs(seconds) / length), unit)
}

// Items joined as the locale writes a list, `a, b and c`.
export function formatList(locale: string, items: Iterable<string>, options?: Intl.ListFormatOptions): string {
  return cached(listFormats, `${locale}\n${options === undefined ? '' : JSON.stringify(options)}`, () => new Intl.ListFormat(locale, options)).format(items)
}

// Which way a locale's script runs, `rtl` for Arabic, Hebrew, Persian or Urdu, read off the script the locale is most likely written in.
export function textDirection(locale: string): Direction {
  return cached(directions, locale, () => {
    try {
      return RTL_SCRIPTS.has(new Intl.Locale(locale).maximize().script ?? '') ? 'rtl' : 'ltr'
    }
    catch {
      return 'ltr'
    }
  })
}

// Building a formatter costs far more than using one, and a site formats with few options.
function cached<Value>(cache: Map<string, Value>, key: string, make: () => Value): Value {
  let value = cache.get(key)

  if (value === undefined)
    cache.set(key, value = make())

  return value
}

// The path in that locale, translated where the locale names the page its own way: under its prefix, bare for an unprefixed default, or on its own host when locales go by domain.
export function localePath(settings: LocaleSettings, path: string, locale: string, currentHost?: string): string {
  const translated = translatedPath(settings, path, locale)

  if (settings.hosts) {
    const host = settings.hosts[locale]

    // Protocol-relative, so a link to another host keeps the scheme the page came over, plain http in development.
    return host === undefined || host === currentHost ? translated : `//${host}${translated}`
  }

  if (locale === settings.defaultLocale && !settings.prefixDefault)
    return translated

  return `/${locale}${translated === '/' ? '' : translated}`
}

// A page's path as a locale writes it, `/a-propos` for `/about` in French, its params carried over; a path the locale does not translate stays as it is.
export function translatedPath(settings: LocaleSettings, path: string, locale: string): string {
  return repath(settings, path, locale, false)
}

// The page's path behind one a locale translates, `/about` for `/a-propos` in French.
export function untranslatedPath(settings: LocaleSettings, path: string, locale: string): string {
  return repath(settings, path, locale, true)
}

// The query and fragment go along; of several patterns taking the path, the one naming most of it outright wins, as the router picks `/blog/new` over `/blog/:slug`.
function repath(settings: LocaleSettings, href: string, locale: string, back: boolean): string {
  if (settings.paths === undefined)
    return href

  const end = href.search(PATH_END)
  const path = end === -1 ? href : href.slice(0, end)
  const slash = path.length > 1 && path.endsWith('/')
  const segments = segmentsOf(slash ? path.slice(0, -1) : path)
  let best: { target: string, params: Record<string, string>, named: number } | undefined

  for (const [pattern, translations] of Object.entries(settings.paths)) {
    const translated = translations[locale]

    if (translated === undefined)
      continue

    const [from, target] = back ? [translated, pattern] : [pattern, translated]
    const params: Record<string, string> = {}
    const named = matchSegments(segmentsOf(from), segments, params)

    if (named !== undefined && (best === undefined || named > best.named))
      best = { target, params, named }
  }

  if (best === undefined)
    return href

  const { target, params } = best
  const filled = segmentsOf(target).flatMap((segment) => {
    const name = segment === '*' ? '*' : segment.startsWith(':') ? segment.slice(1).replace(OPTIONAL_MARK, '') : undefined
    const value = name === undefined ? segment : params[name]

    return value === undefined || value === '' ? [] : [value]
  })

  return `/${filled.join('/')}${slash && filled.length > 0 ? '/' : ''}${end === -1 ? '' : href.slice(end)}`
}

function segmentsOf(path: string): string[] {
  return path === '/' || path === '' ? [] : path.split('/').slice(1)
}

// How many segments the pattern names outright when it takes the path, its params gathered; undefined when it does not take it.
function matchSegments(pattern: string[], path: string[], params: Record<string, string>): number | undefined {
  const [head, ...rest] = pattern

  if (head === undefined)
    return path.length === 0 ? 0 : undefined

  if (head === '*') {
    params['*'] = path.join('/')

    return 0
  }

  if (head.startsWith(':') && head.endsWith('?')) {
    const without = matchSegments(rest, path, params)

    if (without !== undefined)
      return without
  }

  const [segment, ...remaining] = path

  if (segment === undefined)
    return undefined

  if (head.startsWith(':')) {
    const named = matchSegments(rest, remaining, params)

    if (named !== undefined)
      params[head.slice(1).replace(OPTIONAL_MARK, '')] = segment

    return named
  }

  if (pathSegment(head) !== pathSegment(segment))
    return undefined

  const named = matchSegments(rest, remaining, params)

  return named === undefined ? undefined : named + 1
}

// A segment as a URL carries it, so `à-propos` written in the config and `%C3%A0-propos` sent by a browser are one.
export function pathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment))
  }
  catch {
    return segment
  }
}

// The locale a path's first segment names, and the path without it; a path with no locale prefix is the default locale's when it goes unprefixed.
export function splitLocale(settings: LocaleSettings, path: string): { locale: string | undefined, path: string } {
  const [, first = '', ...rest] = path.split('/')
  const prefixed = settings.locales.includes(first) && (first !== settings.defaultLocale || settings.prefixDefault)

  if (settings.hosts || !prefixed)
    return { locale: settings.hosts || settings.prefixDefault ? undefined : settings.defaultLocale, path }

  return { locale: first, path: `/${rest.join('/')}` }
}
