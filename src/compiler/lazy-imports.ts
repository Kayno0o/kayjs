import type { ElementNode, KayFile, Node, Span } from './ast'
import type { ImportBinding } from './script-shared'
import { serverIslandOf, visitNodes } from './ast'
import { helperName } from './markup'

// What the build knows of a `.kay` module a component imports: the key its chunk is named by, and the props it draws only inside a branch that may not render, as a closed dialog does its children.
export interface ImportedComponent {
  key: string
  // `children` for the lines between its tags, else the name of a `@block`.
  deferred: readonly string[]
  // The size of its source, as a component under `LAZY_FLOOR` costs more as a chunk than it weighs.
  size: number
  // The keys of the components loaded with it: its own, and those its imports draw outside any branch that may not render, which a module importing it already holds.
  reach: readonly string[]
}

// The imported components of a file, by the specifier it imports them with.
export type ImportedComponents = Readonly<Record<string, ImportedComponent>>

// A component loaded the first time it draws, with the key that names its chunk.
export interface LazyImport {
  key: string
  specifier: string
  declaration: { start: number, end: number }
}

// The smallest source a component loads lazily: below it the request and the stub cost more than the code saves.
export const LAZY_FLOOR = 2000
const CHILDREN = 'children'
// An import of a component's default export on a line of its own, the one form a lazy import can replace.
const PLAIN_IMPORT = /^import\s+[\w$]+\s+from\s*(['"])[^'"]+\1\s*;?$/

// How often a name is written as a word of the text, in code, a string or a comment alike: a count the tag uses do not account for is another reference to it.
function occurrences(text: string, name: string): number {
  return text.match(new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))?.length ?? 0
}

// Whether the script names a prop other than as a string or a type's optional member, as `Omit<Props, 'children'>` or `children?: Snippet` do: any other mention may read it.
function reads(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$'"])${name}(?![\\w$'"])(?!\\?:)`).test(code)
}

// Walks a template noting where each component call and each `slot` stands: in a branch that may not render (an `if` or `match` branch, a `catch`) or in a block a component draws only inside such a branch, which is `deferred`. The lines of a `snippet` stay where they are written, as it is drawn where it is called.
class Positions {
  // How many repeated blocks, a loop body or a block of a function of a row, enclose the node being walked: a branch inside one is drawn by most pages, so it is no reason to split a component off.
  private repeating = 0

  constructor(private readonly source: string, private readonly deferring: (element: ElementNode) => readonly string[], private visit: { use?: (element: ElementNode, deferred: boolean) => void, outlet?: (element: ElementNode, deferred: boolean) => void }) {}

  // An `if` with an `else` or a `match` with a default always draws one of its branches: a name written in each of them is drawn at first paint, one missing from some may not be.
  private exhaustive(branches: readonly (readonly Node[])[], deferred: boolean): void {
    const real = this.visit
    const calls = branches.map((children) => {
      const seen: { name: string, element: ElementNode, deferred: boolean, outlet: boolean }[] = []

      this.visit = {
        use: (element, inner) => seen.push({ name: element.name, element, deferred: inner, outlet: false }),
        outlet: (element, inner) => seen.push({ name: element.outlet ? this.source.slice(element.outlet.name.start, element.outlet.name.end) : CHILDREN, element, deferred: inner, outlet: true }),
      }
      this.walk(children, deferred)

      return seen
    })

    this.visit = real

    const keyOf = (call: { name: string, outlet: boolean }) => `${call.outlet}:${call.name}`
    const everywhere = calls.map(seen => new Set(seen.map(keyOf)))

    for (const call of calls.flat()) {
      const always = everywhere.every(names => names.has(keyOf(call)))

      if (call.outlet)
        real.outlet?.(call.element, call.deferred || (!always && this.repeating === 0))
      else
        real.use?.(call.element, call.deferred || (!always && this.repeating === 0))
    }
  }

  walk(nodes: readonly Node[], deferred: boolean): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'element':
          this.element(node, deferred)

          break
        case 'if':
          if (node.fallback) {
            this.exhaustive([...node.branches.map(branch => branch.children), node.fallback.children], deferred)

            break
          }

          for (const branch of node.branches)
            this.walk(branch.children, deferred || this.repeating === 0)

          break
        case 'match':
          if (node.fallback) {
            this.exhaustive([...node.cases.map(branch => branch.children), node.fallback.children], deferred)

            break
          }

          for (const branch of node.cases)
            this.walk(branch.children, deferred || this.repeating === 0)

          break
        case 'for':
          this.repeating++
          this.walk(node.children, deferred)
          this.repeating--
          this.walk(node.fallback ?? [], deferred)

          break
        case 'await':
          this.walk(node.pending, deferred)
          this.walk(node.resolved?.children ?? [], deferred)
          this.walk(node.rejected?.children ?? [], true)

          break
        case 'try':
          this.walk(node.children, deferred)
          this.walk(node.rejected?.children ?? [], true)

          break
        case 'text':
          this.walk(node.parts.filter(part => part.kind === 'element'), deferred)

          break
        case 'slot':
        case 'snippet':
        case 'pending':
          this.walk(node.children, deferred)

          break
        case 'const':
        case 'error':
          break
      }
    }
  }

  private element(element: ElementNode, deferred: boolean): void {
    if (element.component)
      this.visit.use?.(element, deferred)
    else if (element.name === 'slot')
      this.visit.outlet?.(element, deferred)

    const props = element.component ? this.deferring(element) : []

    for (const child of element.children) {
      const own = child.kind === 'slot' ? this.source.slice(child.name.start, child.name.end) : CHILDREN

      const repeated = child.kind === 'slot' && child.params !== undefined

      this.repeating += repeated ? 1 : 0
      this.walk(child.kind === 'slot' ? child.children : [child], deferred || props.includes(own))
      this.repeating -= repeated ? 1 : 0
    }
  }
}

// The file with the text and the quoted attribute values of its template blanked, so what is left is code: a word naming a component is no reference when it is only written in a sentence.
function codeOf(file: KayFile): string {
  const blanks: Span[] = []

  visitNodes(file.template, (node) => {
    if (node.kind === 'text')
      blanks.push(...node.parts.filter(part => part.kind === 'chunk'))
    else if (node.kind === 'element')
      blanks.push(...node.attributes.flatMap(attribute => attribute.kind === 'static' ? [attribute.value] : []))
  })

  let code = file.source

  for (const { start, end } of blanks)
    code = `${code.slice(0, start)}${' '.repeat(end - start)}${code.slice(end)}`

  return code
}

// The text before a file's template, which is all of its script.
function fences(file: KayFile): string {
  return file.source.slice(0, file.templateStart)
}

// The props of a component it draws only where some of its own branches may not render, so what a use hands it for them is not drawn when they do not.
// A name its script mentions is left out, as it may read the prop itself.
export function deferredProps(file: KayFile, imports: readonly ImportBinding[], known: (specifier: string) => ImportedComponent | undefined): string[] {
  const specifiers = new Map(imports.filter(binding => binding.imported === 'default' && !binding.typeOnly).map(binding => [binding.local, binding.source]))
  const drawn = new Map<string, boolean>()
  const code = fences(file)

  new Positions(file.source, (element) => {
    const specifier = specifiers.get(element.name)

    return specifier === undefined ? [] : known(specifier)?.deferred ?? []
  }, {
    outlet(element, deferred) {
      const name = element.outlet ? file.source.slice(element.outlet.name.start, element.outlet.name.end) : CHILDREN

      drawn.set(name, (drawn.get(name) ?? true) && deferred)
    },
  }).walk(file.template, false)

  return [...drawn].filter(([name, deferred]) => deferred && !reads(code, name)).map(([name]) => name)
}

// The default imports of a component's script that draw only in branches that may not render, so their code loads when one does.
// An import is left alone when anything but a tag names it, as its value is then read at once, and when a call of it is a server island or a dynamic tag.
export function lazyImports(file: KayFile, imports: readonly ImportBinding[], known: ImportedComponents): Map<string, LazyImport> {
  const found = positionsLazy(file, imports, known)

  // A component another import of the file brings along as it loads is no chunk worth a request: dropping one adds what it brings, so the check goes on until nothing changes.
  for (let changed = found.size > 0; changed;) {
    const held = new Set(eagerReach(imports, known, found))

    changed = false

    for (const [local, lazy] of found) {
      if (held.has(lazy.key)) {
        found.delete(local)
        changed = true
      }
    }
  }

  return found
}

// The keys the file loads as it loads: those of the components it imports other than lazily, and what each of them brings.
export function eagerReach(imports: readonly ImportBinding[], known: ImportedComponents, lazy: ReadonlyMap<string, LazyImport>): string[] {
  const reach = new Set<string>()

  for (const binding of imports) {
    const component = binding.imported === 'default' && !binding.typeOnly ? known[binding.source] : undefined

    if (component && !lazy.has(binding.local)) {
      reach.add(component.key)

      for (const key of component.reach)
        reach.add(key)
    }
  }

  return [...reach]
}

function positionsLazy(file: KayFile, imports: readonly ImportBinding[], known: ImportedComponents): Map<string, LazyImport> {
  const candidates = new Map<string, { binding: ImportBinding, uses: boolean[] }>()
  const specifiers = new Map<string, string>()

  for (const binding of imports) {
    if (binding.imported !== 'default' || binding.typeOnly)
      continue

    specifiers.set(binding.local, binding.source)

    const declared = file.source.slice(binding.declaration.start, binding.declaration.end)

    if ((known[binding.source]?.size ?? 0) >= LAZY_FLOOR && PLAIN_IMPORT.test(declared))
      candidates.set(binding.local, { binding, uses: [] })
  }

  if (candidates.size === 0)
    return new Map()

  const refused = new Set<string>()

  new Positions(file.source, (element) => {
    const specifier = specifiers.get(element.name)

    return specifier === undefined ? [] : known[specifier]?.deferred ?? []
  }, {
    use(element, deferred) {
      const candidate = candidates.get(element.name)

      if (!candidate)
        return

      candidate.uses.push(deferred)

      if (serverIslandOf(element, file.source) !== undefined)
        refused.add(element.name)
    },
  }).walk(file.template, false)

  const code = codeOf(file)
  const found = new Map<string, LazyImport>()

  for (const [local, { binding, uses }] of candidates) {
    const written = occurrences(code, local) - 1

    if (uses.length === 0 || !uses.every(Boolean) || refused.has(local) || written !== uses.length)
      continue

    found.set(local, { key: known[binding.source]!.key, specifier: binding.source, declaration: binding.declaration })
  }

  return found
}

// Whether the file's output holds lazy imports: the browser's, and the server's render of an island or of a twin, which tells the island what it drew.
export function lazyImportsOf(file: KayFile, imports: readonly ImportBinding[], options: { components?: ImportedComponents | undefined, output?: string | undefined }, hydrated: boolean, routeFile: boolean, clientOnly: boolean): ReadonlyMap<string, LazyImport> | undefined {
  return options.components !== undefined && !(routeFile || clientOnly) && (options.output === 'dom' || hydrated) ? lazyImports(file, imports, options.components) : undefined
}

// The import the server's output adds for a lazy import: what tells the island its code is wanted.
export function lazyNoteImport(lazy: ReadonlyMap<string, LazyImport> | undefined, mode: string): string {
  return mode === 'html' && (lazy?.size ?? 0) > 0 ? `import { lazyNote as ${helperName('lazyNote')} } from 'kay/island'\n` : ''
}

// The import of the lazy runtime, only in a module that has lazy imports: a module naming it without using it still joins the chunks of every module that does, whatever the bundle drops after.
export function lazyDomImport(lazy: ReadonlyMap<string, LazyImport> | undefined): string {
  return (lazy?.size ?? 0) > 0 ? `import { lazy as ${helperName('lazy')}, ready as ${helperName('ready')} } from 'kay/dom-lazy'\n` : ''
}

// The edits rewriting the lazy imports among a hoisted statement's `imports`: the browser's code asks for the module when the component first draws, the server's draws it as it always did and notes its key.
export function lazyEdits(imports: readonly ImportBinding[], span: Span, lazy: ReadonlyMap<string, LazyImport> | undefined, mode: string, moduleId: string | undefined): { start: number, end: number, text: string }[] {
  if (mode !== 'dom' && mode !== 'html')
    return []

  const last = Math.max(-1, ...[...lazy?.values() ?? []].map(other => other.declaration.start))

  return imports.flatMap((binding) => {
    const found = lazy?.get(binding.local)

    if (!found || binding.declaration.start < span.start || binding.declaration.end > span.end)
      return []

    const key = JSON.stringify(found.key)
    const specifier = JSON.stringify(found.specifier)
    const eager = `${helperName('lazy')}_${binding.local}`

    // The island module says which keys it imports lazily and how to load the ones its server markup drew, once, after the last, so every key is registered by then.
    const ready = found.declaration.start === last ? `\nawait ${helperName('ready')}(${JSON.stringify(moduleId)}, ${JSON.stringify([...lazy?.values() ?? []].map(other => other.key))})` : ''

    return [{ ...found.declaration, text: mode === 'dom' ? `const ${binding.local} = ${helperName('lazy')}(${key}, () => import(${specifier}))${ready}` : `import ${eager} from ${specifier}\nconst ${binding.local} = ${helperName('lazyNote')}(${key}, ${eager})` }]
  })
}
