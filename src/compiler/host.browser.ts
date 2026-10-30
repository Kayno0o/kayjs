// The browser's stand-ins for `host.ts`: the playground compiles one file in memory, so nothing reads a project or runs Bun.
import type { ScopeStorage } from './host'

export function browserGlobals(): ReadonlySet<string> {
  return new Set()
}

export { fnvHash as hash } from './fnv-hash'

// The playground runs no check, so a scope keeps nothing and every call computes again.
export function scopeStorage<T>(): ScopeStorage<T> {
  return { getStore: () => undefined, run: (_store, run) => run() }
}

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
