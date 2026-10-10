// Loaded by every page the dev server serves: once the page settles, axe-core checks what it rendered, each violation showing in the problem panel as a `[kay] a11y ...` warning; a page swap has the new page checked.
// It runs in the browser from its own route, so it imports nothing; axe-core loads from another route, on the first check only.
const AXE_URL = '/_kay/dev/axe.js'
// The panel and the inspector kay dev adds, which are no part of the page.
const KAY_DEV = ['kay-problems', '[data-kay-inspector]']
const MAX_ELEMENTS = 5

export interface AxeViolation {
  id: string
  help: string
  helpUrl: string
  nodes: { target: unknown[] }[]
}

interface Axe {
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

  const load = async () => new Promise<Axe>((resolve, reject) => {
    if (win.axe) {
      resolve(win.axe)

      return
    }

    const script = doc.createElement('script')

    // Gone once run, leaving the head as the server sent it, which the live reload compares.
    script.src = AXE_URL
    script.onload = script.onerror = () => {
      script.remove()

      if (win.axe)
        resolve(win.axe)
      else
        reject(new Error('axe-core did not load'))
    }
    doc.head.append(script)
  })

  const check = async () => {
    again = running

    if (running)
      return

    running = true

    try {
      do {
        again = false
        axe ??= load()

        const { violations } = await (await axe).run({ exclude: KAY_DEV.map(selector => [selector]) }, { resultTypes: ['violations'] })

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
  }

  // Once nothing more urgent waits, so the check never slows the page down.
  const idle = () => typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(() => void check()) : win.setTimeout(() => void check())

  // A page swap marks the document busy until the new page is in.
  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy'))
      idle()
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
