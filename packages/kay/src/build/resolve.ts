// Resolves an import the way kay build follows it: relative files, then packages through Bun's resolver; kay, node:, bun and ~ aliases stay unresolved.

import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }

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
    || specifier === '@kayjs/kay'
    || specifier.startsWith('@kayjs/kay/')
    || specifier.startsWith('node:')
    || specifier === 'bun'
    || specifier.startsWith('bun:')
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

const KAY_SPECIFIER_FILES = new Map<string, string>(
  Object.entries(pkg.exports as Record<string, string>).map(([subpath, target]) => [
    subpath === '.' ? 'kay' : `kay/${subpath.slice(2)}`,
    target.replace(/^\.\/src\//, ''),
  ]),
)

/** Maps `kay`, `kay/<subpath>` and the `@kayjs/kay` spelling of both to their source file. */
export function resolveKaySpecifier(specifier: string): string | undefined {
  const file = KAY_SPECIFIER_FILES.get(specifier.startsWith('@kayjs/') ? specifier.slice('@kayjs/'.length) : specifier)
  return file === undefined ? undefined : join(KAY_SRC_ROOT, file)
}
