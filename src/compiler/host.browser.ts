// The browser's stand-ins for `host.ts`: the playground compiles one file in memory, so nothing reads a project or runs Bun.
import traverse from '@babel/traverse'

// Bundled with the page, whose chunk loads when the playground opens.
export function loadTraverse(): typeof traverse {
  return (traverse as unknown as { default?: typeof traverse }).default ?? traverse
}

export function browserGlobals(): ReadonlySet<string> {
  return new Set()
}

// A scoped style's attribute only has to differ from another module's, so it need not match Bun.hash.
export { fnvHash as hash } from './fnv-hash'

export function cwd(): string {
  return '/'
}

export function markdownHtml(): string {
  throw new Error('A markdown block needs Bun\'s Markdown parser, which the playground lacks')
}

export function markdownEntity(): undefined {
  return undefined
}

export function iconSetsOf(): undefined {
  return undefined
}
