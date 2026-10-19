import type { KayExtension } from '../config'
import type { HeadTag } from '../runtime/head'
import { KayError } from '../compiler/errors'
import { CONSENT_MAX_AGE } from '../runtime/consent'
import { ANALYTICS_SCRIPT, NOTICE_SCRIPT } from './analytics-script'

export { consent } from '../runtime/consent'
export type { Consent } from '../runtime/consent'

// A text for the consent notice, or one per language: `{ en: 'We count visits', fr: 'Nous comptons les visites' }`, the page's `lang` picking one and the first listed when none fits.
export type AnalyticsText = string | Record<string, string>

export interface AnalyticsConsent {
  // The question the notice asks; `{provider}` in it becomes the provider's name, as in the default wording.
  text?: AnalyticsText | undefined
  agree?: AnalyticsText | undefined
  refuse?: AnalyticsText | undefined
  // The link to the privacy policy, `Privacy policy` by default.
  policy?: AnalyticsText | undefined
  // How long the visitor's answer, a refusal as much as a yes, is remembered, in seconds: 180 days by default and 13 months at most, the CNIL's ceiling.
  maxAge?: number | undefined
  // `false` shows no notice and opens none from `data-analytics-consent`: the app asks in its own UI and answers with `consent.set('yes')` from `kay/analytics`, while the server still forwards nothing without the yes.
  notice?: boolean | undefined
}

// The line shown while a visit is counted without asking, with the button that opts out.
export interface AnalyticsInfo {
  text?: AnalyticsText | undefined
  // The button that closes the line.
  ok?: AnalyticsText | undefined
  // The button that stops the counting for this visitor.
  optOut?: AnalyticsText | undefined
  // The link to the privacy policy, `Privacy policy` by default.
  policy?: AnalyticsText | undefined
}

interface Common {
  // Waits for the visitor's yes before counting a visit, with a notice kay shows until they chose; `true` for the notice in English.
  // Left out, `ga4`, `fathom`, `cloudflare` and `custom` ask like `true`, as they are not self-hostable cookieless counters; `consent: false` counts them without asking, which shows `info` and its opt-out.
  // Left out or `false`, `plausible`, `umami`, `simpleanalytics` and `matomo` count at once and show `info`, as do the others with `consent: false`, whose own script kay then loads until the visitor opts out.
  consent?: boolean | AnalyticsConsent | undefined
  // The information line and opt-out kay shows where visits are counted without asking, `false` when the app informs and lets visitors object itself.
  info?: false | AnalyticsInfo | undefined
  // The app's privacy policy, a path written without the `base` (`/privacy`) or an address, linked from the notice and the information line, which already name the provider.
  policyUrl?: string | undefined
  // Hosts besides the one a page is served from that a visit may name, such as `www.example.com` for a site also served at `example.com`.
  hosts?: string[] | undefined
}

// The options only the providers kay forwards visits for take: a script that counts alone has no use for them, so its interface types them `never`.
interface Counted extends Common {
  // Pages that are never counted, as paths: `/account` leaves out the page and all under it, `*` stands for one segment (`/*/admin` for an app with locale prefixes).
  // A page with `noindex` or behind a guard is left out too. Only the providers kay forwards visits for take it, not `fathom`, `cloudflare` or `custom`, whose script counts alone.
  exclude?: string[] | undefined
  // Sends the page title with each visit, which names the page and so may name a person; left out, visits carry the path alone.
  titles?: boolean | undefined
}

export interface PlausibleOptions extends Counted {
  provider: 'plausible'
  // The site as it is named in Plausible; the host of the visited page when left out.
  domain?: string | undefined
  // A self-hosted Plausible, `https://plausible.example.com`.
  host?: string | undefined
}

export interface UmamiOptions extends Counted {
  provider: 'umami'
  // The website's id in Umami.
  websiteId: string
  // A self-hosted Umami; Umami Cloud, `https://cloud.umami.is`, by default.
  host?: string | undefined
}

export interface SimpleAnalyticsOptions extends Counted {
  provider: 'simpleanalytics'
  // The site as it is named in Simple Analytics; the host of the visited page when left out.
  hostname?: string | undefined
  // Where Simple Analytics takes events, `https://queue.simpleanalyticscdn.com` by default.
  host?: string | undefined
}

export interface MatomoOptions extends Counted {
  provider: 'matomo'
  // The site's id in Matomo.
  siteId: string | number
  // Your Matomo, `https://matomo.example.com`: visits go to its `matomo.php`.
  host: string
  // A token of a Matomo user with write access to the site, which Matomo asks for before it takes the visitor's address (`cip`); without one, Matomo tells visitors apart by what it sees of this server, so give one unless Matomo reads `X-Forwarded-For` itself.
  tokenAuth?: string | undefined
}

// Google Analytics 4 through its Measurement Protocol, sent from the server: no Google script, cookie or CSP exception.
// The visitor's client id is made on the server from a salt that changes every day, so nothing is stored in the browser, and a visitor is told apart for a day at most.
export interface Ga4Options extends Counted {
  provider: 'ga4'
  // The web data stream's measurement id, `G-XXXXXXXXXX`.
  measurementId: string
  // A secret made under the data stream's Measurement Protocol API secrets in Google Analytics; it stays on the server.
  apiSecret: string
  // Where Google takes events, `https://www.google-analytics.com` by default; `https://region1.google-analytics.com` for EU data collection.
  host?: string | undefined
  // Passes the visitor's address on as `ip_override` so Google places the visit; off by default, Google then places visits at this server.
  address?: boolean | undefined
}

// Fathom has no API to send a visit to, so its own script is loaded: from Fathom's domain, which the CSP then allows, and after the visitor's yes when `consent` is set, else until they opt out on the information line.
export interface FathomOptions extends Common {
  exclude?: undefined
  titles?: undefined
  provider: 'fathom'
  // The site's id in Fathom, such as `ABCDEFGH`.
  siteId: string
  // How Fathom follows page swaps; `'auto'` by default.
  spa?: 'auto' | 'history' | 'hash' | undefined
}

// Cloudflare takes its data only from its own beacon, so that script is loaded: from Cloudflare's domain, which the CSP then allows, and after the visitor's yes when `consent` is set, else until they opt out on the information line.
export interface CloudflareOptions extends Common {
  exclude?: undefined
  titles?: undefined
  provider: 'cloudflare'
  // The token of the site in Cloudflare Web Analytics.
  token: string
}

// Any other tracker that is a script posting to an endpoint: kay serves the script from the app with the endpoint's address in it pointed at the app, and forwards what the script posts.
export interface CustomOptions extends Common {
  exclude?: undefined
  titles?: undefined
  provider: 'custom'
  // The tracker's script, `https://tracker.example/script.js`.
  script: string
  // The address the script posts to, as it is written in the script, `https://tracker.example/collect`: the script kay serves posts to the app instead, which passes the body on to this address.
  endpoint: string
  // Passes the visitor's address on in `X-Forwarded-For`, for a tracker that tells visitors apart by it; off by default.
  address?: boolean | undefined
}

export type AnalyticsOptions = PlausibleOptions | UmamiOptions | SimpleAnalyticsOptions | MatomoOptions | Ga4Options | FathomOptions | CloudflareOptions | CustomOptions

// The providers that take visits from the app's server.
export type VisitOptions = Exclude<AnalyticsOptions, FathomOptions | CloudflareOptions | CustomOptions>

export const ANALYTICS_PATH = '/_kay/analytics'
export const ANALYTICS_SCRIPT_PATH = `${ANALYTICS_PATH}.js`
export const NOTICE_SCRIPT_PATH = `${ANALYTICS_PATH}/notice.js`
export const CUSTOM_SCRIPT_PATH = `${ANALYTICS_PATH}/script.js`
export const CUSTOM_COLLECT_PATH = `${ANALYTICS_PATH}/collect`

// The head tags kay put there for a custom tracker, which an app's own tag of the same `src` is not one of.
export const TRACKER_TAGS = new WeakSet<HeadTag>()
export const ANALYTICS_PROVIDERS: ReadonlySet<string> = new Set(['plausible', 'umami', 'simpleanalytics', 'matomo', 'ga4', 'fathom', 'cloudflare', 'custom'])
const SITE_ID = /^[A-Z\d]{1,32}$/i
const TOKEN = /^[\w-]{1,128}$/
const MEASUREMENT_ID = /^G-[A-Z\d]{4,20}$/i

const PROVIDER_NAMES: Record<string, string> = { plausible: 'Plausible', umami: 'Umami', simpleanalytics: 'Simple Analytics', matomo: 'Matomo', ga4: 'Google Analytics', fathom: 'Fathom', cloudflare: 'Cloudflare Web Analytics' }
const LOCAL_PATH = /^\/(?![/\\])/
const MAX_CONSENT_AGE = 395 * 24 * 60 * 60
// The providers that wait for a yes unless the app wrote `consent: false`.
const ASKS_BY_DEFAULT: ReadonlySet<string> = new Set(['ga4', 'fathom', 'cloudflare', 'custom'])

// Whether a visit waits for the visitor's yes: the app's `consent`, else the provider's default.
export function isGated(options: AnalyticsOptions): boolean {
  return options.consent === undefined ? ASKS_BY_DEFAULT.has(options.provider) : options.consent !== false
}

// Counts the site's visits with a provider, through the site's own origin where the provider takes visits from a server: the browser loads one small script from the app and posts to a route of the app, which forwards each visit to the provider, so the CSP needs no third-party host and ad blockers have nothing to match.
// Fathom and Cloudflare Web Analytics take data only from their own scripts, so those load from their domains and the CSP is opened for them.
// Only a production server (`NODE_ENV=production`) forwards: `kay dev` and a test run send nothing.
export function analytics(options: AnalyticsOptions): KayExtension {
  checked(options)

  const asking = isGated(options)
  const informs = !asking && options.info !== false
  const given = typeof options.consent === 'object' ? options.consent : {}
  const info = typeof options.info === 'object' ? options.info : {}
  const name = options.provider === 'custom' ? URL.parse(options.endpoint)?.hostname ?? 'a statistics tool' : PROVIDER_NAMES[options.provider]!
  const words = asking
    ? noticeOf(given, { text: `We count visits to improve this site with {provider}, without cookies that follow you. Do you agree?`, agree: 'Agree', refuse: 'Refuse', policy: 'Privacy policy' })
    : noticeOf({ text: info.text, agree: info.ok, refuse: info.optOut, policy: info.policy }, { text: `We count visits to improve this site with {provider}, without cookies that follow you. You can opt out.`, agree: 'OK', refuse: 'Opt out', policy: 'Privacy policy' })

  const named = Object.fromEntries(Object.entries(words).map(([language, entry]) => [language, { ...entry, text: entry.text.replaceAll('{provider}', name) }]))

  const gate = (asking || informs) && {
    ...asking ? { 'data-consent': '', ...given.notice === false && { 'data-silent': '' } } : { 'data-info': '' },
    'data-texts': JSON.stringify(named),
    'data-max-age': String(given.maxAge ?? CONSENT_MAX_AGE),
    ...options.policyUrl !== undefined && { 'data-policy': options.policyUrl },
  }
  const counting = options.provider === 'fathom' || options.provider === 'cloudflare' || options.provider === 'custom'
    ? {}
    : {
      ...(options.exclude?.length ?? 0) > 0 && { 'data-exclude': JSON.stringify(options.exclude) },
      ...options.titles === true && { 'data-titles': '' },
    }

  if (options.provider !== 'fathom' && options.provider !== 'cloudflare' && options.provider !== 'custom') {
    return {
      name: 'kay/analytics',
      needsServer: true,
      server: async () => (await import('./analytics-server')).analyticsServer(options),
      config: { head: [{ tag: 'script', props: { src: ANALYTICS_SCRIPT_PATH, defer: true, ...gate, ...counting } }] },
    }
  }

  const loaded = options.provider === 'custom' ? { src: CUSTOM_SCRIPT_PATH, attrs: {} } : scriptOf(options)
  // With `info: false` the provider's script goes in the head as it is; behind the notice or the information line, kay's script loads it, once the visitor said yes or until they opted out.
  const loads = asking || informs
  const tag = loads ? { 'src': ANALYTICS_SCRIPT_PATH, 'defer': true, ...gate, 'data-load': JSON.stringify(loaded) } : { src: loaded.src, defer: true, ...loaded.attrs }
  const head: HeadTag = { tag: 'script', props: tag }

  if (options.provider === 'custom')
    TRACKER_TAGS.add(head)

  // The provider's own script needs no route of ours, except the one that shows the notice and loads it.
  return {
    name: 'kay/analytics',
    // Fathom and Cloudflare only need the notice's script, which a static export writes itself.
    ...loads && options.provider !== 'custom' && { staticFiles: { [ANALYTICS_SCRIPT_PATH]: ANALYTICS_SCRIPT, [NOTICE_SCRIPT_PATH]: NOTICE_SCRIPT } },
    ...options.provider === 'custom' && { needsServer: true },
    ...(options.provider === 'custom' || loads) && { server: async () => (await import('./analytics-server')).analyticsServer(options) },
    config: {
      head: [head],
      ...options.provider !== 'custom' && { security: { csp: cspOf(options) } },
    },
  }
}

// The script a provider that takes no server-side visits is loaded from, and the attributes it reads.
function scriptOf(options: FathomOptions | CloudflareOptions): { src: string, attrs: Record<string, string> } {
  if (options.provider === 'fathom')
    return { src: 'https://cdn.usefathom.com/script.js', attrs: { 'data-site': options.siteId, 'data-spa': options.spa ?? 'auto' } }

  return { src: 'https://static.cloudflareinsights.com/beacon.min.js', attrs: { 'data-cf-beacon': JSON.stringify({ token: options.token }) } }
}

// What the policy needs to let the provider's script load and report: Cloudflare names script-src static.cloudflareinsights.com and connect-src cloudflareinsights.com for Web Analytics.
// A directive given here replaces kay's own, so `'self'` is listed again to keep the site's scripts and requests; `img-src` already allows any https host.
function cspOf(options: FathomOptions | CloudflareOptions): Record<string, string[]> {
  if (options.provider === 'fathom')
    return { 'script-src': ['\'self\'', 'https://cdn.usefathom.com'], 'connect-src': ['\'self\'', 'https://cdn.usefathom.com'] }

  return { 'script-src': ['\'self\'', 'https://static.cloudflareinsights.com'], 'connect-src': ['\'self\'', 'https://cloudflareinsights.com'] }
}

interface Words { text: string, agree: string, refuse: string, policy: string }

// One entry per language the notice is written in, `en` alone when every text is a plain string; a text a language lacks falls back to the English default.
function noticeOf(consent: Partial<Record<keyof Words, AnalyticsText | undefined>>, defaults: Words): Record<string, Words> {
  const given = [consent.text, consent.agree, consent.refuse, consent.policy].flatMap(value => typeof value === 'object' ? Object.keys(value) : [])
  const read = (value: AnalyticsText | undefined, language: string, fallback: string) => typeof value === 'string' ? value : value?.[language] ?? fallback

  return Object.fromEntries((given.length === 0 ? ['en'] : [...new Set(given)]).map(language => [language, {
    text: read(consent.text, language, defaults.text),
    agree: read(consent.agree, language, defaults.agree),
    refuse: read(consent.refuse, language, defaults.refuse),
    policy: read(consent.policy, language, defaults.policy),
  }]))
}

function checked(options: AnalyticsOptions): void {
  const refuse = (reason: string): never => {
    throw new KayError('config-invalid', `kay: analytics ${reason}`)
  }

  if (!ANALYTICS_PROVIDERS.has(options.provider))
    refuse(`takes provider 'plausible', 'umami', 'simpleanalytics', 'matomo', 'ga4', 'fathom', 'cloudflare' or 'custom'; got ${JSON.stringify((options as { provider: unknown }).provider)}`)

  if (options.provider === 'umami' && (typeof options.websiteId !== 'string' || options.websiteId.trim() === ''))
    refuse('needs the websiteId of the website in Umami')

  const address = (name: string, value: unknown, plain: boolean) => {
    const url = typeof value === 'string' ? URL.parse(value) : null

    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || (plain && (url.search !== '' || url.hash !== '')))
      refuse(`${name} is an http or https address with no credentials${plain ? ', query or hash' : ''}; got ${JSON.stringify(value)}`)
  }

  const policy = options.policyUrl

  if (policy !== undefined && !(typeof policy === 'string' && (LOCAL_PATH.test(policy) || ['https:', 'http:'].includes(URL.parse(policy)?.protocol ?? ''))))
    refuse(`policyUrl is a path starting with / or an http or https address; got ${JSON.stringify(policy)}`)

  const age = typeof options.consent === 'object' ? options.consent.maxAge : undefined

  if (age !== undefined && !(Number.isInteger(age) && age > 0 && age <= MAX_CONSENT_AGE))
    refuse(`consent.maxAge is a number of seconds up to 13 months (${MAX_CONSENT_AGE}); got ${JSON.stringify(age)}`)

  if (options.exclude !== undefined && (!Array.isArray(options.exclude) || options.exclude.some(path => typeof path !== 'string' || !path.startsWith('/') || path === '/')))
    refuse(`exclude is a list of paths starting with /, such as ['/account']; got ${JSON.stringify(options.exclude)}`)

  if (((options.exclude?.length ?? 0) > 0 || options.titles !== undefined) && (options.provider === 'fathom' || options.provider === 'cloudflare' || options.provider === 'custom'))
    refuse(`takes exclude and titles for the providers kay forwards visits for, not '${options.provider}', whose own script counts the pages`)

  if (typeof options.info === 'object' && isGated(options))
    refuse('takes info for a counter that asks no one; with consent on, the notice is worded by consent, and consent: false shows the line')

  if ('host' in options && options.host !== undefined)
    address('host', options.host, true)

  if (options.provider === 'matomo') {
    address('host', options.host, true)

    if (options.siteId === '' || !SITE_ID.test(String(options.siteId)))
      refuse('needs the siteId of the site in Matomo')

    if (options.tokenAuth !== undefined && !TOKEN.test(options.tokenAuth))
      refuse('takes a tokenAuth of letters and digits')
  }

  if (options.provider === 'ga4') {
    if (!MEASUREMENT_ID.test(String(options.measurementId)))
      refuse(`needs the measurementId of the web data stream, such as G-XXXXXXXXXX; got ${JSON.stringify(options.measurementId)}`)

    if (!TOKEN.test(String(options.apiSecret)))
      refuse('needs the apiSecret of the data stream\'s Measurement Protocol')
  }

  if (options.provider === 'fathom' && !SITE_ID.test(String(options.siteId)))
    refuse('needs the siteId of the site in Fathom, such as ABCDEFGH')

  if (options.provider === 'cloudflare' && !TOKEN.test(String(options.token)))
    refuse('needs the token of the site in Cloudflare Web Analytics')

  if (options.provider === 'custom') {
    address('script', options.script, false)
    address('endpoint', options.endpoint, false)
  }
}
