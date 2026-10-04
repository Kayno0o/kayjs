import type { I18nConfig } from '../config'
import type { LocaleSettings, Message, MessageTree, Translations } from '../runtime/i18n'
import type { LocaleState } from '../runtime/i18n.server'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { flattenMessages, localePath, splitLocale } from '../runtime/i18n'
import { localeState } from '../runtime/i18n.server'
import { bundled, importModule } from './bundle'

// Where a visitor's choice of locale is kept, read before their browser's languages.
export const LOCALE_COOKIE = 'kay-locale'
const MESSAGES_DIR = 'src/messages'
// A year: a choice of language is no session's.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const LOCALE_TAG = /^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i
const QUALITY = /;\s*q=([\d.]+)/

// The project's locales, read and checked once at boot.
export interface I18n {
  settings: LocaleSettings
  translations: Map<string, Translations>
}

export function messagesFile(root: string, config: I18nConfig, locale: string): string {
  return join(resolve(root, config.messages ?? MESSAGES_DIR), `${locale}.ts`)
}

// The settings the config gives, refused when they cannot serve a page: a default outside the locales, a tag no browser sends, a domain for no locale.
export function localeSettings(config: I18nConfig): LocaleSettings {
  if (config.locales.length === 0)
    throw new Error('kay: i18n lists no locales')

  for (const locale of config.locales) {
    if (!LOCALE_TAG.test(locale))
      throw new Error(`kay: i18n lists ${locale}, which is no BCP 47 tag such as fr or en-GB`)
  }

  if (!config.locales.includes(config.defaultLocale))
    throw new Error(`kay: i18n's defaultLocale ${config.defaultLocale} is not one of its locales: ${config.locales.join(', ')}`)

  for (const locale of Object.keys(config.domains ?? {})) {
    if (!config.locales.includes(locale))
      throw new Error(`kay: i18n gives a domain to ${locale}, which is not one of its locales: ${config.locales.join(', ')}`)
  }

  if (config.domains && config.prefixDefault)
    throw new Error('kay: i18n gives domains or prefixDefault, not both: with domains a locale has no prefix')

  const homeless = config.domains && config.locales.find(locale => config.domains![locale] === undefined)

  if (homeless !== undefined)
    throw new Error(`kay: i18n gives domains, but none to ${homeless}, which no request could then reach`)

  return { locales: config.locales, defaultLocale: config.defaultLocale, prefixDefault: config.prefixDefault === true, ...config.domains && { hosts: config.domains } }
}

// Every locale's messages, the default locale's standing in for a key another lacks.
export async function loadI18n(root: string, config: I18nConfig): Promise<I18n> {
  const settings = localeSettings(config)
  const bundle = bundled()
  const flat = new Map<string, Map<string, Message>>()

  for (const locale of settings.locales) {
    const file = messagesFile(root, config, locale)

    if (!(bundle ? file in bundle.modules : existsSync(file)))
      throw new Error(`kay: i18n lists ${locale}, so its messages go in ${relative(process.cwd(), file)}: export default defineMessages({ ... })`)

    const tree = (await importModule<{ default?: unknown }>(file)).default

    if (typeof tree !== 'object' || tree === null)
      throw new Error(`kay: ${relative(process.cwd(), file)} must export its messages by default: export default defineMessages({ ... })`)

    flat.set(locale, flattenMessages(tree as MessageTree))
  }

  const fallback = flat.get(settings.defaultLocale)!

  return { settings, translations: new Map([...flat].map(([locale, messages]) => [locale, { locale, messages, ...locale !== settings.defaultLocale && { fallback } }])) }
}

// The state a request runs in for that locale, the page's path given without its prefix.
export function stateFor(i18n: I18n, locale: string, path: string, request: Request): LocaleState {
  return { ...i18n.translations.get(locale)!, settings: i18n.settings, path, host: new URL(request.url).host }
}

// The locale a request's host serves, when locales go by domain.
export function hostLocale(settings: LocaleSettings, request: Request): string {
  const { host } = new URL(request.url)

  return Object.entries(settings.hosts ?? {}).find(([, served]) => served === host)?.[0] ?? settings.defaultLocale
}

// The locale a visitor wants when the URL does not say: the one they chose, kept in a cookie, then their browser's best match, then the default.
export function preferredLocale(settings: LocaleSettings, request: Request): string {
  const chosen = cookieLocale(request)

  if (chosen !== undefined && settings.locales.includes(chosen))
    return chosen

  return acceptedLocale(settings.locales, request.headers.get('accept-language')) ?? settings.defaultLocale
}

// The locale the visitor's cookie keeps, which may name one the site no longer has.
export function cookieLocale(request: Request): string | undefined {
  return new Bun.CookieMap(request.headers.get('cookie') ?? '').get(LOCALE_COOKIE) ?? undefined
}

// The locale an action runs in: its host's, its page's, as the Referer names it, or the visitor's preferred one.
export function requestLocale(settings: LocaleSettings, request: Request): string {
  if (settings.hosts)
    return hostLocale(settings, request)

  const referer = request.headers.get('referer')

  if (referer !== null && URL.canParse(referer) && new URL(referer).host === new URL(request.url).host) {
    const { locale } = splitLocale(settings, new URL(referer).pathname)

    if (locale !== undefined)
      return locale
  }

  return preferredLocale(settings, request)
}

// The best of the locales for an `Accept-Language` header: an exact tag first, then one of the same language, `fr` for `fr-CA` and the other way.
export function acceptedLocale(locales: readonly string[], header: string | null): string | undefined {
  const wanted = (header ?? '').split(',').map((part, index) => {
    const quality = QUALITY.exec(part)

    return { tag: before(part, ';').trim().toLowerCase(), quality: quality ? Number(quality[1]) : 1, index }
  }).filter(range => range.tag !== '' && range.tag !== '*' && range.quality > 0).sort((a, b) => b.quality - a.quality || a.index - b.index)

  for (const { tag } of wanted) {
    const language = before(tag, '-')
    const match = locales.find(locale => locale.toLowerCase() === tag) ?? locales.find(locale => before(locale.toLowerCase(), '-') === language)

    if (match !== undefined)
      return match
  }

  return undefined
}

function before(text: string, separator: string): string {
  const end = text.indexOf(separator)

  return end === -1 ? text : text.slice(0, end)
}

// Remembers the locale a visitor went to, so an unprefixed path takes them back to it.
export function localeCookie(locale: string, secure: boolean): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}

// A copy of a page path in one locale: the path it is served at, on its own host when locales go by domain, and the key its prerendered file goes by.
export interface LocaleCopy {
  locale: string | undefined
  path: string
  key: string
  host?: string
}

// Each locale's copy of a page path, or the path alone without i18n.
export function localeCopies(settings: LocaleSettings | undefined, path: string): LocaleCopy[] {
  if (!settings)
    return [{ locale: undefined, path, key: path }]

  return settings.locales.map((locale) => {
    const served = settings.hosts ? path : localePath(settings, path, locale)

    return { locale, path: served, key: prerenderKey(settings, locale, served), ...settings.hosts && { host: settings.hosts[locale] } }
  })
}

// The key a prerendered page is kept under: its path, under its locale's segment when locales go by domain and share their paths.
export function prerenderKey(settings: LocaleSettings | undefined, locale: string | undefined, path: string): string {
  return settings?.hosts && locale !== undefined ? `/${locale}${path === '/' ? '' : path}` : path
}

// The messages a page's islands use, with what the browser needs to build links in its locale; nothing outside a request served in one.
export function messagesScript(keys: Set<string>, first: boolean): string {
  const state = localeState()

  if (!state || (keys.size === 0 && !first))
    return ''

  const messages = Object.fromEntries([...keys].flatMap((key) => {
    const message = state.messages.get(key) ?? state.fallback?.get(key)

    return message === undefined ? [] : [[key, message]]
  }))
  const payload = first ? { locale: state.locale, settings: state.settings, messages } : { messages }

  return `<script type="application/json" data-kay-i18n>${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>`
}
