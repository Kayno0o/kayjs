import type { I18nConfig, KayExtension } from '../config'
import type { LocaleSettings, Message, MessageTree, Translations } from '../runtime/i18n'
import type { LocaleState } from '../runtime/locale-state'
import type { Route } from './routes'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { throughLinks } from '../build/links'
import { KayError } from '../compiler/errors'
import { flattenMessages, localePath, pathSegment, splitLocale, translatedPath } from '../runtime/i18n'
import { localeState } from '../runtime/locale-state'
import { acceptedLocales, LOCALE_TAG, matchLocale } from './accept-language'
import { routerPath } from './base'
import { importModule } from './bundle'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'
import { projectSource } from './source'
import { INVALID_PARAMS } from './words'

// Where a visitor's choice of locale is kept, read before their browser's languages.
export const LOCALE_COOKIE = 'kay_locale'
// What kay named it before 1.52, read while visitors' cookies of a year are still out there.
const LEGACY_LOCALE_COOKIE = 'kay-locale'
const MESSAGES_DIR = 'src/messages'

// The language a site without `lang` is written in.
export const DEFAULT_LANG = 'en'
// A year: a choice of language is no session's.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

// The project's locales, read and checked once at boot.
export interface I18n {
  settings: LocaleSettings
  translations: Map<string, Translations>
  // Read without `i18n`, for the site's one language: its URLs carry no locale and its pages no alternates.
  implicit?: true
}

// A locale's catalog in the app, under src/messages unless `i18n.messages` moves it.
export function messagesFile(root: string, config: Pick<I18nConfig, 'messages'>, locale: string): string {
  return join(resolve(root, config.messages ?? MESSAGES_DIR), `${locale}.ts`)
}

// The catalogs the extensions give a locale, in the order they are listed, the app's own laid over them: a regional locale falls back to its language's catalog.
export function extensionMessageFiles(root: string, extensions: KayExtension[] | undefined, locale: string): string[] {
  const dash = locale.indexOf('-')
  const language = dash === -1 ? locale : locale.slice(0, dash)

  return (extensions ?? []).flatMap((extension) => {
    if (extension.messages === undefined)
      return []

    const dir = throughLinks(root, resolve(root, extension.messages))
    const regional = join(dir, `${locale}.ts`)

    // A regional locale such as `fr-CA` reads the catalog of its language when the extension has none of its own for the region.
    return [language === locale || existsSync(regional) ? regional : join(dir, `${language}.ts`)]
  })
}

// The settings the config gives, refused when they cannot serve a page: a default outside the locales, a tag no browser sends, a domain for no locale.
export function localeSettings(config: I18nConfig): LocaleSettings {
  if (config.locales.length === 0)
    throw new KayError('locales-invalid', 'kay: i18n lists no locales')

  for (const locale of config.locales) {
    if (!LOCALE_TAG.test(locale))
      throw new KayError('locales-invalid', `kay: i18n lists ${locale}, which is no BCP 47 tag such as fr or en-GB`)
  }

  if (!config.locales.includes(config.defaultLocale))
    throw new KayError('locales-invalid', `kay: i18n's defaultLocale ${config.defaultLocale} is not one of its locales: ${config.locales.join(', ')}`)

  for (const locale of Object.keys(config.domains ?? {})) {
    if (!config.locales.includes(locale))
      throw new KayError('locales-invalid', `kay: i18n gives a domain to ${locale}, which is not one of its locales: ${config.locales.join(', ')}`)
  }

  if (config.domains && config.prefixDefault)
    throw new KayError('locales-invalid', 'kay: i18n gives domains or prefixDefault, not both: with domains a locale has no prefix')

  const homeless = config.domains && config.locales.find(locale => config.domains![locale] === undefined)

  if (homeless !== undefined)
    throw new KayError('locales-invalid', `kay: i18n gives domains, but none to ${homeless}, which no request could then reach`)

  return { locales: config.locales, defaultLocale: config.defaultLocale, prefixDefault: config.prefixDefault === true, ...config.domains && { hosts: config.domains }, ...config.paths && { paths: translatedPaths(config) } }
}

// Each translated path with the params of the page's own, its segments written as a URL carries them.
function translatedPaths(config: I18nConfig): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(config.paths ?? {}).map(([pattern, translations]) => {
    if (!pattern.startsWith('/'))
      throw new KayError('locales-invalid', `kay: i18n.paths names ${pattern}, which is no path: write the page's as kay serves it, /blog/:slug`)

    const params = paramsOf(pattern)

    return [pattern, Object.fromEntries(Object.entries(translations).map(([locale, path]) => {
      if (!config.locales.includes(locale))
        throw new KayError('locales-invalid', `kay: i18n.paths translates ${pattern} for ${locale}, which is not one of its locales: ${config.locales.join(', ')}`)

      if (!path.startsWith('/'))
        throw new KayError('locales-invalid', `kay: i18n.paths translates ${pattern} for ${locale} as ${path}, which does not start with /`)

      if (path.slice(1).split('/').slice(0, -1).includes('') || path.startsWith('//'))
        throw new KayError('locales-invalid', `kay: i18n.paths translates ${pattern} for ${locale} as ${path}, which has an empty segment`)

      if (paramsOf(path) !== params)
        throw new KayError('locales-invalid', `kay: i18n.paths translates ${pattern} for ${locale} as ${path}, whose params are not the page's: each translation names the same :params, and a * as the last segment when the page has one`)

      // A trailing slash is the router's to add, as `trailingSlash` says.
      const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

      return [locale, trimmed === '/' ? trimmed : trimmed.split('/').map(segment => segment === '*' || segment.startsWith(':') ? segment : pathSegment(segment)).join('/')]
    }))]
  }))
}

// A pattern's params in a form two patterns compare by, a catch-all only counting as its last segment.
function paramsOf(pattern: string): string {
  const segments = pattern.split('/')

  return segments.flatMap((segment, index) => {
    if (segment === '*')
      return [index === segments.length - 1 ? '*' : '*inner']

    return segment.startsWith(':') ? [segment] : []
  }).sort().join(' ')
}

// The locales served under a prefix: every one but an unprefixed default, none when each has its domain.
export function localePrefixes(settings: LocaleSettings): string[] {
  return settings.hosts ? [] : settings.locales.filter(locale => locale !== settings.defaultLocale || settings.prefixDefault)
}

// A page whose first segment is a locale's prefix would be served twice at one path, as would a path translated under another locale's prefix; `routeTable` claims each locale's paths, a translated one another page of that locale serves among them.
export function refuseLocaleClashes(settings: LocaleSettings, routes: Pick<Route, 'file' | 'pattern'>[]): void {
  const prefixes = new Set(localePrefixes(settings))
  const clash = routes.find(route => prefixes.has(firstSegment(route.pattern)))

  if (clash)
    throw new KayError('locales-invalid', `kay: ${clash.file} serves ${clash.pattern}, under the prefix of the locale ${firstSegment(clash.pattern)}; kay serves every page there already`)

  const patterns = new Set(routes.map(route => route.pattern))
  const unknown = Object.keys(settings.paths ?? {}).find(pattern => !patterns.has(pattern))

  if (unknown !== undefined)
    throw new KayError('locales-invalid', `kay: i18n.paths translates ${unknown}, which no page serves; name a page by the pattern it is served under, /blog/:slug for src/routes/blog/[slug].kay`)

  for (const locale of settings.locales.filter(locale => !settings.hosts && !prefixes.has(locale))) {
    for (const route of routes) {
      const pattern = localePattern(settings, route.pattern, locale)

      if (pattern !== route.pattern && prefixes.has(firstSegment(pattern)))
        throw new KayError('locales-invalid', `kay: i18n.paths translates ${route.pattern} for ${locale} as ${pattern}, under the prefix of the locale ${firstSegment(pattern)}`)
    }
  }
}

// The settings with each page a translated pattern would also take named as itself, so `/blog/new` keeps its path where `/blog/:slug` is translated, as the router serves it.
export function routedSettings(settings: LocaleSettings, routes: Pick<Route, 'pattern'>[]): LocaleSettings {
  if (!settings.paths)
    return settings

  const paths = { ...settings.paths }

  for (const { pattern } of routes) {
    const taken = settings.locales.filter(locale => paths[pattern] === undefined && translatedPath(settings, pattern, locale) !== pattern)

    if (taken.length > 0)
      paths[pattern] = Object.fromEntries(taken.map(locale => [locale, pattern]))
  }

  return { ...settings, paths }
}

// The settings told of the patterns the site's pages are served under and of its localized feeds, which a link written as the default locale names them goes to in the page's locale.
// A localized collection's feed is served once per locale, as a page is; any other's once for all of them.
export function linkedSettings(settings: LocaleSettings, routes: Pick<Route, 'pattern'>[], collections: { options: { feed?: { path: string } | undefined, localized?: boolean | undefined } }[]): LocaleSettings {
  const feeds = settings.hosts ? [] : collections.flatMap(({ options }) => options.feed && options.localized === true ? [options.feed.path] : [])

  return { ...settings, pages: routes.map(route => route.pattern), ...feeds.length > 0 && { feeds } }
}

// The pattern a page is served under in a locale, translated when i18n.paths names it.
export function localePattern(settings: LocaleSettings, pattern: string, locale: string): string {
  return settings.paths?.[pattern]?.[locale] ?? pattern
}

function firstSegment(path: string): string {
  const end = path.indexOf('/', 1)

  return end === -1 ? path.slice(1) : path.slice(1, end)
}

// Every locale's messages, the app's laid over its extensions' key by key, the default locale's standing in for a key another lacks.
export async function loadI18n(root: string, config: I18nConfig, extensions?: KayExtension[]): Promise<I18n> {
  const settings = localeSettings(config)
  const flat = new Map<string, Map<string, Message>>()

  for (const locale of settings.locales) {
    const file = messagesFile(root, config, locale)

    const catalogs = [...libraryCatalogs(root, extensions, locale), ...fileExists(file) ? [file] : []]

    // An extension's catalog stands in for an app with no text of its own in that locale.
    if (catalogs.length === 0)
      throw new KayError('locales-invalid', `kay: i18n lists ${locale}, so its messages go in ${relative(process.cwd(), file)}: export default defineMessages({ ... })`)

    flat.set(locale, await mergedCatalogs(catalogs))
  }

  const fallback = flat.get(settings.defaultLocale)!

  return { settings, translations: new Map([...flat].map(([locale, messages]) => [locale, { locale, messages, ...locale !== settings.defaultLocale && { fallback } }])) }
}

// A site without `i18n` in its one language: its extensions' messages, the app's own src/messages/<lang>.ts over them when it has one.
export async function implicitI18n(root: string, lang: string | undefined, extensions?: KayExtension[]): Promise<I18n> {
  const locale = lang ?? DEFAULT_LANG
  const own = messagesFile(root, {}, locale)
  const catalogs = [...libraryCatalogs(root, extensions, locale), ...fileExists(own) ? [own] : []]

  return { settings: { locales: [locale], defaultLocale: locale, prefixDefault: false }, translations: new Map([[locale, { locale, messages: await mergedCatalogs(catalogs) }]]), implicit: true }
}

function fileExists(file: string): boolean {
  return projectSource().has(file)
}

function libraryCatalogs(root: string, extensions: KayExtension[] | undefined, locale: string): string[] {
  return projectSource().extensionCatalogs(locale, extensionMessageFiles(root, extensions, locale))
}

// The catalogs' messages, each laid over the ones before it key by key.
async function mergedCatalogs(catalogs: string[]): Promise<Map<string, Message>> {
  const messages = new Map<string, Message>()

  for (const catalog of catalogs) {
    const tree = (await importModule<{ default?: unknown }>(catalog)).default

    if (typeof tree !== 'object' || tree === null)
      throw new KayError('locales-invalid', `kay: ${relative(process.cwd(), catalog)} must export its messages by default: export default defineMessages({ ... })`)

    for (const [key, message] of flattenMessages(tree as MessageTree))
      messages.set(key, message)
  }

  return messages
}

// The locales each project root serves, which what renders outside a request reads: the running server's, else read off the project's config once.
const projects = new Map<string, Promise<I18n>>()

export function serveLocales(root: string, i18n: I18n): void {
  projects.set(resolve(root), Promise.resolve(i18n))
}

// The state `renderToString` runs in outside a request, or for another locale than the request's, in the site's default locale unless given one; its page is the root.
export async function renderState(locale: string | undefined): Promise<LocaleState> {
  const i18n = await projectI18n()
  const chosen = locale ?? i18n.settings.defaultLocale
  const translations = i18n.translations.get(chosen)

  if (!translations)
    throw new Error(`kay: renderToString renders in ${chosen}, which is none of the site's locales: ${i18n.settings.locales.join(', ')}`)

  return { ...translations, settings: i18n.settings, path: '/', ...i18n.implicit && { implicit: true } }
}

async function projectI18n(): Promise<I18n> {
  const source = projectSource()
  const root = source.root(process.env.KAY_ROOT ?? process.cwd())
  let loading = projects.get(root)

  if (!loading) {
    loading = (async () => {
      const config = await source.config(root, {})

      return config.i18n ? loadI18n(root, config.i18n, config.extensions) : implicitI18n(root, config.lang, config.extensions)
    })()
    projects.set(root, loading)
  }

  return loading
}

// The state a request runs in for that locale, the page's path given without its prefix.
export function stateFor(i18n: I18n, locale: string, path: string, request: Request): LocaleState {
  return { ...i18n.translations.get(locale)!, settings: i18n.settings, path, host: requestUrl(request).host, ...i18n.implicit && { implicit: true } }
}

// The locale a request's host serves, when locales go by domain.
export function hostLocale(settings: LocaleSettings, request: Request): string {
  const { host } = requestUrl(request)

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
  const cookies = requestCookies(request)

  return cookies.get(LOCALE_COOKIE) ?? cookies.get(LEGACY_LOCALE_COOKIE) ?? undefined
}

// The locale an action runs in: its host's, its page's, as the `Referer` or the form names it, or the visitor's preferred one.
// The page's path is under the site's `base` in the browser, which the locale prefix follows.
export function requestLocale(settings: LocaleSettings, request: Request, referer = request.headers.get('referer'), base = ''): string {
  if (settings.hosts)
    return hostLocale(settings, request)

  if (referer !== null && URL.canParse(referer) && new URL(referer).host === requestUrl(request).host) {
    const { pathname } = new URL(referer)
    const path = routerPath(pathname, base)
    // A page outside the base is none of this site's.
    const outside = base !== '' && path === pathname
    const locale = outside ? undefined : splitLocale(settings, path).locale

    if (locale !== undefined)
      return locale
  }

  return preferredLocale(settings, request)
}

// The best of the locales for an `Accept-Language` header: an exact tag first, then one of the same language, `fr` for `fr-CA` and the other way.
export function acceptedLocale(locales: readonly string[], header: string | null): string | undefined {
  return matchLocale(locales, acceptedLocales(header ?? ''))
}

// Remembers the locale a visitor went to, so an unprefixed path takes them back to it.
export function localeCookie(locale: string, secure: boolean, base = ''): string {
  return `${LOCALE_COOKIE}=${locale}; Path=${base || '/'}; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
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
    const served = settings.hosts ? translatedPath(settings, path, locale) : localePath(settings, path, locale)

    return { locale, path: served, key: prerenderKey(settings, locale, served), ...settings.hosts && { host: settings.hosts[locale] } }
  })
}

// The key a prerendered page is kept under: its path, under its locale's segment when locales go by domain and share their paths.
export function prerenderKey(settings: LocaleSettings | undefined, locale: string | undefined, path: string): string {
  return settings?.hosts && locale !== undefined ? `/${locale}${path === '/' ? '' : path}` : path
}

// The `kay.invalid.*` messages the request's catalogs word, which the browser's form check reads; a key no catalog has is sent nothing, as the check then reads Elysia's English.
export function invalidKeys(): string[] {
  const state = localeState()

  return Object.keys(INVALID_PARAMS).filter(key => state?.messages.has(key) === true || state?.fallback?.has(key) === true)
}

// The messages a page's islands use, with what the browser needs to build links in its locale; nothing outside a request served in one.
export function messagesScript(keys: Set<string>, first: boolean): string {
  const state = localeState()

  const now = state?.now !== undefined && !state.nowWritten ? state.now : undefined

  // Without `i18n`, the browser builds links as they are written: a page sends its locale only for the messages its islands read.
  if (!state || (keys.size === 0 && (!first || state.implicit) && now === undefined))
    return ''

  if (now !== undefined)
    state.nowWritten = true

  const messages = Object.fromEntries([...keys].flatMap((key) => {
    const message = state.messages.get(key) ?? state.fallback?.get(key)

    return message === undefined ? [] : [[key, message]]
  }))
  const payload = { ...first && { locale: state.locale, ...!state.implicit && { settings: state.settings } }, messages, ...now !== undefined && { now } }

  return `<script type="application/json" data-kay-i18n>${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>`
}
