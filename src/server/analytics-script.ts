import type { AnalyticsOptions } from './analytics'
import { SHIPPED_WORDS } from './analytics-words'

// The tracker every page loads: a page view on load and on each page swap, sent to the app's own origin, behind the consent gate when the app set one, or until the visitor opts out.
// Plain JavaScript in a string because the browser loads it as a file the server serves, and it must stay small: every page pays for it.
// The tracker built for the app's config: the code for clicks on marked elements, outbound links and downloads is in it only when `events` turns them on, so a page that asked for none pays for `track` alone.
export function trackerFor(options: AnalyticsOptions): string {
  const events = options.events
  const downloads = typeof events === 'object' ? events.downloads : undefined

  return trackerScript(events !== undefined && events !== false, typeof events === 'object' && events.outbound === true, downloads !== undefined && downloads !== false)
}

// A short hash of the built tracker, written on its tag as `?v=`: a new kay or a changed config is a new URL, so the long cache never holds a tracker the page's options do not fit.
export function trackerVersion(options: AnalyticsOptions): string {
  return new Bun.CryptoHasher('sha256').update(trackerFor(options)).digest('hex').slice(0, 10)
}

function trackerScript(events: boolean, outbound: boolean, downloads: boolean): string {
  return `(() => {
  const script = document.currentScript
  const data = script.dataset
  const path = new URL(script.src).pathname.slice(0, -3)
  const scope = path.slice(0, -'/_kay/analytics'.length) || '/'
  const name = 'kay_analytics'
  const gated = data.consent !== undefined
  const informed = data.info !== undefined
  const silent = data.silent !== undefined
  const titles = data.titles !== undefined
  const maxAge = Number(data.maxAge) || 15552000
  const exclude = data.exclude ? JSON.parse(data.exclude).map(pattern => pattern.split('/').filter(Boolean)) : []
  const load = data.load ? JSON.parse(data.load) : undefined
${downloads ? '  const files = new Set(JSON.parse(data.downloads).map(word => word.toLowerCase()))\n' : ''}  let loaded = false
  let last = document.referrer
  let wanted
  let asking

  function choice() {
    const found = document.cookie.split('; ').find(cookie => cookie.startsWith(name + '='))

    return found ? found.slice(name.length + 1) : ''
  }

  // Waiting for a yes, or counting until the visitor opts out.
  function blocked() {
    return gated ? choice() !== 'yes' : choice() === 'no'
  }

  // A page the app left out, one behind a guard (the server marks it) or one that asks search engines to skip it is never counted.
  function skipped(url) {
    const parts = new URL(url).pathname.slice(scope === '/' ? 0 : scope.length).split('/').filter(Boolean)

    return !!document.querySelector('meta[name=robots][content*=noindex i],meta[name=kay-guarded]') || exclude.some(wanted => wanted.every((word, at) => word === '*' ? parts[at] !== undefined : word === parts[at]))
  }

  async function view(url, event, props) {
    if (blocked() || skipped(url))
      return

    const body = JSON.stringify({ u: url, s: scope === '/' ? '' : scope, r: last, t: titles ? document.title : '', w: screen.width + 'x' + screen.height, l: navigator.language, e: event, p: props })

    if (!event)
      last = url

    try {
      await fetch(path, { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain' }, body })
    }
    catch {}
  }

  // A provider that takes no visits from here runs its own script, loaded once the visitor agreed or, with the information line, until they opt out.
  function start() {
    if (blocked())
      return

    if (!load) {
      void view(location.href)

      return
    }

    const element = document.createElement('script')

    // A proxy takes the base off before the app sees the request, so the app's own script is told it, to point the tracker at the right route.
    element.src = load.src[0] === '/' && scope !== '/' ? scope + load.src + '?base=' + encodeURIComponent(scope) : load.src
    element.defer = true
    element.nonce = script.nonce

    for (const [key, value] of Object.entries(load.attrs))
      element.setAttribute(key, value)

    document.head.append(element)
    loaded = true
  }

  // An empty value takes the answer back, so the visitor is asked again.
  function decide(value) {
    if (value !== 'yes' && value !== 'no' && value !== '')
      return

    const before = choice()

    document.cookie = name + '=' + value + '; max-age=' + (value === '' ? 0 : maxAge) + '; path=' + scope + '; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '')
    document.dispatchEvent(new CustomEvent('kay:consent', { detail: { consent: value } }))

    if (value === 'yes' && (gated ? before !== 'yes' : before === 'no'))
      start()

    // A script that already ran cannot be taken back, so the page loads again without it.
    if (value !== 'yes' && value !== '' && loaded)
      location.reload()
    else if (value === '')
      ask()
  }

  // The notice is a file of its own, fetched only when a visitor has to be asked.
  function ask(clicked) {
    if (silent || !(gated || informed))
      return

    if (api.show) {
      api.show(clicked)

      return
    }

    wanted = clicked ?? wanted

    if (!asking) {
      const notice = asking = Object.assign(document.createElement('script'), { src: path + '/notice.js', defer: true, nonce: script.nonce })

      // A failed fetch lets the next ask try again.
      notice.addEventListener('error', () => {
        notice.remove()
        asking = undefined
      })
      document.head.append(notice)
    }
  }

  // A named event with a few short props, counted by the app's server behind the same consent, exclude and rate rules as a visit; a provider that runs its own script counts none.
  const track = (event, props) => load || view(location.href, event, props)
  const api = window.kayAnalytics = { consent: choice, decide, ask, data, scope, track, wanted: () => wanted }

  document.addEventListener('kay:navigate', event => {
    if (!load)
      void view(event.detail.url)
  })

  document.addEventListener('click', event => {
    const opening = event.target instanceof Element && event.target.closest('[data-analytics-consent]')

    if ((gated || informed) && opening)
      ask(opening)
${events ? clicks(outbound, downloads) : ''}  })

  if ((gated || informed) && choice() === '')
    ask()

  start()
})()
`
}

// What a click means once the app turned `events` on: an element marked data-analytics-event, else a link to another site (outbound) or to a file (downloads) when asked for.
function clicks(outbound: boolean, downloads: boolean): string {
  return `
    const target = event.target instanceof Element ? event.target : undefined
    const marked = target?.closest('[data-analytics-event]')
    const props = {}

    // The props are the element's data-analytics-prop-* attributes, named without the prefix.
    for (const { name, value } of marked?.attributes ?? []) {
      if (name.startsWith('data-analytics-prop-'))
        props[name.slice(20)] = value
    }

    if (marked)
      track(marked.dataset.analyticsEvent, props)
${outbound || downloads ? linkClicks(outbound, downloads) : ''}`
}

function linkClicks(outbound: boolean, downloads: boolean): string {
  return `
    const link = marked ? undefined : target?.closest('a[href]')

    if (link && /^https?:$/.test(link.protocol)) {
      const url = link.origin + link.pathname

      ${[downloads && 'if (link.hasAttribute(\'download\') || files.has(link.pathname.split(\'.\').pop().toLowerCase()))\n        track(\'File Download\', { url })', outbound && 'if (link.origin !== location.origin)\n        track(\'Outbound Link: Click\', { url })'].filter(Boolean).join('\n      else ')}
    }
`
}

export const NOTICE_SCRIPT = `(() => {
  const api = window.kayAnalytics
  const { data, scope } = api
  const texts = data.texts ? JSON.parse(data.texts) : {}
  // The words kay ships, for a language the page's tag holds none of: the provider is named here, as the tag names it in the ones it holds.
  const shipped = Object.fromEntries(Object.entries(${JSON.stringify(SHIPPED_WORDS)}[data.consent !== undefined ? 'consent' : 'info']).map(([language, entry]) => [language, { ...entry, text: entry.text.replace('{provider}', () => data.provider ?? '') }]))
  let banner
  let opener

  // The site's own look: an app's --kay-notice-* first, then kayjs-ui's tokens, then the page's colours, so the notice follows its theme with no setup.
  const tone = (name, fallback) => 'var(--kay-notice-' + name + ', ' + fallback + ')'
  const paint = element => getComputedStyle(element).backgroundColor
  const painted = element => !['transparent', 'rgba(0, 0, 0, 0)'].includes(paint(element))
  const edge = 'var(--border-width, 1px) solid '

  function dress() {
    if (!banner)
      return

    const page = painted(document.body) ? paint(document.body) : painted(document.documentElement) ? paint(document.documentElement) : 'Canvas'
    const accent = tone('accent', 'var(--color-accent, ' + getComputedStyle(document.body).color + ')')
    // Agreeing and refusing look the same: the notice never makes one answer easier to pick than the other.
    const button = 'font:inherit;padding:.4em .9em;cursor:pointer;border:' + edge + accent + ';border-radius:inherit;background:' + accent + ';color:' + tone('on-accent', 'var(--color-accent-foreground, ' + page + ')')

    banner.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;max-width:36rem;margin-inline:auto;padding:.75rem 1rem;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;font-size:.875rem;line-height:1.45;z-index:2147483647'
      + ';background:' + tone('background', 'var(--color-surface, ' + page + ')') + ';color:' + tone('color', 'var(--color-foreground, inherit)')
      + ';border:' + edge + tone('border', 'var(--color-border-strong, color-mix(in srgb, currentColor 22%, transparent))') + ';border-radius:' + tone('radius', 'var(--radius-lg, .5rem)')
      + ';box-shadow:' + tone('shadow', 'var(--shadow-raised, 0 10px 32px rgb(0 0 0 / 18%), 0 1px 3px rgb(0 0 0 / 10%))')

    for (const element of banner.querySelectorAll('button'))
      element.style.cssText = button
  }

  // A theme switched by a class, an attribute or the system's scheme changes the page's colours under an open notice.
  const theme = new MutationObserver(dress)

  theme.observe(document.documentElement, { attributes: true })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', dress)

  function show(clicked) {
    if (banner)
      return

    const lang = document.documentElement.lang.split('-')[0].toLowerCase()
    // The language of the words picked, which can differ from the page's: the notice carries it as its own lang.
    const wordsLang = [lang, Object.keys(texts)[0], 'en'].find(key => key !== undefined && (Object.hasOwn(texts, key) || Object.hasOwn(shipped, key))) ?? 'en'
    const words = (Object.hasOwn(texts, wordsLang) ? texts[wordsLang] : undefined) ?? shipped[wordsLang] ?? shipped.en
    const make = (tag, text) => Object.assign(document.createElement(tag), { textContent: text })
    const button = (text, value) => {
      const element = make('button', text)

      element.type = 'button'
      element.addEventListener('click', () => api.decide(value))

      return element
    }

    banner = make('section', '')
    banner.setAttribute('aria-labelledby', 'kay-analytics-notice')
    banner.lang = wordsLang
    banner.append(make('p', words.text ?? ''), button(words.agree ?? 'Agree', 'yes'), button(words.refuse ?? 'Refuse', 'no'))
    banner.firstChild.id = 'kay-analytics-notice'
    banner.firstChild.style.cssText = 'margin:0;flex:1 1 14rem'

    if (words.policy && data.policy) {
      const link = make('a', words.policy)

      link.href = data.policy[0] === '/' && scope !== '/' ? scope + data.policy : data.policy
      banner.firstChild.append(' ', link)
    }

    // The element focus came from is where it goes back to once the visitor answered.
    banner.addEventListener('focusin', event => opener ??= event.relatedTarget)
    document.body.append(banner)
    theme.observe(document.body, { attributes: true })
    dress()

    if (clicked) {
      opener = clicked
      banner.querySelector('button').focus()
    }
  }

  // An answer closes the notice and gives focus back to where it came from.
  document.addEventListener('kay:consent', () => {
    const back = banner?.contains(document.activeElement) ? opener : undefined

    banner?.remove()
    banner = undefined
    opener = undefined

    if (back?.isConnected)
      back.focus()
  })

  // A page swap replaces the body, and the notice with it.
  document.addEventListener('kay:navigate', () => {
    if (banner && !banner.isConnected) {
      document.body.append(banner)
      theme.observe(document.body, { attributes: true })
      dress()
    }
  })

  api.show = show
  show(api.wanted())
})()
`
