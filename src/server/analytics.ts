import type { KayExtension } from '../config'
import { KayError } from '../compiler/errors'

// A text for the consent notice, or one per language: `{ en: 'We count visits', fr: 'Nous comptons les visites' }`, the page's `lang` picking one and the first listed when none fits.
export type AnalyticsText = string | Record<string, string>

export interface AnalyticsConsent {
  // The question the notice asks.
  text?: AnalyticsText | undefined
  agree?: AnalyticsText | undefined
  refuse?: AnalyticsText | undefined
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

export type AnalyticsOptions = PlausibleOptions | UmamiOptions | SimpleAnalyticsOptions

export const ANALYTICS_PATH = '/_kay/analytics'
export const ANALYTICS_SCRIPT_PATH = `${ANALYTICS_PATH}.js`
export const ANALYTICS_PROVIDERS: ReadonlySet<string> = new Set(['plausible', 'umami', 'simpleanalytics'])

const DEFAULT_TEXT = { text: 'We count visits to improve this site, without cookies that follow you. Do you agree?', agree: 'Agree', refuse: 'Refuse' }

// Counts the site's visits with a provider, through the site's own origin: the browser loads one small script from the app and posts to a route of the app, which forwards each visit to the provider, so the CSP needs no third-party host and ad blockers have nothing to match.
// Only a production server (`NODE_ENV=production`) forwards: `kay dev` and a test run send nothing.
export function analytics(options: AnalyticsOptions): KayExtension {
  checked(options)

  const texts = options.consent === undefined || options.consent === false ? undefined : noticeOf(options.consent === true ? {} : options.consent)

  return {
    name: 'kay/analytics',
    needsServer: true,
    server: async () => (await import('./analytics-server')).analyticsServer(options),
    config: {
      head: [{
        tag: 'script',
        props: { src: ANALYTICS_SCRIPT_PATH, defer: true, ...texts && { 'data-consent': '', 'data-texts': JSON.stringify(texts) } },
      }],
    },
  }
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
    refuse(`takes provider 'plausible', 'umami' or 'simpleanalytics'; got ${JSON.stringify((options as { provider: unknown }).provider)}`)

  if (options.provider === 'umami' && (typeof options.websiteId !== 'string' || options.websiteId.trim() === ''))
    refuse('needs the websiteId of the website in Umami')

  if (options.host !== undefined) {
    const host = URL.parse(options.host)

    if (host === null || (host.protocol !== 'https:' && host.protocol !== 'http:') || host.username !== '' || host.password !== '' || host.search !== '' || host.hash !== '')
      refuse(`host is the provider's address as an http or https URL with no credentials, query or hash; got ${JSON.stringify(options.host)}`)
  }
}
