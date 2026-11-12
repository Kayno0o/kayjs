import type { CheckDiagnostic } from '.'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { KAY_FILE, resolveFrom, scriptLoader, transpilerFor } from '../build/files'
import { fences } from '../build/libraries'
import { loadTimeReads } from '../build/server-only'
import { browserGlobals } from '../compiler/globals'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const OUTSIDE = /^(?:node:|bun:|kay(?:\/|$))/
const HELP = 'read it inside a function the module exports, in `onMount` or `effect`, or after a `typeof window !== \'undefined\'` check; or render the component that imports it in the browser only with `--- client`'

// What a file imports as it loads: its static imports, a dynamic `import()` running later and reading nothing as the module loads.
function staticImports(file: string, source: string): string[] {
  const kay = KAY_FILE.test(file)

  try {
    return transpilerFor(kay ? 'ts' : scriptLoader(file)).scanImports(kay ? fences(source) : source).filter(entry => entry.kind !== 'dynamic-import').map(entry => entry.path)
  }
  catch {
    return []
  }
}

// A module of the project that touches a browser-only global as it loads and that a server render imports, through a component that is not `--- client` and the relative modules it pulls in: it throws on the server the first time the page is rendered, as the module is evaluated.
// A read inside a function is left out, as only a call decides whether it runs, and so is one a `typeof` or a `try` guards.
// Reported at the read, naming the first component reaching the module.
export async function browserGlobalAtLoad(root: string, components: Map<string, string>): Promise<CheckDiagnostic[]> {
  const names = browserGlobals()

  if (names.size === 0)
    return []

  const project = realpathSync(root) + sep
  const reachedFrom = new Map<string, string>()
  const queue: string[] = []
  const enqueue = (file: string, source: string, origin: string) => {
    for (const specifier of staticImports(file, source)) {
      const target = OUTSIDE.test(specifier) ? undefined : resolveFrom(specifier, file)

      if (target !== undefined && target.startsWith(project) && !target.includes(`${sep}node_modules${sep}`) && MODULE.test(target) && !DECLARATION_FILE.test(target) && !reachedFrom.has(target)) {
        reachedFrom.set(target, origin)
        queue.push(target)
      }
    }
  }

  for (const [file, source] of components) {
    if (parseKay(source).client === undefined)
      enqueue(file, source, file)
  }

  const diagnostics: CheckDiagnostic[] = []

  for (let module = queue.shift(); module !== undefined; module = queue.shift()) {
    const source = await Bun.file(module).text()
    const root = reachedFrom.get(module)!

    enqueue(module, source, root)

    for (const { name, start } of loadTimeReads(source, module, names))
      diagnostics.push({ file: module, ...positionAt(source, start), message: `\`${name}\` exists only in the browser, and this module reads it as it loads, which ${relative(project, root)} reaches on the server`, code: 'browser-global-at-load', severity: 'error', help: HELP })
  }

  return diagnostics
}
