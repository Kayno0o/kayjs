// The tracker every page loads: a page view on load and on each page swap, sent to the app's own origin, behind the consent gate when the app set one.
// Plain JavaScript in a string because the browser loads it as a file the server serves, and it must stay small: every page pays for it.
export const ANALYTICS_SCRIPT = `(() => {
  const script = document.currentScript
  const data = script.dataset
  const path = new URL(script.src).pathname.slice(0, -3)
  const name = 'kay_analytics'
  const gated = data.consent !== undefined
  const texts = data.texts ? JSON.parse(data.texts) : {}
  let last = document.referrer
  let banner

  function choice() {
    const found = document.cookie.split('; ').find(cookie => cookie.startsWith(name + '='))

    return found ? found.slice(name.length + 1) : ''
  }

  async function view(url) {
    if (gated && choice() !== 'yes')
      return

    const body = JSON.stringify({ u: url, r: last, t: document.title, w: screen.width + 'x' + screen.height, l: navigator.language })

    last = url

    try {
      await fetch(path, { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain' }, body })
    }
    catch {}
  }

  function decide(value) {
    const first = choice() === ''

    document.cookie = name + '=' + value + '; max-age=31536000; path=/; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '')
    banner?.remove()
    banner = undefined
    document.dispatchEvent(new CustomEvent('kay:consent', { detail: { consent: value } }))

    if (value === 'yes' && first)
      void view(location.href)
  }

  function ask() {
    if (banner)
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

    banner = make('aside', '')
    banner.setAttribute('aria-label', words.text ?? '')
    banner.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;max-width:36rem;margin-inline:auto;padding:1rem;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;background:Canvas;color:CanvasText;border:1px solid;border-radius:.5rem;z-index:2147483647'
    banner.append(make('p', words.text ?? ''), button(words.agree ?? 'Agree', 'yes'), button(words.refuse ?? 'Refuse', 'no'))
    banner.firstChild.style.cssText = 'margin:0;flex:1 1 14rem'
    document.body.append(banner)
  }

  window.kayAnalytics = { consent: choice, decide, ask }
  document.addEventListener('kay:navigate', event => void view(event.detail.url))
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-analytics-consent]'))
      ask()
  })

  if (gated && choice() === '')
    ask()

  void view(location.href)
})()
`
