// Resolves an import the way kay build follows it: relative files, then packages through Bun's resolver; kay, node:, bun and ~ aliases stay unresolved.

import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const KAY_SRC_ROOT = resolve(import.meta.dir, '..')

export function resolveImportPath(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier)
    const candidates = [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]
    for (const c of candidates) {
      if (statSync(c, { throwIfNoEntry: false })?.isFile())
        return c
    }
    return undefined
  }
  if (
    specifier === 'kay'
    || specifier.startsWith('kay/')
    || specifier.startsWith('@kayjs/kay')
    || specifier.startsWith('node:')
    || specifier.startsWith('bun')
    || specifier.startsWith('~')
  ) {
    return undefined
  }
  try {
    const resolved = Bun.resolveSync(specifier, dirname(fromFile))
    return resolved.endsWith('.tsx') || resolved.endsWith('.ts') ? resolved : undefined
  }
  catch {
    return undefined
  }
}

const KAY_SPECIFIER_FILES = new Map([
  ['kay', 'index.ts'],
  ['kay/dom', 'dom/index.ts'],
  ['kay/dom-extras', 'dom/extras.ts'],
  ['kay/dom-loop', 'dom/loop.ts'],
  ['kay/action', 'dom/action.ts'],
  ['kay/island', 'dom/island.ts'],
  ['kay/ssr', 'ssr/index.ts'],
  ['kay/server', 'server/index.ts'],
  ['kay/compiler', 'compiler/index.ts'],
  ['kay/build', 'build/index.ts'],
  ['kay/dev', 'dev/index.ts'],
  ['kay/test', 'test/index.ts'],
  ['kay/jsx-runtime', 'jsx-runtime.ts'],
  ['kay/jsx-dev-runtime', 'jsx-runtime.ts'],
])

/** Maps `kay`, `kay/<subpath>` and the `@kayjs/kay` spelling of both to their source file. */
export function resolveKaySpecifier(specifier: string): string | undefined {
  const file = KAY_SPECIFIER_FILES.get(specifier.startsWith('@kayjs/') ? specifier.slice('@kayjs/'.length) : specifier)
  return file === undefined ? undefined : join(KAY_SRC_ROOT, file)
}
