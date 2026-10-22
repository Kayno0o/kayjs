import type { KayExtension } from '../config'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sep } from 'node:path'
import { loadConfig } from '../config'
import { CSS_FILE } from './files'

// What reads a theme the stylesheet does not import itself: `@apply`, `@variant` and the functions of Tailwind that look a token up.
const COMMENT = /\/\*[\s\S]*?\*\//g
const NEEDS_THEME = /@apply\b|@variant\b|\btheme\(|--(?:theme|alpha|spacing)\(/
// Tailwind's own import, whose statement the references follow: ahead of it the app's `@theme` overrides stop being written.
const TAILWIND_STATEMENT = /@import\s+(?:url\(\s*)?['"]tailwindcss['"][^;]*;/
const registered = new Map<string, string[]>()

// The stylesheets the extensions ask the app's own to reference, remembered for the root: the stylesheet build, the dev class check and the design system all read them.
export function registerReferences(root: string, extensions: KayExtension[] | undefined): void {
  registered.set(root, [...new Set((extensions ?? []).flatMap(extension => extension.references ?? []))])
}

// For a process that builds nothing, as the formatter: the references the config's extensions list, read once per root; none when the config does not load.
export async function loadReferences(root: string): Promise<void> {
  if (registered.has(root))
    return

  try {
    registerReferences(root, (await loadConfig(root)).extensions)
  }
  catch {
    registered.set(root, [])
  }
}

export function referencesOf(root: string): string[] {
  return registered.get(root) ?? []
}

// Whether `file` is a stylesheet of the app itself, which is the only kind given references.
export function referenceable(file: string, root: string): boolean {
  return CSS_FILE.test(file) && file.startsWith(root + sep) && !file.includes(`${sep}node_modules${sep}`)
}

// `css` of `file` with an `@reference` of each stylesheet right after its Tailwind import, or at its start without one, on the same line so no other line moves; unchanged for a stylesheet outside the project, one that neither imports Tailwind nor reads a theme, or one holding the reference's exact text already.
// A stylesheet importing Tailwind gets them whether it applies anything or not, as the `@apply` may sit in a stylesheet it imports, and a reference writes no rule.
export function withReferences(css: string, file: string, root: string, references: string[]): string {
  if (references.length === 0 || !referenceable(file, root))
    return css

  const bare = css.replace(COMMENT, comment => ' '.repeat(comment.length))
  const at = TAILWIND_STATEMENT.exec(bare)

  if (at === null && !NEEDS_THEME.test(bare))
    return css

  const missing = references.filter(reference => !css.includes(reference))

  if (missing.length === 0)
    return css

  const lines = missing.map(reference => `@reference ${JSON.stringify(reference)};`).join(' ')
  const end = at === null ? 0 : at.index + at[0].length

  return `${css.slice(0, end)}${end === 0 ? '' : ' '}${lines} ${css.slice(end)}`
}

// The stylesheet text `Bun.file(path).text()` gives inside a scope, for a plugin that reads its root by itself and offers no hook to change what it reads.
const substitutes = new AsyncLocalStorage<{ path: string, text: string }>()
let shim: typeof Bun.file | undefined

export async function readingAs<T>(path: string, text: string, run: () => Promise<T>): Promise<T> {
  // A test restoring the original `Bun.file` after a spy takes the shim out, so it is put in again.
  if (shim === undefined || Bun.file !== shim) {
    const file = Bun.file.bind(Bun)

    Bun.file = shim = ((...args: Parameters<typeof Bun.file>) => {
      const substitute = substitutes.getStore()

      return substitute !== undefined && typeof args[0] === 'string' && args[0] === substitute.path ? new Blob([substitute.text]) : file(...args)
    }) as typeof Bun.file
  }

  return substitutes.run({ path, text }, run)
}
