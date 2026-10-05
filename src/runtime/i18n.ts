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
  hosts?: Readonly<Record<string, string>>
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
export type Localize = <const Href extends string>(href: Href & CheckedHref<Href>, locale?: Locale) => string

const PLACEHOLDER = /\{(\w+)\}/g

const PLURAL_CATEGORIES: ReadonlySet<string> = new Set<PluralCategory>(['zero', 'one', 'two', 'few', 'many', 'other'])
const numberFormats = new Map<string, Intl.NumberFormat>()
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const pluralRules = new Map<string, Intl.PluralRules>()

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

// Building a formatter costs far more than using one, and a site formats with few options.
function cached<Value>(cache: Map<string, Value>, key: string, make: () => Value): Value {
  let value = cache.get(key)

  if (value === undefined)
    cache.set(key, value = make())

  return value
}

// The path in that locale: under its prefix, bare for an unprefixed default, or on its own host when locales go by domain.
export function localePath(settings: LocaleSettings, path: string, locale: string, currentHost?: string): string {
  if (settings.hosts) {
    const host = settings.hosts[locale]

    // Protocol-relative, so a link to another host keeps the scheme the page came over, plain http in development.
    return host === undefined || host === currentHost ? path : `//${host}${path}`
  }

  if (locale === settings.defaultLocale && !settings.prefixDefault)
    return path

  return `/${locale}${path === '/' ? '' : path}`
}

// The locale a path's first segment names, and the path without it; a path with no locale prefix is the default locale's when it goes unprefixed.
export function splitLocale(settings: LocaleSettings, path: string): { locale: string | undefined, path: string } {
  const [, first = '', ...rest] = path.split('/')
  const prefixed = settings.locales.includes(first) && (first !== settings.defaultLocale || settings.prefixDefault)

  if (settings.hosts || !prefixed)
    return { locale: settings.hosts || settings.prefixDefault ? undefined : settings.defaultLocale, path }

  return { locale: first, path: `/${rest.join('/')}` }
}
