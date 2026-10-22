import type { CheckDiagnostic, CheckOptions } from '.'
import type { SignalPropFact } from '../compiler'
import type { Attribute, ElementNode, Fix, Span } from '../compiler/ast'
import type { ImportBinding } from '../compiler/script'
import { relative } from 'node:path'
import { findProjectFiles, KAY_FILE, realPath, resolveFrom } from '../build/files'
import { compileKay } from '../compiler'
import { elementsIn } from '../compiler/ast'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

const CODE = 'deprecated-signal-prop'
const FENCE_OR_BLANK = /(?:^|\n)(?:---[^\n]*)?\n$/
const CALL_PARENS = /^\s*\(\s*\)$/
const PATH = /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*$/i
const IDENTIFIER = /^[a-z_$][\w$]*$/i
const SIGNAL_MODULE = 'kay'
const BINDABLE = 'Bindable'

type Edit = Span & { text: string }

// A prop typed `Signal<T>` or `Memo<T>` of a component of the project, with where its file, source and the other props of its component stand.
interface Prop extends SignalPropFact {
  file: string
  source: string
  imports: ImportBinding[]
}

// A tag of a component passing one of these props, or maybe passing it.
interface Site {
  file: string
  source: string
  element: ElementNode
  prop: Prop
  at: Span
  // Why this tag cannot be rewritten, when it cannot.
  blocked?: string | undefined
  attribute?: Extract<Attribute, { kind: 'expression' }> | undefined
  // The prop of the file holding the tag that the tag hands on whole, which becomes a value too.
  passes?: Prop | undefined
}

// The props typed `Signal<T>` and `Memo<T>`, which kay 1.70 replaces with `Bindable<T>` and `bind:`, and plain value props: the component, every tag passing them, in the project's own files.
// A prop is rewritten with its reads and its callers together or not at all, so a tag that cannot be rewritten, a spread or an expression that is no name, leaves the prop as it is and says why.
export async function deprecatedSignalProps(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel(CODE, options.lints)

  if (level === 'allow')
    return []

  const paths = await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true })
  const sources = new Map(await Promise.all(paths.map(async path => [path, await Bun.file(path).text()] as const)))
  const props = new Map<string, Prop[]>()

  for (const [path, source] of sources) {
    if (!source.includes('props') || !(source.includes('Signal') || source.includes('Memo')))
      continue

    const own = signalPropsOf(path, source, root)

    if (own.length > 0)
      props.set(realPath(path), own)
  }

  if (props.size === 0)
    return []

  const found = [...sources].map(([path, source]) => sitesOf(path, source, props))
  const sites = found.flatMap(entry => entry.sites)

  for (const { prop, reason } of found.flatMap(entry => entry.leaks))
    prop.blocked ??= reason

  settle(sites, root)

  const severity = level === 'warn' ? 'warning' : 'error'
  const reports: CheckDiagnostic[] = []

  for (const list of props.values())
    reports.push(...childReports(list, severity))

  for (const site of sites)
    reports.push(...siteReport(site, severity))

  return reports
}

function signalPropsOf(path: string, source: string, root: string): Prop[] {
  const file = parseKay(source)
  const script = analyzeScript(source, file.script, [], [], file.module)
  let compiled: ReturnType<typeof compileKay>

  try {
    compiled = compileKay(source, path, { check: true, root })
  }
  catch {
    return []
  }

  return compiled.signalProps.map((prop) => {
    const commented = prop.calls.some(call => !CALL_PARENS.test(source.slice(call.start, call.end)))
    const blocked = prop.blocked ?? (prop.argument === undefined ? 'its type has no type argument' : undefined) ?? (commented ? 'a call reading it holds a comment' : undefined)

    return { ...prop, file: path, source, imports: script.imports, blocked }
  })
}

// Every tag in a file that passes one of the props, resolved through the file's default imports, and the props of the file it hands to a component this migration does not rewrite.
function sitesOf(path: string, source: string, props: Map<string, Prop[]>): { sites: Site[], leaks: { prop: Prop, reason: string }[] } {
  const file = parseKay(source)
  const components = new Map<string, Prop[]>()
  const known = new Set<string>()
  const imports = [...analyzeScript(source, file.script, [], [], file.module).imports, ...analyzeServer(source, file.server)?.imports ?? []]

  for (const binding of imports) {
    const resolved = binding.imported === 'default' ? resolveFrom(binding.source, path) : undefined
    const target = resolved === undefined ? undefined : props.get(realPath(resolved))

    if (resolved !== undefined && KAY_FILE.test(resolved))
      known.add(binding.local)

    if (target)
      components.set(binding.local, target)
  }

  const own = props.get(realPath(path)) ?? []
  const everyProp = [...props.values()].flat()
  const sites: Site[] = []
  const leaks: { prop: Prop, reason: string }[] = []
  const handled = new Set<Attribute>()
  const named = (element: ElementNode, key: string) => element.attributes.find((candidate): candidate is Exclude<Attribute, { kind: 'spread' }> => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === key)

  for (const element of elementsIn(file.template)) {
    if (!element.component)
      continue

    const target = components.get(element.name)

    // A tag the pass cannot follow, a named or namespace import or a member tag, may be any component: a prop it is given by a name this migration rewrites stays as it is.
    if (!target && !known.has(element.name)) {
      for (const prop of everyProp) {
        const attribute = named(element, prop.key)

        if (attribute)
          sites.push({ file: path, source, element, prop, at: attribute.name, blocked: `passes \`${prop.key}\` to \`${element.name}\`, which kay cannot tell from a component it rewrites` })
      }
    }

    for (const prop of target ?? []) {
      const attribute = named(element, prop.key)
      const site: Site = { file: path, source, element, prop, at: attribute?.name ?? element.tag }

      if (attribute === undefined) {
        if (!element.attributes.some(candidate => candidate.kind === 'spread'))
          continue

        site.blocked = `spreads props into \`${element.name}\`, which may hold \`${prop.key}\``
      }
      else if (attribute.kind === 'expression') {
        const text = source.slice(attribute.expression.start, attribute.expression.end).trim()

        site.attribute = attribute
        handled.add(attribute)

        if (!PATH.test(text))
          site.blocked = `hands \`${element.name}\` \`${prop.key}\` as \`${text}\`, which is no name or property path`
        else
          site.passes = own.find(candidate => candidate.local === text && IDENTIFIER.test(text))
      }
      else {
        continue
      }

      sites.push(site)
    }

    for (const attribute of element.attributes) {
      if (attribute.kind !== 'expression' || handled.has(attribute) || source.startsWith('bind:', attribute.name.start))
        continue

      const text = source.slice(attribute.expression.start, attribute.expression.end).trim()
      const prop = own.find(candidate => candidate.local === text)

      if (prop)
        leaks.push({ prop, reason: `it is handed to \`${element.name}\` as \`${source.slice(attribute.name.start, attribute.name.end)}\`, which this migration does not rewrite` })
    }
  }

  return { sites, leaks }
}

// A prop with a tag that cannot be rewritten stays as it is, and so does a prop of a component that hands it on to a prop that stays.
function settle(sites: Site[], root: string) {
  for (let changed = true; changed;) {
    changed = false

    for (const site of sites) {
      if (site.blocked !== undefined && site.prop.blocked === undefined) {
        const { line } = positionAt(site.source, site.at.start)

        site.prop.blocked = `${relative(root, site.file)}:${line} ${site.blocked}`
        changed = true
      }

      if (site.prop.blocked !== undefined && site.passes && site.passes.blocked === undefined) {
        site.passes.blocked = `it is handed on to \`${site.element.name}\`, whose \`${site.prop.key}\` stays as it is`
        changed = true
      }
    }
  }
}

function reasonOf(prop: Prop): string {
  return prop.blocked === undefined ? '' : `not fixed: ${prop.blocked}`
}

function bindableLocal(imports: ImportBinding[]): string {
  return imports.find(binding => binding.source === SIGNAL_MODULE && binding.imported === BINDABLE)?.local ?? BINDABLE
}

function helpFor(prop: Prop): string {
  const argument = prop.argument === undefined ? 'T' : prop.source.slice(prop.argument.start, prop.argument.end)

  return prop.kind === 'memo' ? `type it as the value, \`${prop.key}: ${argument}\`, read as \`${prop.key}\`; a parent passes \`${prop.key}={memo()}\`` : `type it \`Bindable<${argument}>\`, read as \`${prop.key}\`; a parent passes \`bind:${prop.key}={signal}\``
}

function childReports(list: Prop[], severity: 'warning' | 'error'): CheckDiagnostic[] {
  const free = list.filter(prop => prop.blocked === undefined)
  const edits = free.length === 0 ? [] : childEdits(free)
  const reports: CheckDiagnostic[] = []
  let fixed = false

  for (const prop of list) {
    const { source, file } = prop
    const type = source.slice(prop.type.start, prop.type.end)
    const memo = prop.kind === 'memo'
    const fix: Fix | undefined = !fixed && prop.blocked === undefined ? { title: free.length === 1 ? `Type \`${prop.key}\` as ${memo ? 'a value' : '`Bindable`'}` : 'Type its signal props as values and `Bindable`', edits, safe: true } : undefined

    fixed ||= fix !== undefined
    reports.push({
      file,
      ...positionAt(source, prop.type.start),
      end: prop.type.end,
      message: `The prop \`${prop.key}\` is typed \`${type}\`, a form kay 1.70 replaces`,
      help: helpFor(prop),
      ...prop.blocked === undefined ? {} : { note: reasonOf(prop) },
      code: CODE,
      severity,
      ...fix && { fixes: [fix] },
    })
  }

  return reports
}

// The text the file's edits make for all of its props at once: their types, their reads, and the `kay` import.
function childEdits(free: Prop[]): Edit[] {
  const { source, imports } = free[0]!
  const local = bindableLocal(imports)
  const edits: Edit[] = []

  for (const prop of free) {
    const argument = source.slice(prop.argument!.start, prop.argument!.end)

    edits.push({ ...prop.type, text: prop.kind === 'memo' ? argument : `${local}<${argument}>` })

    for (const call of prop.calls)
      edits.push({ ...call, text: '' })
  }

  edits.push(...importEdits(source, imports, free, local))

  return edits
}

function importEdits(source: string, imports: ImportBinding[], free: Prop[], bindable: string): Edit[] {
  const fromKay = imports.filter(binding => binding.source === SIGNAL_MODULE)
  const typed = new Set(free.map(prop => prop.imported))
  const replaced = free.map(prop => prop.type)
  const declarations = fromKay.map(binding => binding.declaration)
  // What is left of the file once the rewritten types and the imports go: a name read there keeps its import.
  let rest = ''
  let at = 0

  for (const span of [...replaced, ...declarations].sort((a, b) => a.start - b.start)) {
    if (span.start >= at)
      rest += source.slice(at, span.start)

    at = Math.max(at, span.end)
  }

  rest += source.slice(at)

  const kept = (name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest)
  const needsBindable = free.some(prop => prop.kind === 'signal') && !fromKay.some(binding => binding.imported === BINDABLE)
  const edits: Edit[] = []
  const groups = Map.groupBy(fromKay, binding => binding.declaration.start)
  let added = !needsBindable

  for (const specifiers of groups.values()) {
    const declaration = specifiers[0]!.declaration
    const touched = specifiers.some(binding => typed.has(binding.local) && !kept(binding.local))
    const adds = !added && specifiers.some(binding => typed.has(binding.local))

    if (!touched && !adds)
      continue

    const ordered = specifiers.toSorted((a, b) => a.span.start - b.span.start)
    const texts = ordered.filter(binding => !(typed.has(binding.local) && !kept(binding.local))).map(binding => source.slice(binding.span.start, binding.span.end))

    if (adds) {
      const inline = ordered.some(binding => typed.has(binding.local) && source.slice(binding.span.start, binding.span.end).startsWith('type '))

      texts.push(`${inline ? 'type ' : ''}${bindable}`)
      added = true
    }

    if (texts.length === 0) {
      let end = declaration.end + (source[declaration.end] === '\n' ? 1 : 0)

      // The blank line it stood before goes too when it stood first or after another.
      if (source[end] === '\n' && FENCE_OR_BLANK.test(source.slice(0, declaration.start)))
        end++

      edits.push({ start: declaration.start, end, text: '' })
    }
    else {
      edits.push({ start: ordered[0]!.span.start, end: ordered.at(-1)!.span.end, text: texts.join(', ') })
    }
  }

  return edits
}

function siteReport(site: Site, severity: 'warning' | 'error'): CheckDiagnostic[] {
  const { prop, source, element, attribute } = site
  const memo = prop.kind === 'memo'
  const where = { file: site.file, ...positionAt(source, site.at.start), end: site.at.end }
  const rule = memo ? `a plain value prop of \`${element.name}\`` : '`Bindable`'

  if (site.blocked !== undefined) {
    return [{ ...where, message: `\`${element.name}\` takes \`${prop.key}\` as ${rule} from kay 1.70`, note: `not fixed: this tag ${site.blocked}`, help: memo ? `pass \`${prop.key}={memo()}\`` : `pass \`bind:${prop.key}={signal}\``, code: CODE, severity }]
  }

  if (attribute === undefined || prop.blocked !== undefined)
    return []

  const text = source.slice(attribute.expression.start, attribute.expression.end).trim()
  let edits: Edit[]

  if (memo && site.passes !== undefined && site.passes.blocked === undefined)
    return []

  if (attribute.shorthand)
    edits = [{ ...attribute.shorthand, text: memo ? `${prop.key}={${text}()}` : `bind:${prop.key}={${text}}` }]
  else
    edits = memo ? [{ start: attribute.expression.end, end: attribute.expression.end, text: '()' }] : [{ ...attribute.name, text: `bind:${prop.key}` }]

  return [{ ...where, message: `\`${element.name}\` takes \`${prop.key}\` as ${rule} from kay 1.70`, help: memo ? `\`${prop.key}={${text}()}\`` : `\`bind:${prop.key}={${text}}\``, code: CODE, severity, fixes: [{ title: memo ? `Pass \`${text}()\`` : `Pass \`${text}\` with \`bind:\``, edits, safe: true }] }]
}
