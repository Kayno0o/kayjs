import type { KayExtension } from '../config'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sep } from 'node:path'
import { CSS_FILE } from './files'

// What reads a theme the stylesheet does not import itself: `@apply`, `@variant` and the functions of Tailwind that look a token up.
const NEEDS_THEME = /@apply\b|@variant\b|\btheme\(|--(?:theme|alpha|spacing)\(/
// Tailwind's own import, whose statement the references follow: ahead of it the app's `@theme` overrides stop being written.
const TAILWIND_STATEMENT = /@import\s+(?:url\(\s*)?['"]tailwindcss['"][^;]*;/
const registered = new Map<string, string[]>()

// The stylesheets the extensions ask the app's own to reference, remembered for the root: the stylesheet build, the dev class check and the design system all read them.
export function registerReferences(root: string, extensions: KayExtension[] | undefined): void {
  registered.set(root, [...new Set((extensions ?? []).flatMap(extension => extension.references ?? []))])
}

export function referencesOf(root: string): string[] {
  return registered.get(root) ?? []
}

// `css` of `file` with an `@reference` of each stylesheet it needs right after its Tailwind import, or at its start without one, on the same line so no other line moves; unchanged for a stylesheet outside the project, one that reads no theme, or one naming the reference already.
export function withReferences(css: string, file: string, root: string, references: string[]): string {
  if (references.length === 0 || !file.startsWith(root + sep) || file.includes(`${sep}node_modules${sep}`) || !CSS_FILE.test(file) || !NEEDS_THEME.test(css))
    return css

  const missing = references.filter(reference => !css.includes(reference))

  if (missing.length === 0)
    return css

  const lines = missing.map(reference => `@reference ${JSON.stringify(reference)};`).join(' ')
  const at = TAILWIND_STATEMENT.exec(css)
  const end = at === null ? 0 : at.index + at[0].length

  return `${css.slice(0, end)}${end === 0 ? '' : ' '}${lines} ${css.slice(end)}`
}

// The stylesheet text `Bun.file(path).text()` gives inside a scope, for a plugin that reads its root by itself and offers no hook to change what it reads.
const substitutes = new AsyncLocalStorage<{ path: string, text: string }>()
let shimmed = false

export async function readingAs<T>(path: string, text: string, run: () => Promise<T>): Promise<T> {
  if (!shimmed) {
    const file = Bun.file.bind(Bun)

    shimmed = true
    Bun.file = ((...args: Parameters<typeof Bun.file>) => {
      const substitute = substitutes.getStore()

      return substitute !== undefined && typeof args[0] === 'string' && args[0] === substitute.path ? new Blob([substitute.text]) : file(...args)
    }) as typeof Bun.file
  }

  return substitutes.run({ path, text }, run)
}
