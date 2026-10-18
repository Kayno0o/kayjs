import type { KayExtension } from '../config'
import { KayError } from '../compiler/errors'

// A text for the consent notice, or one per language: `{ en: 'We count visits', fr: 'Nous comptons les visites' }`, the page's `lang` picking one and the first listed when none fits.
export type AnalyticsText = string | Record<string, string>

export interface AnalyticsConsent {
  // The question the notice asks.
  text?: AnalyticsText | undefined
  agree?: AnalyticsText | undefined
  refuse?: AnalyticsText | undefined
  notice?: boolean | undefined
}

interface Common {
  // Waits for the visitor's yes before counting a visit, with a notice kay shows until they chose; `true` for the notice in English. A provider that sets cookies on its own would need this on, the ones here set none.
  consent?: boolean | AnalyticsConsent | undefined
  // Hosts besides the one a page is served from that a visit may name, such as `www.example.com` for a site also served at `example.com`.
  hosts?: string[] | undefined
}

export interface PlausibleOptions extends Common {
  provider: 'plausible'
  // The site as it is named in Plausible; the host of the visited page when left out.
  domain?: string | undefined
  // A self-hosted Plausible, `https://plausible.example.com`.
  host?: string | undefined
}

export interface UmamiOptions extends Common {
  provider: 'umami'
  // The website's id in Umami.
  websiteId: string
  // A self-hosted Umami; Umami Cloud, `https://cloud.umami.is`, by default.
  host?: string | undefined
}

export interface SimpleAnalyticsOptions extends Common {
  provider: 'simpleanalytics'
  // The site as it is named in Simple Analytics; the host of the visited page when left out.
  hostname?: string | undefined
  // Where Simple Analytics takes events, `https://queue.simpleanalyticscdn.com` by default.
  host?: string | undefined
}

export interface MatomoOptions extends Common {
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
export interface Ga4Options extends Common {
  provider: 'ga4'
  // The web data stream's measurement id, `G-XXXXXXXXXX`.
  measurementId: string
  // A secret made under the data stream's Measurement Protocol API secrets in Google Analytics; it stays on the server.
  apiSecret: string
  // Where Google takes events, `https://www.google-analytics.com` by default; `https://region1.google-analytics.com` for EU data collection.
  host?: string | undefined
  // Passes the visitor's address on as `ip_override` so Google places the visit; `false` leaves Google with this server's.
  address?: boolean | undefined
}

// Fathom has no API to send a visit to, so its own script is loaded: from Fathom's domain, which the CSP then allows, and after the visitor's yes when `consent` is set.
export interface FathomOptions extends Common {
  provider: 'fathom'
  // The site's id in Fathom, such as `ABCDEFGH`.
  siteId: string
  // How Fathom follows page swaps; `'auto'` by default.
  spa?: 'auto' | 'history' | 'hash' | undefined
}

// Cloudflare takes its data only from its own beacon, so that script is loaded: from Cloudflare's domain, which the CSP then allows, and after the visitor's yes when `consent` is set.
export interface CloudflareOptions extends Common {
  provider: 'cloudflare'
  // The token of the site in Cloudflare Web Analytics.
  token: string
}

// Any other tracker that is a script posting to an endpoint: kay serves the script from the app with the endpoint's address in it pointed at the app, and forwards what the script posts.
export interface CustomOptions extends Common {
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
export const CUSTOM_SCRIPT_PATH = `${ANALYTICS_PATH}/script.js`
export const CUSTOM_COLLECT_PATH = `${ANALYTICS_PATH}/collect`
export const ANALYTICS_PROVIDERS: ReadonlySet<string> = new Set(['plausible', 'umami', 'simpleanalytics', 'matomo', 'ga4', 'fathom', 'cloudflare', 'custom'])
const SITE_ID = /^[A-Z\d]{1,32}$/i
const TOKEN = /^[\w-]{1,128}$/
const MEASUREMENT_ID = /^G-[A-Z\d]{4,20}$/i

const DEFAULT_TEXT = { text: 'We count visits to improve this site, without cookies that follow you. Do you agree?', agree: 'Agree', refuse: 'Refuse' }

// Counts the site's visits with a provider, through the site's own origin where the provider takes visits from a server: the browser loads one small script from the app and posts to a route of the app, which forwards each visit to the provider, so the CSP needs no third-party host and ad blockers have nothing to match.
// Fathom and Cloudflare Web Analytics take data only from their own scripts, so those load from their domains and the CSP is opened for them.
// Only a production server (`NODE_ENV=production`) forwards: `kay dev` and a test run send nothing.
export function analytics(options: AnalyticsOptions): KayExtension {
  checked(options)

  const texts = options.consent === undefined || options.consent === false ? undefined : noticeOf(options.consent === true ? {} : options.consent)
  const gate = texts && { 'data-consent': '', 'data-texts': JSON.stringify(texts) }

  if (options.provider !== 'fathom' && options.provider !== 'cloudflare' && options.provider !== 'custom') {
    return {
      name: 'kay/analytics',
      needsServer: true,
      server: async () => (await import('./analytics-server')).analyticsServer(options),
      config: { head: [{ tag: 'script', props: { src: ANALYTICS_SCRIPT_PATH, defer: true, ...gate } }] },
    }
  }

  const loaded = options.provider === 'custom' ? { src: CUSTOM_SCRIPT_PATH, attrs: {} } : scriptOf(options)
  // Without a notice the provider's script goes in the head as it is; behind one, kay's script loads it once the visitor said yes.
  const tag = gate ? { 'src': ANALYTICS_SCRIPT_PATH, 'defer': true, ...gate, 'data-load': JSON.stringify(loaded) } : { src: loaded.src, defer: true, ...loaded.attrs }

  // The provider's own script needs no route of ours, except the one that shows the notice and loads it.
  return {
    name: 'kay/analytics',
    ...(options.provider === 'custom' || gate) && { needsServer: true, server: async () => (await import('./analytics-server')).analyticsServer(options) },
    config: {
      head: [{ tag: 'script', props: tag }],
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
function cspOf(options: FathomOptions | CloudflareOptions): Record<string, string[]> {
  if (options.provider === 'fathom')
    return { 'script-src': ['https://cdn.usefathom.com'], 'connect-src': ['https://cdn.usefathom.com'], 'img-src': ['https://cdn.usefathom.com'] }

  return { 'script-src': ['https://static.cloudflareinsights.com'], 'connect-src': ['https://cloudflareinsights.com'] }
}

// One entry per language the notice is written in, `en` alone when every text is a plain string; a text a language lacks falls back to the English default.
function noticeOf(consent: AnalyticsConsent): Record<string, { text: string, agree: string, refuse: string }> {
  const given = [consent.text, consent.agree, consent.refuse].flatMap(value => typeof value === 'object' ? Object.keys(value) : [])
  const read = (value: AnalyticsText | undefined, language: string, fallback: string) => typeof value === 'string' ? value : value?.[language] ?? fallback

  return Object.fromEntries((given.length === 0 ? ['en'] : [...new Set(given)]).map(language => [language, {
    text: read(consent.text, language, DEFAULT_TEXT.text),
    agree: read(consent.agree, language, DEFAULT_TEXT.agree),
    refuse: read(consent.refuse, language, DEFAULT_TEXT.refuse),
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
