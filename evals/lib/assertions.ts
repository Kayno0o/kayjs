import type { AssertionResult } from './types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export class AssertionCollector {
  readonly results: AssertionResult[] = []

  check(name: string, condition: boolean, detail?: string): boolean {
    this.results.push(detail !== undefined ? { name, ok: condition, detail } : { name, ok: condition })
    return condition
  }

  async run(name: string, fn: () => Promise<string | undefined | void> | string | undefined | void): Promise<boolean> {
    try {
      const detail = await fn()
      this.results.push(typeof detail === 'string' && detail.length > 0 ? { name, ok: true, detail } : { name, ok: true })
      return true
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.results.push({ name, ok: false, detail: msg })
      return false
    }
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message)
}

/** Collects all `.ts` / `.tsx` source files under `<dir>/src`. */
export function readAppSourceFiles(dir: string): Map<string, string> {
  const srcDir = join(dir, 'src')
  const files = new Map<string, string>()
  if (!existsSync(srcDir))
    return files

  const walk = (cur: string, relBase: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name)
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (entry.isDirectory()) {
        walk(abs, rel)
      }
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        files.set(rel, readFileSync(abs, 'utf8'))
      }
    }
  }

  walk(srcDir, '')
  return files
}

/** Extracts `<form ... action="...">` URLs from rendered HTML. */
export function extractFormActions(html: string): string[] {
  const out: string[] = []
  for (const match of html.matchAll(/<form\b[^>]*\baction=["']([^"']+)["']/gi)) {
    const url = match[1]
    if (url !== undefined)
      out.push(url)
  }
  return out
}

/** Finds all `<a ... href="...">` values in rendered HTML. */
export function extractLinks(html: string): string[] {
  const out: string[] = []
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const href = match[1]
    if (href !== undefined)
      out.push(href)
  }
  return out
}
