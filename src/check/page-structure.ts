import type { CheckDiagnostic } from './index'
import type { SiteSeo } from './seo'
import { lintLevel } from '../compiler/lints'

const BODY = /<body[\s>]/i
const MAIN = /<main[\s>]|\srole=["']?main\b/i
const HEADING = /<h1[\s>]/i

// What the prerendered pages leave out for a screen reader to move by: a `main` landmark and an `h1`.
export function pageStructureLints(config: Pick<SiteSeo, 'lints'>, pages: { path: string, file: string, html: string }[]): CheckDiagnostic[] {
  const level = lintLevel('unstructured-page', config.lints)

  if (level === 'allow')
    return []

  return pages.flatMap((page) => {
    if (!BODY.test(page.html))
      return []

    const missing = [...MAIN.test(page.html) ? [] : ['no `main`'], ...HEADING.test(page.html) ? [] : ['no `h1`']]

    if (missing.length === 0)
      return []

    return [{ file: page.file, line: 1, column: 1, code: 'unstructured-page', severity: level === 'warn' ? 'warning' as const : 'error' as const, message: `\`${page.path}\` has ${missing.join(' and ')}`, note: 'screen reader users jump to the main content and move through a page by its headings', help: 'wrap the content in a `main` in the page or its layout, and open it with an `h1`' }]
  })
}
