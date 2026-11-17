import type { A11yViolation } from './page-types'
import { auditHtml } from './a11y-dom'
import { matchHtml } from './html-snapshot'

// What a visited page checks itself with: its accessibility, and its HTML against a baseline.
export function pageChecks(html: string): { a11y: (selector?: string) => Promise<A11yViolation[]>, matchHtml: (name: string) => Promise<void> } {
  return {
    a11y: async selector => auditHtml(html, selector),
    // The call's stack is read here, where it began, to find the test file.
    matchHtml: async name => matchHtml(new Error('the call').stack, html, name),
  }
}
