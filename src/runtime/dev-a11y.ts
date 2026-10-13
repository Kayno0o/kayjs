// Loaded by every page the dev server serves: once the page settles, axe-core checks what it rendered, each violation showing in the dev tool's problems as a `[kay] a11y ...` warning; a page swap has the new page checked.
// It runs in the browser from its own route, so it imports nothing; axe-core loads from another route, on the first check only.
const AXE_URL = '/_kay/dev/axe.js'
// The dev tool kay dev adds, no part of the page.
const KAY_DEV = ['kay-dev']
const MAX_ELEMENTS = 5
const WAIT_MS = 25

export interface AxeViolation {
  id: string
  help: string
  helpUrl: string
  nodes: { target: unknown[] }[]
}

interface Axe {
  _running?: boolean
  run: (context: unknown, options: unknown) => Promise<{ violations: AxeViolation[] }>
}

// The warning a violation logs: the rule and what it asks, then the elements breaking it, a few at most, and where it explains the fix.
export function a11yProblem(violation: AxeViolation): string {
  const elements = violation.nodes.slice(0, MAX_ELEMENTS).map(node => `  ${node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : String(part)).join(' ')}`)
  const more = violation.nodes.length > MAX_ELEMENTS ? [`  and ${violation.nodes.length - MAX_ELEMENTS} more`] : []

  return [`[kay] a11y ${violation.id}: ${violation.help}`, ...elements, ...more, violation.helpUrl].join('\n')
}

export function startA11y(doc: Document = document): () => void {
  const win = doc.defaultView! as Window & { axe?: Axe }
  let axe: Promise<Axe> | undefined
  // axe-core runs one check at a time, so a swap during one has the page checked again once it ends.
  let running = false
  let again = false

  // Imported, its browser build setting `window.axe`, rather than added as a script element, which the live reload would find in a head the server never sent.
  const load = async () => {
    if (!win.axe)
      await import(AXE_URL)

    if (!win.axe)
      throw new Error('axe-core did not load')

    return win.axe
  }

  const check = async () => {
    again = running

    if (running)
      return

    running = true

    try {
      do {
        again = false
        axe ??= load()
        const loaded = await axe

        // A test's `page.a11y()` may be running, and axe-core runs one at a time.
        while (loaded._running)
          await new Promise(resolve => win.setTimeout(resolve, WAIT_MS))

        const { violations } = await loaded.run({ exclude: KAY_DEV.map(selector => [selector]) }, { resultTypes: ['violations'] })

        for (const violation of violations)
          console.warn(a11yProblem(violation))
      } while (again)
    }
    catch (error) {
      axe = undefined
      console.error('kay: the accessibility check failed', error)
    }
    finally {
      running = false
    }

    // A swap during a check that failed.
    if (again)
      win.setTimeout(() => void check())
  }

  // Once nothing more urgent waits, so the check never slows the page down.
  const idle = () => typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(() => void check()) : win.setTimeout(() => void check())

  // A page swap marks the document busy until the new page is in.
  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy'))
      win.setTimeout(() => void check())
  })

  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })

  if (doc.readyState === 'complete')
    idle()
  else
    win.addEventListener('load', idle, { once: true })

  return () => {
    swaps.disconnect()
    win.removeEventListener('load', idle)
  }
}
