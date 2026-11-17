import type { AxeResults } from '../runtime/dev-a11y'
import type { A11yViolation } from './page-types'
import { MissingPeerError, resolvePeer } from '../peers'
import { withUnreadable } from '../runtime/dev-a11y'

type AxeViolation = Omit<A11yViolation, 'nodes'> & { nodes: { target: (string | string[])[], html: string }[] }

interface AxeWindow {
  eval: (code: string) => unknown
  axe?: { run: (context: unknown, options: unknown) => Promise<AxeResults<AxeViolation>> }
}

// What axe-core cannot judge without a browser's layout and painting: contrast, and the size and overlap of targets. A test of those runs `page.a11y()` of a browser page.
const NEEDS_LAYOUT = ['color-contrast', 'target-size', 'scrollable-region-focusable']

const axes = new WeakSet<object>()
let axe: string | undefined

// Runs axe-core in a happy-dom document, the whole of `window.document` or the elements `selector` matches, with the rules that need no layout.
export async function auditDocument(window: AxeWindow & { document: Document }, selector: string | undefined, within?: Element): Promise<A11yViolation[]> {
  if (!axes.has(window)) {
    axe ??= await Bun.file(resolvePeer('axe-core', 'axe-core/axe.min.js')).text()
    window.eval(axe)
    axes.add(window)
  }

  const root = within ?? window.document
  const target = selector === undefined ? root : root.querySelector(selector)

  if (target === null)
    throw new Error(`kay: nothing matches ${selector} to check`)

  const rules = Object.fromEntries(NEEDS_LAYOUT.map(id => [id, { enabled: false }]))
  const results = await window.axe!.run(target, { rules, resultTypes: ['violations'] })

  return withUnreadable(results).map(({ id, impact, help, helpUrl, tags, nodes }) => ({ id, impact, help, helpUrl, tags, nodes: nodes.map(node => ({ target: node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : part).join(' '), html: node.html })) }))
}

// Checks the markup of a visited page in a document of its own: its scripts never run, as a crawler reads it, and what only a browser lays out is left to `page.a11y()`.
export async function auditHtml(html: string, selector: string | undefined): Promise<A11yViolation[]> {
  const { Window } = await loadHappyDom()
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } })

  try {
    window.document.write(html)

    // axe-core is evaluated in the window once the page's own scripts are gone.
    for (const script of window.document.querySelectorAll('script'))
      script.remove()

    window.happyDOM.settings.disableJavaScriptEvaluation = false

    return await auditDocument(window as unknown as AxeWindow & { document: Document }, selector)
  }
  finally {
    await window.happyDOM.close()
  }
}

async function loadHappyDom(): Promise<typeof import('happy-dom')> {
  try {
    return await import('happy-dom')
  }
  catch {
    throw new MissingPeerError(`happy-dom is not installed, and \`page.a11y()\` of a visited page needs it: run \`bun add -d @happy-dom/global-registrator\``)
  }
}
