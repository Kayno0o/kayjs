// The tracker every page loads: a page view on load and on each page swap, sent to the app's own origin, behind the consent gate when the app set one, or until the visitor opts out.
// Plain JavaScript in a string because the browser loads it as a file the server serves, and it must stay small: every page pays for it.
export const ANALYTICS_SCRIPT = `(() => {
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
  let loaded = false
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

  async function view(url) {
    if (blocked() || skipped(url))
      return

    const body = JSON.stringify({ u: url, s: scope === '/' ? '' : scope, r: last, t: titles ? document.title : '', w: screen.width + 'x' + screen.height, l: navigator.language })

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

  const api = window.kayAnalytics = { consent: choice, decide, ask, data, scope, wanted: () => wanted }

  document.addEventListener('kay:navigate', event => {
    if (!load)
      void view(event.detail.url)
  })

  document.addEventListener('click', event => {
    const opening = event.target instanceof Element && event.target.closest('[data-analytics-consent]')

    if ((gated || informed) && opening)
      ask(opening)
  })

  if ((gated || informed) && choice() === '')
    ask()

  start()
})()
`

export const NOTICE_SCRIPT = `(() => {
  const api = window.kayAnalytics
  const { data, scope } = api
  const texts = data.texts ? JSON.parse(data.texts) : {}
  let banner
  let opener

  function show(clicked) {
    if (banner)
      return

    const lang = document.documentElement.lang.split('-')[0]
    const words = texts[lang] ?? texts[Object.keys(texts)[0]] ?? {}
    const make = (tag, text) => Object.assign(document.createElement(tag), { textContent: text })
    // The site's own look: an app's --kay-notice-* first, then kayjs-ui's tokens, then the page's colours, so the notice follows its theme with no setup.
    const tone = (name, fallback) => 'var(--kay-notice-' + name + ', ' + fallback + ')'
    const paint = element => getComputedStyle(element).backgroundColor
    const painted = element => !['transparent', 'rgba(0, 0, 0, 0)'].includes(paint(element))
    const page = painted(document.body) ? paint(document.body) : painted(document.documentElement) ? paint(document.documentElement) : 'Canvas'
    const accent = tone('accent', 'var(--color-kui-accent, ' + getComputedStyle(document.body).color + ')')
    const edge = 'var(--kui-border-width, 1px) solid '
    const looks = {
      yes: 'background:' + accent + ';color:' + tone('on-accent', 'var(--color-kui-on-accent, ' + page + ')') + ';border-color:' + accent,
      no: 'background:transparent;color:inherit;border-color:' + tone('line', 'var(--color-kui-field-border, color-mix(in srgb, currentColor 45%, transparent))'),
    }
    const button = (text, value) => {
      const element = make('button', text)

      element.type = 'button'
      element.style.cssText = 'font:inherit;padding:.4em .9em;cursor:pointer;border:' + edge + ';border-radius:inherit;' + looks[value]
      element.addEventListener('click', () => api.decide(value))

      return element
    }

    banner = make('section', '')
    banner.setAttribute('aria-labelledby', 'kay-analytics-notice')
    banner.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;max-width:36rem;margin-inline:auto;padding:.75rem 1rem;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;font-size:.875rem;line-height:1.45;z-index:2147483647'
      + ';background:' + tone('background', 'var(--color-kui-surface0, ' + page + ')') + ';color:' + tone('color', 'var(--color-kui-text, inherit)')
      + ';border:' + edge + tone('border', 'var(--color-kui-overlay0, color-mix(in srgb, currentColor 22%, transparent))') + ';border-radius:' + tone('radius', 'var(--radius-kui-card, .5rem)')
      + ';box-shadow:' + tone('shadow', 'var(--kui-shadow-raised, 0 10px 32px rgb(0 0 0 / 18%), 0 1px 3px rgb(0 0 0 / 10%))')
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
    if (banner && !banner.isConnected)
      document.body.append(banner)
  })

  api.show = show
  show(api.wanted())
})()
`
