// The beacon every page loads when the app uses `vitals()`: it measures the page's LCP, CLS and INP as the dev tool does and sends them once per view, when the tab is hidden or a page swap replaces the view.
// Plain JavaScript in a string because the browser loads it as a file the server serves; its names are short and it is stripped of whitespace as the module loads, as every page pays for its size.
// `declined` is the test of the `kay_analytics` cookie: with a notice asking, nothing leaves before the visitor's yes; without one, only their opt-out stops it.
function source(declined: string) {
  return `(() => {
  const url = document.currentScript.src.slice(0, -3)
  const kinds = PerformanceObserver.supportedEntryTypes
  let path, lcp, cls, inp, sent, from, to, sum

  function start() {
    path = location.pathname
    lcp = inp = undefined
    cls = kinds.includes('layout-shift') ? 0 : undefined
    from = to = sum = 0
    sent = document.visibilityState === 'hidden'
  }

  function on(type, read, more) {
    if (kinds.includes(type))
      new PerformanceObserver(list => read(list.getEntries())).observe({ type, buffered: true, ...more })
  }

  function send() {
    if (sent || ${declined} || (lcp === undefined && cls === undefined && inp === undefined))
      return

    sent = true
    navigator.sendBeacon(url, JSON.stringify({ p: path, l: lcp, c: cls, i: inp }))
  }

  function swap() {
    send()
    start()
  }

  on('largest-contentful-paint', (list) => {
    lcp = list.at(-1).startTime
  })

  // Shifts with no recent input gather in windows, a second apart at most and five long: the score is the worst window.
  on('layout-shift', (list) => {
    for (const e of list) {
      if (e.hadRecentInput)
        continue

      if (sum && e.startTime - to < 1000 && e.startTime - from < 5000) {
        sum += e.value
      }
      else {
        from = e.startTime
        sum = e.value
      }

      to = e.startTime
      cls = Math.max(cls, sum)
    }
  })

  // The slowest interaction; the metric lets go of the worst one per 50 interactions, which a page rarely has.
  on('event', (list) => {
    for (const e of list) {
      if (e.interactionId)
        inp = Math.max(inp | 0, e.duration)
    }
  }, { durationThreshold: 40 })

  start()
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && send())
  addEventListener('pagehide', send)
  addEventListener('pageshow', e => e.persisted && swap())
  document.addEventListener('kay:navigate', swap)
})()
`
}

const scripts = new Map<boolean, string>()

// The beacon, waiting for the visitor's yes or not.
export function vitalsScript(asks: boolean): string {
  let script = scripts.get(asks)

  if (script === undefined) {
    script = new Bun.Transpiler({ minifyWhitespace: true }).transformSync(source(asks ? '!/(^|; )kay_analytics=yes(;|$)/.test(document.cookie)' : '/(^|; )kay_analytics=no(;|$)/.test(document.cookie)'))
    scripts.set(asks, script)
  }

  return script
}

const etags = new Map<boolean, string>()

// The validator of the script's text, so a browser that kept a script the config no longer builds is answered with the new one.
export function vitalsEtag(asks: boolean): string {
  let etag = etags.get(asks)

  if (etag === undefined) {
    etag = `"${Bun.hash(vitalsScript(asks)).toString(36)}"`
    etags.set(asks, etag)
  }

  return etag
}
