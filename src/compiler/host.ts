// What the compiler asks of Bun and the file system, which a browser build swaps for the stand-ins of `host.browser.ts` through the `browser` field of package.json: the server compiler keeps these direct calls.
import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
import { fnvHash } from './fnv-hash'

export { browserGlobals } from './globals'

export interface ScopeStorage<T> {
  getStore: () => T | undefined
  run: <R>(store: T, run: () => R) => R
}

export function scopeStorage<T>(): ScopeStorage<T> {
  return new AsyncLocalStorage<T>()
}

export function cwd(): string {
  return process.cwd()
}

// ESLint runs the processor under Node.
export function hash(text: string): string {
  return typeof Bun === 'undefined' ? fnvHash(text) : Bun.hash(text).toString(36)
}

export function markdownHtml(text: string, options: { autolinks: boolean }): string {
  return Bun.markdown.html(text, options)
}

// The HTML Markdown's parser makes of one raw-HTML entity, or none when there is no parser (the ESLint bundle).
export function markdownEntity(entity: string): string | undefined {
  return typeof Bun === 'undefined' || !('markdown' in Bun) ? undefined : Bun.markdown.html(entity)
}
