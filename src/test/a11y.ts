import type { AxeResults } from '../runtime/dev-a11y'
import type { A11yViolation } from './page-types'
import { resolvePeer } from '../peers'
import { withUnreadable } from '../runtime/dev-a11y'

interface Axe {
  _running?: boolean
  run: (context: unknown, options: unknown) => Promise<AxeResults<Omit<A11yViolation, 'nodes'> & { nodes: { target: (string | string[])[], html: string }[] }>>
}

let axe: string | undefined

// axe-core's browser build, read once where the app installed it; a plain error naming the install command when it did not.
async function axeSource(): Promise<string> {
  axe ??= await Bun.file(resolvePeer('axe-core', 'axe-core/axe.min.js')).text()

  return axe
}

// What the page's `a11y` runs, inside the page's queue: `cdp` sends a DevTools command, `run` evaluates a function in the page with its arguments, `loaded` tells whether axe-core is there.
export async function auditA11y(
  selector: string | undefined,
  cdp: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  run: <T>(fn: (...args: never[]) => unknown, args: unknown[]) => Promise<T>,
  loaded: () => Promise<boolean>,
): Promise<A11yViolation[]> {
  // Injected again after each navigation, which drops it; through DevTools, which the page's CSP does not hold back.
  if (!await loaded()) {
    const { exceptionDetails } = await cdp<{ exceptionDetails?: { text: string, exception?: { description?: string } } }>('Runtime.evaluate', { expression: await axeSource() })

    if (exceptionDetails)
      throw new Error(`kay: axe-core did not load in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
  }

  const violations = await run<A11yViolation[] | null>(async (unreadable: typeof withUnreadable, context?: string) => {
    const { axe } = window as unknown as { axe: Axe }

    if (context !== undefined && document.querySelector(context) === null)
      return null

    // A dev server's own check may be running, and axe-core runs one at a time. This runs in the page, so it cannot reach an import such as utils' `sleep`.
    while (axe._running)
      await new Promise(resolve => setTimeout(resolve, 25))

    // Leaving out a dev server's dev tool.
    const results = await axe.run({ include: context === undefined ? document : [[context]], exclude: [['kay-dev']] }, { resultTypes: ['violations', 'incomplete'] })

    return unreadable(results).map(({ id, impact, help, helpUrl, tags, nodes }) => ({ id, impact, help, helpUrl, tags, nodes: nodes.map(node => ({ target: node.target.map(part => Array.isArray(part) ? part.join(' >>> ') : part).join(' '), html: node.html })) }))
  }, [withUnreadable, selector])

  if (violations === null)
    throw new Error(`kay: nothing matches ${selector} to check`)

  return violations
}
