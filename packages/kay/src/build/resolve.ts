// Resolves an import the way kay build follows it: relative files, then packages through Bun's resolver; kay, node:, bun and ~ aliases stay unresolved.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function resolveImportPath(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier)
    const candidates = [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]
    for (const c of candidates) {
      if (existsSync(c))
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
