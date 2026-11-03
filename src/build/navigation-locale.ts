import type { BunPlugin } from 'bun'

// An `import` of `kay` that is no type import, its clause captured: `navigate`, `navigate as go` or `* as kay`.
const KAY_IMPORT = /\bimport\s+(?!type\b)([^'"`;\s][^'"`;]*)\bfrom\s*['"]kay['"]/g
const NAVIGATE_CLAUSE = /\bnavigate\b|\*\s*as\b/
const SCRIPTS = /\.(?:[cm]?[jt]s|[jt]sx)$/
const LOADERS: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx' }

// Whether the code imports `navigate` from `kay` under any name, or the whole of `kay` as a namespace.
export function importsNavigate(code: string): boolean {
  for (const [, clause = ''] of code.matchAll(KAY_IMPORT)) {
    if (NAVIGATE_CLAUSE.test(clause))
      return true
  }

  return false
}

// A module of the islands' bundle that imports `navigate` loads `kay/i18n-links`, which puts the locale prefix on the path it is given as a link's `href` has it; a `.kay` file gets the import from the compiler.
export function navigationLocale(): BunPlugin {
  return {
    name: 'kay-navigation-locale',
    setup(build) {
      build.onLoad({ filter: SCRIPTS }, async ({ path }) => {
        const code = await Bun.file(path).text()

        if (!code.includes('kay') || !importsNavigate(code))
          return undefined

        return { contents: `import 'kay/i18n-links'\n${code}`, loader: LOADERS[path.slice(path.lastIndexOf('.'))] ?? 'ts' }
      })
    },
  }
}
