// An `import` or re-export of `kay` that is no type one, its clause captured: `navigate`, `navigate as go`, `* as kay` or `*`.
const KAY_IMPORT = /\b(?:import|export)\s+(?!type\b)([^'"`;\s][^'"`;]*)\bfrom\s*['"]kay['"]/g
const NAVIGATE_CLAUSE = /\bnavigate\b|\*/

// Whether the code imports `navigate` from `kay` under any name, or the whole of `kay`, which a dynamic `import('kay')` is not.
export function importsNavigate(code: string): boolean {
  for (const [, clause = ''] of code.matchAll(KAY_IMPORT)) {
    if (NAVIGATE_CLAUSE.test(clause))
      return true
  }

  return false
}

// Puts `kay/i18n-links` in a module of the islands' bundle that imports `navigate`, which then puts the locale prefix on the path it is given as a link's `href` has it; on the first line, so source maps keep theirs.
export function withLocaleLinks(code: string): string {
  return importsNavigate(code) ? `import 'kay/i18n-links';${code}` : code
}
