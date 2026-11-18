import type { Dirent } from 'node:fs'
import { readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { elementsIn } from '../compiler/ast'
import { changeName } from '../compiler/bound-props'
import { parseExpanded } from '../compiler/markdown-block'

// A component names the features an app may leave out with `uses('selectable')`, the `uses` it imports from kayjs-ui's marker module: a call that is true while the prop is there to be written, and that a browser build replaces with `true` or `false` once it has read the props the files of the project write at their call sites. See `specializedSource`.
const USES_CALL = /\buses\(\s*'(\w+)'(\s*,\s*true)?\s*\)/y
const KAY_IMPORT = /^import\s+(\w+)\s+from\s+(["'])([^"'\n]+\.kay)\2/gm
// A component the compiler imports lazily, `KayLazy(key, () => import("./it.kay"))`.
const LAZY_IMPORT = /\bimport\(\s*(["'])([^"'\n]+\.kay)\1\s*\)/g
const USES_IMPORT = /^import\s*\{[^}]*\buses\b[^}]*\}\s*from\s*(["'])([^"'\n]+)\1/m
// The marker module, by where the library keeps it: an app's own `uses` is another function.
const MARKER_FILE = /(?:packages\/ui|@kayjs\/ui)\/src\/uses\.ts$/
// A line opening a fence, whose last one precedes the template.
const FENCE = /^---(?:\s|$)/
// A template `if` or `else if` whose condition calls `uses()`.
const USES_IF = /^([ \t]*)((?:else )?if) (.*\buses\(.*)$/
const IDENTIFIER_CHAR = /[\w$.]/
const BACKSLASH = /\\/g

// The suffix an import of a variant carries: the features, joined by dashes (a dot would end the stem of the file name the bundler gives an entry), the call sites of the project use.
// `~` and the props the call sites write follow when the project reads them all: the props a spread may carry are not known.
export const USES_QUERY = /\.kay\?uses=([\w-]*)(?:~([\w-]*))?$/
const VARIANT_INPUT = /^kay-variant:|\?uses=[\w~-]*$/g

// A path the bundler names for a variant, as the file it is made from.
export function variantFile(input: string): string {
  return input.replace(VARIANT_INPUT, '')
}

// Whether `source` imports `uses` from the marker module, which makes its calls the marker's.
function importsMarker(source: string, file: string): boolean {
  const hit = USES_IMPORT.exec(source)

  if (hit === null)
    return false

  try {
    return MARKER_FILE.test(Bun.resolveSync(hit[2]!, dirname(file)).replace(BACKSLASH, '/'))
  }
  catch {
    return false
  }
}

// What a `/` after one of these opens is a regular expression, not a division.
const BEFORE_REGEX = /[(,=:[!&|?{};<>+\-*%~^]/
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$.])(?:return|typeof|case|in|of|yield|await|void|delete|throw|else|do)$/

// Whether a `/` after `before` opens a regular expression, `last` being the last code character of it.
function opensRegex(before: string, last: string): boolean {
  // A `/` after a postfix `++` or `--` divides.
  if ((last === '+' || last === '-') && before.trimEnd().endsWith(last + last))
    return false

  return last === '' || BEFORE_REGEX.test(last) || (IDENTIFIER_CHAR.test(last) && KEYWORD_BEFORE_REGEX.test(before.trimEnd()))
}

// `text` with each marker call outside comments, strings and regular expressions replaced by what `answer` says of its feature. The code in a template literal's `${}` counts.
function replaceCalls(text: string, answer: (feature: string, onByDefault: boolean) => string): string {
  let out = ''
  let quote = ''
  let at = 0
  // The brace depth of each `${` open in a template literal.
  const holes: number[] = []
  let last = ''

  while (at < text.length) {
    const char = text[at]!

    if (quote !== '') {
      out += char

      if (char === '\\' && at + 1 < text.length) {
        out += text[++at]!
      }
      else if (quote === '`' && char === '$' && text[at + 1] === '{') {
        out += '{'
        at++
        holes.push(0)
        quote = ''
        last = '{'
      }
      else if (char === quote || (char === '\n' && quote !== '`')) {
        last = quote
        quote = ''
      }

      at++

      continue
    }

    if (char === '/' && (text[at + 1] === '/' || text[at + 1] === '*')) {
      const block = text[at + 1] === '*'
      const end = text.indexOf(block ? '*/' : '\n', at + 2)
      const next = end === -1 ? text.length : end + (block ? 2 : 0)

      out += text.slice(at, next)
      at = next

      continue
    }

    if (char === '/' && opensRegex(out, last)) {
      let end = at + 1
      let inClass = false

      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
        if (text[end] === '\\' && text[end + 1] !== '\n')
          end++
        else if (text[end] === '[')
          inClass = true
        else if (text[end] === ']')
          inClass = false

        end++
      }

      out += text.slice(at, end + 1)
      at = end + 1
      last = '/'

      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      out += char
      at++

      continue
    }

    if (holes.length > 0 && (char === '{' || char === '}')) {
      if (char === '{') {
        holes[holes.length - 1]!++
      }
      else if (holes[holes.length - 1] === 0) {
        holes.pop()
        quote = '`'
      }
      else {
        holes[holes.length - 1]!--
      }
    }

    if (char === 'u' && !IDENTIFIER_CHAR.test(text[at - 1] ?? '')) {
      USES_CALL.lastIndex = at

      const call = USES_CALL.exec(text)

      if (call !== null) {
        out += answer(call[1]!, call[2] !== undefined)
        at += call[0].length
        last = ')'

        continue
      }
    }

    out += char
    at++

    if (char.trim() !== '')
      last = char
  }

  return out
}

// The features a component names, and which of them are on when the prop is left out: `uses('sortable', true)`.
interface Declared {
  names: string[]
  defaults: ReadonlySet<string>
}

const NONE: Declared = { names: [], defaults: new Set() }
const featuresOf = new Map<string, { stamp: number, declared: Promise<Declared> }>()

function usesIn(source: string, file: string): Declared {
  if (file !== '' && !importsMarker(source, file))
    return NONE

  const found = new Set<string>()
  const defaults = new Set<string>()

  replaceCalls(source, (feature, onByDefault) => {
    found.add(feature)

    if (onByDefault)
      defaults.add(feature)

    return ''
  })

  return { names: [...found], defaults }
}

// The features a text names: the `uses('x')` of a file importing the marker, none otherwise.
export function usesNames(source: string, file = ''): string[] {
  return usesIn(source, file).names
}

async function readNames(path: string): Promise<Declared> {
  try {
    return usesIn(await Bun.file(path).text(), path)
  }
  catch {
    return NONE
  }
}

// The features a component file names, read again when the file changes: none when it has no marker call or cannot be read.
async function declaredFeatures(path: string): Promise<Declared> {
  let stamp = 0

  try {
    stamp = (await stat(path)).mtimeMs
  }
  catch {
    return NONE
  }

  const kept = featuresOf.get(path)

  if (kept?.stamp === stamp)
    return kept.declared

  const declared = readNames(path)

  featuresOf.set(path, { stamp, declared })

  return declared
}

// Whether a condition made of `true`, `false` and anything else, joined by `&&` and `||`, is `false` whatever the rest holds.
function alwaysFalse(condition: string): boolean {
  const text = condition.trim()
  const terms = splitTop(text, '||')

  if (terms === undefined)
    return false

  return terms.every((term) => {
    const factors = splitTop(term, '&&')

    if (factors === undefined)
      return false

    return factors.some((factor) => {
      const inner = factor.trim()

      return inner === 'false' || (inner.startsWith('(') && inner.endsWith(')') && splitTop(inner, '&&')?.length === 1 && alwaysFalse(inner.slice(1, -1)))
    })
  })
}

// `text` cut at the `operator`s outside brackets and strings; undefined for a text holding a `?`, whose precedence this does not read.
function splitTop(text: string, operator: '&&' | '||'): string[] | undefined {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let from = 0

  for (let at = 0; at < text.length; at++) {
    const char = text[at]!

    if (quote !== '') {
      if (char === '\\')
        at++
      else if (char === quote)
        quote = ''
    }
    else if (char === '\'' || char === '"' || char === '`') {
      quote = char
    }
    else if (char === '(' || char === '[' || char === '{') {
      depth++
    }
    else if (char === ')' || char === ']' || char === '}') {
      depth--
    }
    else if (char === '?' && depth === 0) {
      return undefined
    }
    else if (depth === 0 && text.startsWith(operator, at)) {
      parts.push(text.slice(from, at))
      at += operator.length - 1
      from = at + 1
    }
  }

  parts.push(text.slice(from))

  return parts
}

// The depth-0 positions of `char` in `text`, outside brackets and strings; a `?.` and a `??` are no ternary.
function topLevel(text: string, char: '?' | ':'): number[] {
  const found: number[] = []
  let depth = 0
  let quote = ''

  for (let at = 0; at < text.length; at++) {
    const here = text[at]!

    if (quote !== '') {
      if (here === '\\')
        at++
      else if (here === quote)
        quote = ''
    }
    else if (here === '\'' || here === '"' || here === '`') {
      quote = here
    }
    else if (here === '(' || here === '[' || here === '{') {
      depth++
    }
    else if (here === ')' || here === ']' || here === '}') {
      depth--
    }
    else if (here === char && depth === 0 && (char === ':' || (text[at + 1] !== '.' && text[at + 1] !== '?'))) {
      found.push(at)
    }
  }

  return found
}

// An arrow, an assignment or a comma in a condition binds looser than the ternary, so what comes before the `?` is not the whole test.
const LOWER_THAN_TERNARY = /=>|,|(?<![=!<>])=(?!=)/

// An attribute `name={cond ? value : undefined}` whose condition is false is `{undefined}`, which the compiler leaves unbound. Only a ternary with no other at its top level is read.
function foldAbsentAttributes(line: string): string {
  let result = line
  let from = 0

  for (;;) {
    const open = result.indexOf('={', from)

    if (open === -1)
      return result

    const start = open + 2
    let depth = 1
    let end = start

    for (; end < result.length && depth > 0; end++) {
      if (result[end] === '{')
        depth++
      else if (result[end] === '}')
        depth--
    }

    const inner = result.slice(start, end - 1)
    const question = topLevel(inner, '?')[0]
    const colons = topLevel(inner, ':')

    from = start

    if (depth === 0 && question !== undefined && colons.length === 1 && inner.slice(colons[0]! + 1).trim() === 'undefined' && !LOWER_THAN_TERNARY.test(inner.slice(0, question)) && alwaysFalse(inner.slice(0, question)))
      result = `${result.slice(0, start)}undefined${result.slice(end - 1)}`
  }
}

// A destructured default that only an absent feature reads, `label = uses('x') ? wording('a', 'A') : ''` once the call is false: the closure it would make is left out.
const ABSENT_DEFAULT = / = false(?: \|\| false)* \? wording\([^()]*\) : ''/g
const DEAD_SPREAD = /^(\s*)\.\.\.\(false(?: \|\| false)*\)\s*$/

// A recipe part group `...(uses('x')) ? { ... } : {}` whose condition is false, written on lines like that, is blanked.
function blankDeadSpreads(lines: string[], from: number): void {
  for (let at = 0; at < from; at++) {
    const hit = DEAD_SPREAD.exec(lines[at]!)

    if (hit === null)
      continue

    const end = lines.findIndex((line, index) => index > at && line === `${hit[1]}  : {},`)

    if (end === -1)
      continue

    for (let blank = at; blank <= end; blank++)
      lines[blank] = ''

    at = end
  }
}

// The source with each `uses('x')` of its script and of its template lines as `true` when `x` is among `present`, `false` otherwise, and a template `if` that cannot hold with them reduced to `if false` with its lines blanked: the block keeps its markers for the server markup the island hydrates, and the lines keep their numbers for the source map. An `else` after a blanked block still follows it. A `file` that does not import the marker is returned as it is.
export function specializedSource(source: string, present: ReadonlySet<string>, file = ''): string {
  if (file !== '' && !importsMarker(source, file))
    return source

  const lines = source.split('\n')
  const replaced = (text: string) => replaceCalls(text, name => present.has(name) ? 'true' : 'false')
  // The template starts after the last fence line.
  const template = lines.findLastIndex(line => FENCE.test(line)) + 1

  // The script as one text, so a comment or a template literal over several lines is read as one; the answers hold no newline, so the lines keep their numbers.
  lines.splice(0, template, ...replaced(lines.slice(0, template).join('\n')).replace(ABSENT_DEFAULT, '').split('\n'))
  blankDeadSpreads(lines, template)

  for (let at = template; at < lines.length; at++) {
    const hit = USES_IF.exec(lines[at]!)

    if (hit === null) {
      // A call in an attribute or a text expression is folded as one in the script.
      if (lines[at]!.includes('uses('))
        lines[at] = foldAbsentAttributes(replaced(lines[at]!))

      continue
    }

    const condition = replaced(hit[3]!)

    if (!alwaysFalse(condition)) {
      lines[at] = `${hit[1]}${hit[2]} ${condition}`

      continue
    }

    const indent = hit[1]!.length

    lines[at] = `${hit[1]}${hit[2]} false`

    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]!

      if (line.trim() !== '' && line.length - line.trimStart().length <= indent)
        break

      lines[next] = ''
      at = next
    }
  }

  return lines.join('\n')
}

// Stands for every prop of a component: it is called with a spread or read as a value, so any may be written.
export const ANY = Symbol('any')

// What stands for a call that leaves a feature on by default (`uses('x', true)`) on: the prop left out or written with anything but a literal `false`.
const ON_PREFIX = '+'
const PROP_NAME = /^\w+$/

// The props the call sites of each `.kay` component a file imports write, by the name the file gives it; `defaults` names, by local, the features on when the prop is left out, which a call keeps on by adding `+name`.
export function propsWritten(source: string, locals: readonly string[], defaults: ReadonlyMap<string, ReadonlySet<string>> = new Map()): Map<string, Set<string> | typeof ANY> {
  const { file } = parseExpanded(source)
  const written = new Map<string, Set<string>>()
  const calls = new Map<string, number>()
  const open = new Set(locals)

  for (const element of elementsIn(file.template)) {
    if (!element.component || !locals.includes(element.name))
      continue

    calls.set(element.name, (calls.get(element.name) ?? 0) + 1)

    const props = written.get(element.name) ?? new Set<string>()

    written.set(element.name, props)

    const off = new Set<string>()

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        open.delete(element.name)

        continue
      }

      const name = source.slice(attribute.name.start, attribute.name.end)

      // A `bind:x` hands the component `x` and `onXChange`, as the compiler writes them.
      if (name.startsWith('bind:') && name.length > 5) {
        props.add(name.slice(5))
        props.add(changeName(name.slice(5)))

        continue
      }

      props.add(name)

      if (attribute.kind === 'expression' && source.slice(attribute.expression.start, attribute.expression.end).trim() === 'false')
        off.add(name)
    }

    for (const feature of defaults.get(element.name) ?? []) {
      if (!off.has(feature))
        props.add(ON_PREFIX + feature)
    }

    for (const child of element.children) {
      props.add(child.kind === 'slot' ? source.slice(child.name.start, child.name.end) : 'children')
    }
  }

  for (const local of locals) {
    // The import names it once, each call once more.
    if ((source.match(new RegExp(`\\b${local}\\b`, 'g'))?.length ?? 0) !== 1 + (calls.get(local) ?? 0))
      open.delete(local)
  }

  return new Map(locals.map(local => [local, open.has(local) ? written.get(local) ?? new Set<string>() : ANY]))
}

interface Candidate {
  local: string
  specifier: string
  path: string
  features: string[]
  defaults: ReadonlySet<string>
}

// The `.kay` components a file imports that name features.
async function candidatesOf(code: string, file: string): Promise<Candidate[]> {
  const found: Candidate[] = []

  for (const [local, specifier] of [...code.matchAll(KAY_IMPORT).map(([, name, , from]) => [name!, from!] as const), ...code.matchAll(LAZY_IMPORT).map(([, , from]) => ['', from!] as const)]) {
    let path: string

    try {
      path = Bun.resolveSync(specifier, dirname(file))
    }
    catch {
      continue
    }

    const { names: features, defaults } = await declaredFeatures(path)

    if (features.length > 0)
      found.push({ local, specifier, path, features, defaults })
  }

  return found
}

// What the `.kay` files of a project write of each component with features, all of them together: a component has one variant, so the chunks of two islands using a Table share it.
export class VariantIndex {
  private readonly union = new Map<string, Set<string> | typeof ANY>()
  private readonly indexed = new Map<string, Promise<void>>()
  private scan: Promise<void> | undefined

  // `files` are the `.kay` files to read, or the directory to find them under.
  constructor(private readonly files: string | readonly string[]) {}

  // Reads the project's files once, as the bundler asks for the first variant.
  private async scanned(): Promise<void> {
    this.scan ??= (async () => {
      for (const file of typeof this.files === 'string' ? kayFiles(this.files) : this.files)
        await this.add(file, await Bun.file(file).text())
    })()

    return this.scan
  }

  // A file read once: a second ask waits for the first, so it sees the union with that file in it.
  private async add(file: string, source: string): Promise<void> {
    let done = this.indexed.get(file)

    if (done === undefined) {
      done = this.read(file, source)
      this.indexed.set(file, done)
    }

    return done
  }

  private async read(file: string, source: string): Promise<void> {
    const candidates = (await candidatesOf(source, file)).filter(candidate => candidate.local !== '')

    if (candidates.length === 0)
      return

    let written: ReturnType<typeof propsWritten>

    try {
      written = propsWritten(source, candidates.map(candidate => candidate.local), new Map(candidates.map(candidate => [candidate.local, candidate.defaults])))
    }
    catch {
      written = new Map(candidates.map(candidate => [candidate.local, ANY]))
    }

    for (const { local, path } of candidates) {
      const props = written.get(local) ?? new Set<string>()
      const before = this.union.get(path)

      this.union.set(path, before === ANY || props === ANY ? ANY : new Set([...before ?? [], ...props]))
    }
  }

  // The query of a variant: its features, then the props written.
  private usedOf(path: string, features: string[], defaults: ReadonlySet<string>): string {
    const props = this.union.get(path) ?? new Set<string>()

    if (props === ANY)
      return [...features].sort().join('-')

    return `${features.filter(feature => props.has(defaults.has(feature) ? ON_PREFIX + feature : feature)).toSorted().join('-')}~${[...props].filter(name => PROP_NAME.test(name)).sort().join('-')}`
  }

  // An island entry that is a component with features, as the variant the project's call sites need; any other file as it is.
  async entry(path: string): Promise<string> {
    const { names, defaults } = await declaredFeatures(path)

    if (names.length === 0)
      return path

    await this.scanned()

    return `${path}?uses=${this.usedOf(path, names, defaults)}`
  }

  // The imports of the compiled `code` of `file` that name a component with features, pointed at the one variant the project's call sites need: `import Table from './table.kay'` as `./table.kay?uses=pageSize`. `source` is the file's own, for one the scan did not meet.
  async variantImports(code: string, file: string, source: string): Promise<string> {
    const candidates = await candidatesOf(code, file)

    if (candidates.length === 0)
      return code

    await this.scanned()
    await this.add(file, source)

    let result = code

    for (const { specifier, path, features, defaults } of candidates) {
      const used = this.usedOf(path, features, defaults)

      result = result.replace(new RegExp(`^(import\\s+\\w+\\s+from\\s+)(["'])${RegExp.escape(specifier)}\\2`, 'm'), (_import, head: string, quote: string) => `${head}${quote}${specifier}?uses=${used}${quote}`)
      result = result.replace(new RegExp(`(\\bimport\\(\\s*)(["'])${RegExp.escape(specifier)}\\2`, 'g'), (_import, head: string, quote: string) => `${head}${quote}${specifier}?uses=${used}${quote}`)
    }

    return result
  }
}

// The `.kay` files under a directory, leaving out what a project installs and builds.
export function kayFiles(dir: string): string[] {
  const found: string[] = []
  let entries: Dirent[]

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue

    const path = join(dir, entry.name)

    if (entry.isDirectory())
      found.push(...kayFiles(path))
    else if (entry.name.endsWith('.kay'))
      found.push(path)
  }

  return found
}
