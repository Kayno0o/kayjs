import type { Diagnostic } from '../compiler/ast'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { KAY_FILE, resolveFrom, scriptLoader, transpilerFor } from '../build/files'
import { fences } from '../build/libraries'
import { loadTimeReads } from '../build/server-only'
import { clientOnlyIsland } from '../build/transform'
import { visitNodes } from '../compiler/ast'
import { browserGlobals } from '../compiler/globals'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'

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
// Reported at the read, naming the first component reaching the module. What the server never renders is left out: a component used only with `hydrate="client"`, and an island the build demotes to the browser for a package it imports, asked as the build asks.
export async function browserGlobalAtLoad(root: string, components: Map<string, string>, routes: string, cacheDir?: string): Promise<LoadTimeBrowserRead[]> {
  const names = browserGlobals()

  if (names.size === 0)
    return []

  const project = realpathSync(root) + sep
  const reachedFrom = new Map<string, string>()
  const rendered = new Set<string>()
  const queue: string[] = []
  const pending = [...components.keys()].filter(file => file.startsWith(routes + sep))
  const enqueue = (file: string, source: string, origin: string) => {
    const skipped = KAY_FILE.test(file) ? clientOnlyImports(source) : new Set<string>()

    for (const specifier of staticImports(file, source)) {
      const target = OUTSIDE.test(specifier) ? undefined : resolveFrom(specifier, file)

      if (target === undefined)
        continue

      if (components.has(target)) {
        if (!rendered.has(target) && !skipped.has(specifier))
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

    // A page or a layout renders on the server whatever it imports; another component may be switched to the browser.
    const skip = rendered.has(file) || parseKay(source).client !== undefined || (!file.startsWith(routes + sep) && await demoted(source, file, cacheDir))

    if (!skip) {
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

// The specifiers a component imports only to use them with `hydrate="client"`, which the server never renders.
function clientOnlyImports(source: string): Set<string> {
  const file = parseKay(source)
  const uses = new Map<string, boolean>()

  visitNodes(file.template, (node) => {
    if (node.kind === 'element' && node.component) {
      const client = node.attributes.some(attribute => attribute.kind === 'static' && source.slice(attribute.name.start, attribute.name.end) === 'hydrate' && attribute.text === 'client')

      uses.set(node.name, (uses.get(node.name) ?? true) && client)
    }
  })

  const bindings = Map.groupBy(analyzeScript(source, file.script, [], file.module).imports, binding => binding.source)

  return new Set([...bindings].filter(([, group]) => group.every(binding => uses.get(binding.local) === true)).map(([specifier]) => specifier))
}

// The build's own question, whether the island's packages throw as they load; a probe that cannot answer, a builtin imported without its `node:` prefix say, leaves the island rendering on the server.
async function demoted(source: string, file: string, cacheDir: string | undefined): Promise<boolean> {
  try {
    return await clientOnlyIsland(source, file, cacheDir)
  }
  catch {
    return false
  }
}
