// The browser's stand-ins for `host.ts`: the playground compiles one file in memory, so nothing reads a project or runs Bun.

export function browserGlobals(): ReadonlySet<string> {
  return new Set()
}

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
