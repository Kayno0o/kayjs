import type { Diagnostic } from '../compiler/ast'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { KAY_FILE, resolveFrom, scriptLoader, transpilerFor } from '../build/files'
import { fences } from '../build/libraries'
import { loadTimeReads } from '../build/server-only'
import { browserGlobals } from '../compiler/globals'
import { parseKay } from '../compiler/parser'

const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const OUTSIDE = /^(?:node:|bun:|kay(?:\/|$))/
const HELP = 'read it inside a function, or after a `typeof window !== \'undefined\'` check, or render the component importing it in the browser only with `--- client`; `// kay-allow browser-global-at-load` allows a deliberate read'

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

export interface LoadTimeBrowserRead {
  file: string
  source: string
  diagnostic: Diagnostic
}

// A module of the project that touches a browser-only global as it loads and that a server render imports: a page, a layout or a component they render, which is not `--- client`, and the modules they pull in. It throws on the server the first time the page is rendered, as the module is evaluated.
// A read inside a function is left out, as only a call decides whether it runs, and so is one a `typeof` or a `try` guards.
// Reported at the read, naming the first component reaching the module. A component the build demotes to the browser for a package it imports, or one used with `hydrate="client"`, is still taken as rendering.
export async function browserGlobalAtLoad(root: string, components: Map<string, string>, routes: string): Promise<LoadTimeBrowserRead[]> {
  const names = browserGlobals()

  if (names.size === 0)
    return []

  const project = realpathSync(root) + sep
  const reachedFrom = new Map<string, string>()
  const rendered = new Set<string>()
  const queue: string[] = []
  const pending = [...components.keys()].filter(file => file.startsWith(routes + sep))
  const enqueue = (file: string, source: string, origin: string) => {
    for (const specifier of staticImports(file, source)) {
      const target = OUTSIDE.test(specifier) ? undefined : resolveFrom(specifier, file)

      if (target === undefined)
        continue

      if (components.has(target)) {
        if (!rendered.has(target))
          pending.push(target)
      }
      else if (target.startsWith(project) && !target.includes(`${sep}node_modules${sep}`) && MODULE.test(target) && !DECLARATION_FILE.test(target) && !reachedFrom.has(target)) {
        reachedFrom.set(target, origin)
        queue.push(target)
      }
    }
  }

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const source = components.get(file)!

    if (!rendered.has(file) && parseKay(source).client === undefined) {
      rendered.add(file)
      enqueue(file, source, file)
    }
  }

  const found: LoadTimeBrowserRead[] = []

  for (let module = queue.shift(); module !== undefined; module = queue.shift()) {
    const source = await Bun.file(module).text()
    const origin = reachedFrom.get(module)!

    enqueue(module, source, origin)

    for (const { name, start } of loadTimeReads(source, module, names))
      found.push({ file: module, source, diagnostic: { start, end: start + name.length, code: 'browser-global-at-load', message: `\`${name}\` exists only in the browser, and this module reads it as it loads, which ${relative(project, origin)} reaches on the server`, help: HELP } })
  }

  return found
}
