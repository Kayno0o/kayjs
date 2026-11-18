import type { IfBranch, IfNode, Span } from './ast'

const UNSET_NAME = /^(?:aria|data)-/

function text(src: string, span: Span): string {
  return src.slice(span.start, span.end).trim()
}

// A branch whose test is the literal `false`, which a build writes for a feature no call site uses: it is never taken, so the code leaves it out.
export function neverTaken(src: string, branch: IfBranch): boolean {
  return branch.alias === undefined && text(src, branch.test) === 'false'
}

// An `if` with no `else` that draws nothing: the markup keeps its markers and the code has no block to run for them.
export function neverShown(src: string, node: IfNode): boolean {
  return node.fallback === undefined && node.branches.every(branch => neverTaken(src, branch))
}

// An `aria-` or `data-` attribute written `{undefined}`, as a build leaves one of a feature no call site uses: it is never set.
export function neverSet(src: string, attribute: { name: string, expression: Span, action: boolean }): boolean {
  return !attribute.action && UNSET_NAME.test(attribute.name) && text(src, attribute.expression) === 'undefined'
}
