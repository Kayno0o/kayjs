// The tracker every page loads: a page view on load and on each page swap, sent to the app's own origin, behind the consent gate when the app set one.
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
  const texts = data.texts ? JSON.parse(data.texts) : {}
  const load = data.load ? JSON.parse(data.load) : undefined
  let loaded = false
  let last = document.referrer
  let banner

  function choice() {
    const found = document.cookie.split('; ').find(cookie => cookie.startsWith(name + '='))

    return found ? found.slice(name.length + 1) : ''
  }

  // Waiting for a yes, or counting until the visitor opts out.
  function blocked() {
    return gated ? choice() !== 'yes' : choice() === 'no'
  }

  async function view(url) {
    if (blocked())
      return

    const body = JSON.stringify({ u: url, r: last, t: document.title, w: screen.width + 'x' + screen.height, l: navigator.language })

    last = url

    try {
      await fetch(path, { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain' }, body })
    }
    catch {}
  }

  // A provider that takes no visits from here runs its own script, loaded once the visitor agreed.
  function start() {
    if (blocked())
      return

    if (!load) {
      void view(location.href)

      return
    }

    const element = document.createElement('script')

    element.src = load.src
    element.defer = true

    for (const [key, value] of Object.entries(load.attrs))
      element.setAttribute(key, value)

    document.head.append(element)
    loaded = true
  }

  // An empty value takes the answer back, so the visitor is asked again.
  function decide(value) {
    if (value !== 'yes' && value !== 'no' && value !== '')
      return

    const counted = choice() === 'yes'

    document.cookie = name + '=' + value + '; max-age=' + (value === '' ? 0 : 31536000) + '; path=' + scope + '; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '')
    banner?.remove()
    banner = undefined
    document.dispatchEvent(new CustomEvent('kay:consent', { detail: { consent: value } }))

    if (value === 'yes' && !counted && (gated || informed))
      start()

    // A script that already ran cannot be taken back, so the page loads again without it.
    if (value !== 'yes' && loaded)
      location.reload()
    else if (value === '')
      ask()
  }

  function ask() {
    if (banner || silent || !(gated || informed))
      return

    const lang = document.documentElement.lang.split('-')[0]
    const words = texts[lang] ?? texts[Object.keys(texts)[0]] ?? {}
    const make = (tag, text) => Object.assign(document.createElement(tag), { textContent: text })
    const button = (text, value) => {
      const element = make('button', text)

      element.type = 'button'
      element.style.cssText = 'font:inherit;padding:.4em .9em;cursor:pointer'
      element.addEventListener('click', () => decide(value))

      return element
    }

    banner = make('section', '')
    banner.setAttribute('aria-labelledby', 'kay-analytics-notice')
    banner.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;max-width:36rem;margin-inline:auto;padding:1rem;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;background:Canvas;color:CanvasText;border:1px solid;border-radius:.5rem;z-index:2147483647'
    banner.append(make('p', words.text ?? ''), button(words.agree ?? 'Agree', 'yes'), button(words.refuse ?? 'Refuse', 'no'))
    banner.firstChild.id = 'kay-analytics-notice'
    banner.firstChild.style.cssText = 'margin:0;flex:1 1 14rem'
    document.body.append(banner)
  }

  window.kayAnalytics = { consent: choice, decide, ask }
  if (!load)
    document.addEventListener('kay:navigate', event => void view(event.detail.url))

  document.addEventListener('click', event => {
    if ((gated || informed) && event.target instanceof Element && event.target.closest('[data-analytics-consent]'))
      ask()
  })

  if ((gated || informed) && choice() === '')
    ask()

  start()
})()
`
