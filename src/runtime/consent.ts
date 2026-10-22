import type { Signal } from './core'
import { TRAILING_SLASH, withBase } from './base'
import { createSignal, currentServerScope, markSignal } from './reactive'

// The visitor's answer to analytics: `'yes'`, `'no'`, or `''` while they have not chosen.
export type Consent = 'yes' | 'no' | ''

const COOKIE = 'kay_analytics'

// About six months, what the CNIL recommends; its ceiling is 13 months.
export const CONSENT_MAX_AGE = 180 * 24 * 60 * 60

interface Tracker {
  decide: (value: Consent) => void
}

let state: { read: () => Consent, write: (value: Consent) => void } | undefined

function answer(text: string | undefined): Consent {
  return text === 'yes' || text === 'no' ? text : ''
}

function cookieValue(): Consent {
  const found = document.cookie.split('; ').find(pair => pair.startsWith(`${COOKIE}=`))

  return answer(found?.slice(COOKIE.length + 1))
}

// The browser's signal is made on first use and follows `kay:consent`, which kay's notice and `set` both fire, so the cookie stays the one source of truth.
function browserState(): NonNullable<typeof state> {
  if (!state) {
    const [read, write] = createSignal<Consent>(cookieValue())

    document.addEventListener('kay:consent', (event) => {
      write(answer((event as CustomEvent<{ consent?: string } | null>).detail?.consent))
    })
    state = { read, write }
  }

  return state
}

function save(value: Consent): void {
  const tracker = (window as { kayAnalytics?: Tracker }).kayAnalytics

  // The tracker also loads or drops the provider's script and closes the notice; before it has loaded, the cookie it will read is enough.
  if (tracker) {
    tracker.decide(value)

    return
  }

  const path = withBase('/').replace(TRAILING_SLASH, '') || '/'
  // The tracker's own script carries the app's `consent.maxAge`.
  const maxAge = Number(document.querySelector<HTMLElement>('script[data-max-age]')?.dataset.maxAge) || CONSENT_MAX_AGE

  document.cookie = `${COOKIE}=${value}; max-age=${value === '' ? 0 : maxAge}; path=${path}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`
  document.dispatchEvent(new CustomEvent('kay:consent', { detail: { consent: value } }))
}

// The visitor's answer to `analytics({ consent })`, for an app's own cookie banner or settings page: read `consent()`, answer with `consent.set('yes')`, `'no'`, or `''` to ask again.
// A page renders with the answer in the request's `kay_analytics` cookie, the one kay's own notice writes, so the two never disagree; setting it is for the browser, since the server has no response to write to there.
const reader = Object.assign(
  (): Consent => {
    return typeof document === 'undefined' ? answer(currentServerScope()?.cookie(COOKIE)) : browserState().read()
  },
  {
    set: (next: Consent | ((current: Consent) => Consent)): void => {
      if (typeof document === 'undefined')
        throw new TypeError('kay: consent.set() answers from the browser, in an event handler or an effect; the server can only read the answer')

      const current = browserState()
      const value = typeof next === 'function' ? next(current.read()) : next

      if (value !== 'yes' && value !== 'no' && value !== '')
        throw new TypeError(`kay: consent takes 'yes', 'no' or '', got ${JSON.stringify(value)}`)

      current.write(value)
      save(value)
    },
  },
)

export const consent: Signal<Consent> = markSignal(reader)
