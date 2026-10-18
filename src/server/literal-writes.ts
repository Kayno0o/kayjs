import { resolveFrom } from '../build/files'

// Whether an exported `const` holding an object or array literal can be shown never to change: its value is made of literals only, and no file of the project writes to it, hands it to code that might, or reaches it in a way the scan cannot follow.
// Read by name over the whole project, so a write through an import, a re-export, a namespace import or a barrel is found by the name it ends in; whatever the scan cannot tell stays module state.

export type Literal = { kind: 'value' } | { kind: 'array', items: Literal[] } | { kind: 'object', props: Map<string, Literal> }

// A source file of the project: its text with the comments blanked, and `code` with the inside of its quoted strings blanked too, which hold no use of a name.
export interface SourceFile {
  file: string
  text: string
  code: string
  // A file that could not be read, which may write to anything.
  unreadable?: boolean | undefined
  // The specifiers of its namespaces used in a way the scan cannot follow, found once.
  misuse?: string[] | undefined
  // The specifiers of its dynamic imports and `require`s, undefined for one that is not a string, found once.
  calls?: (string | undefined)[] | undefined
}

const VALUE: Literal = { kind: 'value' }
const NUMBER = /-?0[xob][\da-f_]+n?|-?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?n?/iy
const KEY = /[A-Z_$][\w$]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\d+/iy
const WORD = /[A-Z_$][\w$]*/iy
const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`/y
const KEYWORD = /(?:true|false|null|undefined)(?![\w$])/y
// What follows a literal that is a type only: `as const`, `satisfies Config`.
const TRAILING_END = /[\s;]+$/
const INDEX = /^\d+$/
const SPACE = /\s/
const CAST_START = /^(?:as|satisfies)\s/
const TYPE_CHARS = /^[\w$.<>[\]\s|&,'"{}:;-]+$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// What a chain of members can end in without handing out a reference to the container: a method that only reads, on a container of values, and takes no callback, which is given the container as its last argument.
const READERS = new Set(['length', 'join', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'at', 'flat', 'concat', 'entries', 'keys', 'values', 'toString', 'toLocaleString', 'toSorted', 'toReversed', 'toSpliced', 'with', 'hasOwnProperty'])
const SEGMENT = /\s*(?:\??\.\s*([A-Z_$][\w$]*)|(?:\?\.)?\[\s*(?:(\d+)|'([^'\\]*)'|"([^"\\]*)")\s*\])/iy
const SCRIPT_LOOP = /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+([\w$]+)\s+of\s*$/
const TEMPLATE_LOOP = /^([ \t]*)for\s+([\w$]+)(?:\s*,\s*[\w$]+)?\s+of\s*$/
// The methods that call back with each item and give back nothing of the container but what the callback computes.
const CALLBACKS = new Set(['map', 'forEach', 'some', 'every', 'findIndex', 'findLastIndex', 'reduce', 'reduceRight'])
const CALLBACK = /^\s*\(\s*(?:async\s*)?(?:\(([^()]*)\)(?:\s*:[^=]*[^=\s])?|([\w$]+))\s*=>/
const ARGUMENTS_END = /^\s*(?:,[^)]*)?\)/
const PARAM = /^[A-Z_$][\w$]*$/i
const PARAM_TYPE = /\s*[:=][\s\S]*$/
const CALL_AFTER = /^\s*(?:\?\.\s*)?[(`]/
const COMPUTED = /\s*(?:\?\.)?\[/y
const WRITE_AFTER = /\s*(?:=(?![=>])|[-+*/%&|^]=|<<=|>>>?=|\*\*=|&&=|\|\|=|\?\?=|\+\+|--)/y
const CONTINUES = /^\s*(?:\??\.|[([`])/
const ASSIGNED = /^\s*=(?![=>])/
const WRITE_BEFORE = /(?:\+\+|--|\bdelete|\bfor\s*(?:await\s*)?\()\s*$/
const DECLARED = /(?:^|[^\w$.])(?:const|let|var)\s+$/
const TYPEOF = /\btypeof\s*(?:\(\s*)?$/
const SPREAD = /\.\.\.\s*$/
const ITERATED = /\b(?:of|in)\s+$/
// What gives back keys, a string or a boolean, never a value of the container.
const SUMMARY_READ = /\b(?:Object\.keys|JSON\.stringify|Array\.isArray)\s*\(\s*$/
const HAS_OWN = /\bObject\.hasOwn\s*\(\s*$/
const CLOSING = /^\s*\)/
const NEXT_ARGUMENT = /^\s*,/
const OBJECT_READ = /\b(?:Object\.(?:values|entries)|Array\.from)\s*\(\s*$/
const ARGUMENT_END = /^\s*[,)]/
const SPECIFIER_HEAD = /(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?$/
const NAMESPACE_IMPORT = /\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]/g
const IMPORT_FROM = /^\s+from\s*['"]/
const DOT_MEMBER = /^\s*\??\.\s*[A-Z_$]/i
const DYNAMIC = /\b(?:import|require)\s*\(\s*(?:(['"])([^'"]*)\1\s*\)|(?!['"]))/g
const PROJECT_ALIAS = /^(?:[~#/]|@\/)/
const BUILTIN_SPECIFIER = /^(?:node|bun):/
const EXPORT_ALL = /\bexport\s*\*/
const REGEX_CHARS = /[$()*+.?[\\\]^{|}]/g
// How far past a member an assignment target is looked for.
const TARGET_REACH = 4000

const EVALUATES = /\beval\b|\bFunction\b/
const EXPORT_NAMESPACE = /\bexport\s*\*\s*as\s+[\w$]+\s*from\s*['"]([^'"]+)['"]/g
const NON_NULL = /^\s*!(?!=)/
const ITERATION = /^\s*(?:of|in)\b/
const ASSIGN_CLOSER = /([}\]])\s*=\s*$/
const DECLARATION_HEAD = /(?:^|[^\w$.])(?:const|let|var)\s*$/
// How far back the head of a destructuring declaration is looked for.
const DECLARATION_REACH = 2000

function skipSpace(text: string, at: number): number {
  let i = at

  while (i < text.length) {
    if (SPACE.test(text[i]!)) {
      i++
    }
    else if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i)

      i = newline < 0 ? text.length : newline
    }
    else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)

      i = close < 0 ? text.length : close + 2
    }
    else {
      break
    }
  }

  return i
}

function matchAt(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at

  return pattern.exec(text)?.[0]
}

// The literal and where it ends, or undefined for anything that is not made of strings, numbers, booleans, `null`, `undefined` and arrays and objects of them.
function parseValue(text: string, from: number, imported: ReadonlySet<string>): { literal: Literal, end: number } | undefined {
  const at = skipSpace(text, from)
  const char = text[at]

  if (char === '[')
    return parseArray(text, at + 1, imported)

  if (char === '{')
    return parseObject(text, at + 1, imported)

  // An imported binding is another module's value, which stops a page that takes it if that module holds it changeable.
  const word = matchAt(WORD, text, at)
  const scalar = matchAt(STRING, text, at) ?? matchAt(NUMBER, text, at) ?? matchAt(KEYWORD, text, at) ?? (word !== undefined && imported.has(word) ? word : undefined)

  return scalar === undefined ? undefined : { literal: VALUE, end: at + scalar.length }
}

function parseArray(text: string, from: number, imported: ReadonlySet<string>): { literal: Literal, end: number } | undefined {
  const items: Literal[] = []
  let at = skipSpace(text, from)

  while (text[at] !== ']') {
    const item = parseValue(text, at, imported)

    if (item === undefined)
      return undefined

    items.push(item.literal)
    at = skipSpace(text, item.end)

    if (text[at] === ',')
      at = skipSpace(text, at + 1)
    else if (text[at] !== ']')
      return undefined
  }

  return { literal: { kind: 'array', items }, end: at + 1 }
}

function parseObject(text: string, from: number, imported: ReadonlySet<string>): { literal: Literal, end: number } | undefined {
  const props = new Map<string, Literal>()
  let at = skipSpace(text, from)

  while (text[at] !== '}') {
    const raw = matchAt(KEY, text, at)

    if (raw === undefined)
      return undefined

    const key = raw[0] === '\'' || raw[0] === '"' ? raw.slice(1, -1) : raw

    at = skipSpace(text, at + raw.length)

    if (PROTOTYPE_KEYS.has(key))
      return undefined

    // `{ icon }` for an imported `icon` is `{ icon: icon }`.
    const shorthand = (text[at] === ',' || text[at] === '}') && imported.has(key)

    if (text[at] !== ':' && !shorthand)
      return undefined

    const value = shorthand ? { literal: VALUE, end: at } : parseValue(text, at + 1, imported)

    if (value === undefined)
      return undefined

    props.set(key, value.literal)
    at = skipSpace(text, value.end)

    if (text[at] === ',')
      at = skipSpace(text, at + 1)
    else if (text[at] !== '}')
      return undefined
  }

  return { literal: { kind: 'object', props }, end: at + 1 }
}

// The object or array literal an initializer is, its values imported bindings among others, `as const`, `satisfies` and a type annotation allowed, or undefined when it is anything else.
export function parseLiteral(initializer: string, imported: ReadonlySet<string> = new Set()): Literal | undefined {
  const parsed = parseValue(initializer, 0, imported)

  if (parsed === undefined || parsed.literal.kind === 'value')
    return undefined

  const rest = initializer.slice(parsed.end).replace(TRAILING_END, '').trimStart()

  if (rest === '')
    return parsed.literal

  return CAST_START.test(rest) && TYPE_CHARS.test(rest) && !rest.includes('||') && !rest.includes('&&') ? parsed.literal : undefined
}

function arrayItem(items: Literal[], key: string): Literal | undefined {
  return INDEX.test(key) ? items[Number(key)] : undefined
}

function flat(literal: Literal): boolean {
  if (literal.kind === 'value')
    return true

  const children = literal.kind === 'array' ? literal.items : [...literal.props.values()]

  return children.every(child => child.kind === 'value')
}

// Whether the expression ending at `from` sits inside a `[ ]`, `{ }` or `( )` that is then assigned to or iterated into, so it is a target of an assignment: `[a.b] = c`, `(a.b as any) = c`, `for ({ k: a.b } of c)`.
function inPattern(text: string, from: number): boolean {
  let depth = 0

  for (let at = from; at < Math.min(text.length, from + TARGET_REACH); at++) {
    const char = text[at]!

    if (char === '"' || char === '\'' || char === '`') {
      for (at++; at < text.length && text[at] !== char; at++) {
        if (text[at] === '\\')
          at++
      }
    }
    else if (char === '(' || char === '[' || char === '{') {
      depth++
    }
    else if (char === ')' || char === ']' || char === '}') {
      if (--depth >= 0)
        continue

      depth = 0

      const after = text.slice(at + 1, at + 40)

      if (ASSIGNED.test(after) || ITERATION.test(after))
        return true

      if (char === ')')
        return false
    }
    else if (char === ';') {
      return false
    }
  }

  return false
}

// Whether the use at `start` is the right side of a `const`, `let` or `var` declaration whose left side is a destructuring pattern.
function destructuredFrom(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - DECLARATION_REACH), start)
  const closer = ASSIGN_CLOSER.exec(before)

  if (closer === null)
    return false

  let depth = 0

  for (let at = closer.index; at >= 0; at--) {
    const char = before[at]!

    if (char === '}' || char === ']' || char === ')')
      depth++
    else if ((char === '{' || char === '[' || char === '(') && --depth === 0)
      return DECLARATION_HEAD.test(before.slice(Math.max(0, at - 10), at))
  }

  return false
}

// Whether the bare container at [start, end) is only read: listed by key or turned into a string, which hands out nothing, or, for a container of values, spread, iterated, listed or destructured from a declaration.
function readBare(text: string, start: number, end: number, values: boolean): boolean {
  const before = text.slice(Math.max(0, start - 300), start)
  const after = text.slice(end, end + 12)

  if ((SUMMARY_READ.test(before) && CLOSING.test(after)) || (HAS_OWN.test(before) && NEXT_ARGUMENT.test(after)))
    return true

  return values && (SPREAD.test(before) || ITERATED.test(before) || (OBJECT_READ.test(before) && ARGUMENT_END.test(after)) || destructuredFrom(text, start))
}

// Whether an import or export specifier list holds the use at `at` without renaming it, or is only a rename to the name.
function specifierUse(text: string, at: number, end: number, name: string): boolean | undefined {
  const open = text.lastIndexOf('{', at)
  const close = text.indexOf('}', end)

  if (open < 0 || close < 0 || text.slice(open + 1, at).includes('}') || text.slice(end, close).includes('{') || !SPECIFIER_HEAD.test(text.slice(Math.max(0, open - 40), open)))
    return undefined

  const from = Math.max(text.lastIndexOf(',', at), open) + 1
  const comma = text.indexOf(',', end)
  const entry = text.slice(from, comma >= 0 && comma < close ? comma : close).trim()
  const bare = new RegExp(`^(?:type\\s+)?${name.replace(REGEX_CHARS, '\\$&')}$`)
  const renamedTo = new RegExp(`\\sas\\s+${name.replace(REGEX_CHARS, '\\$&')}$`)

  return bare.test(entry) || renamedTo.test(entry)
}

// The index after the bracket closing the one opening at `at`, or undefined when it does not close. A quote that closes on no line of its own is prose.
function closeAt(text: string, at: number): number | undefined {
  let depth = 0

  for (let i = at; i < Math.min(text.length, at + TARGET_REACH); i++) {
    const char = text[i]

    if (char === '"' || char === '\'' || char === '`') {
      const start = i

      for (i++; i < text.length && text[i] !== char; i++) {
        if (text[i] === '\\')
          i++
        else if (text[i] === '\n' && char !== '`')
          break
      }

      if (text[i] !== char)
        i = start
    }
    else if (char === '[' || char === '(' || char === '{') {
      depth++
    }
    else if ((char === ']' || char === ')' || char === '}') && --depth === 0) {
      return i + 1
    }
  }

  return undefined
}

// The merged shape of the items of an array literal, or undefined when they differ in kind.
function itemOf(items: readonly Literal[]): Literal | undefined {
  let merged: Literal | undefined = items[0]

  for (const item of items.slice(1)) {
    if (merged === undefined)
      return undefined

    merged = merge(merged, item)
  }

  return merged ?? VALUE
}

function merge(a: Literal, b: Literal): Literal | undefined {
  if (a.kind === 'value' && b.kind === 'value')
    return a

  if (a.kind === 'object' && b.kind === 'object') {
    const props = new Map(a.props)

    for (const [key, value] of b.props) {
      const same = props.get(key)
      const both = same === undefined ? value : merge(same, value)

      if (both === undefined)
        return undefined

      props.set(key, both)
    }

    return { kind: 'object', props }
  }

  if (a.kind === 'array' && b.kind === 'array') {
    const item = itemOf([...a.items, ...b.items])

    return item === undefined ? undefined : { kind: 'array', items: [item] }
  }

  return undefined
}

// The binding that holds each item of a loop over the container at [start, end), and the text they are read in: a `for (const item of NAME)` statement or a template's `for item of NAME` block.
function loopOver(text: string, start: number, end: number): { binding: string, from: number, to: number } | undefined {
  const before = text.slice(Math.max(0, start - 200), start)
  const script = SCRIPT_LOOP.exec(before)

  if (script !== null) {
    const header = CLOSING.exec(text.slice(end, end + 12))

    if (header === null)
      return undefined

    const from = end + header[0].length
    const body = skipSpace(text, from)
    // A body without braces may go on over several lines, so it is not followed.
    const to = text[body] === '{' ? closeAt(text, body) : undefined

    return to === undefined ? undefined : { binding: script[1]!, from, to }
  }

  const line = before.slice(before.lastIndexOf('\n') + 1)
  const template = TEMPLATE_LOOP.exec(line)

  if (template === null)
    return undefined

  const indent = template[1]!.length
  let to = text.indexOf('\n', end)

  while (to >= 0) {
    const next = text.indexOf('\n', to + 1)
    const row = text.slice(to + 1, next < 0 ? text.length : next)

    if (row.trim() !== '' && row.length - row.trimStart().length <= indent)
      break

    to = next
  }

  return { binding: template[2]!, from: end, to: to < 0 ? text.length : to }
}

// Whether every use of `binding` within [from, to) only reads what an item of the container holds.
function itemsRead(text: string, binding: string, from: number, to: number, item: Literal): boolean {
  const uses = new RegExp(`(?<![\\w$.])${binding.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`, 'g')
  const scope = text.slice(0, to)

  uses.lastIndex = from

  for (const use of scope.matchAll(uses)) {
    if (use.index >= from && !readsOnly(scope, use.index, binding, item))
      return false
  }

  return true
}

// Whether the callback of `NAME.method(` at `cursor` only reads its item, and gives back nothing but what its body computes: a reader of the items that takes no more than the item, its index and a result so far, and no `this`.
function callbackReads(text: string, cursor: number, method: string, items: readonly Literal[]): boolean {
  const item = itemOf(items)
  const head = CALLBACK.exec(text.slice(cursor, cursor + 400))

  if (item === undefined || head === null)
    return false

  const reduces = method === 'reduce' || method === 'reduceRight'
  const params = (head[1] ?? head[2]!).split(',').map(param => param.trim().replace(PARAM_TYPE, '')).filter(param => param !== '')

  if (params.length > (reduces ? 3 : 2) || params.some(param => !PARAM.test(param)))
    return false

  const from = cursor + head[0].length
  const body = skipSpace(text, from)
  const to = text[body] === '{' ? closeAt(text, body) : expressionEnd(text, body)

  if (to === undefined)
    return false

  const close = ARGUMENTS_END.exec(text.slice(to, to + 400))

  // Without a starting value the first item is the accumulator, which the callback may write to.
  if (close === null || reduces !== close[0].includes(','))
    return false

  const binding = params[reduces ? 1 : 0]

  return binding !== undefined && itemsRead(text, binding, from, to, item)
}

// The end of the arrow function body expression at `at`: a `,` or `)` that closes nothing it opened.
function expressionEnd(text: string, at: number): number {
  let depth = 0

  for (let i = at; i < text.length; i++) {
    const char = text[i]!

    if (char === '(' || char === '[' || char === '{') {
      depth++
    }
    else if (char === ')' || char === ']' || char === '}') {
      if (--depth < 0)
        return i
    }
    else if (char === ',' && depth === 0) {
      return i
    }
  }

  return text.length
}

// Whether the use of `name` at `at` only reads what the literal holds.
function readsOnly(text: string, at: number, name: string, literal: Literal): boolean {
  const end = at + name.length
  const before = text.slice(Math.max(0, at - 300), at)

  if (DECLARED.test(before.slice(-30)) || TYPEOF.test(before))
    return true

  const specifier = specifierUse(text, at, end, name)

  if (specifier !== undefined)
    return specifier

  if (WRITE_BEFORE.test(before))
    return false

  let node = literal
  let cursor = end
  let member: string | undefined

  for (;;) {
    SEGMENT.lastIndex = cursor

    const found = SEGMENT.exec(text)

    if (found === null) {
      // A key that is no literal reads one value of a container of values, which a prototype key cannot make a write: whatever follows is judged below.
      COMPUTED.lastIndex = cursor

      const computed = COMPUTED.exec(text)
      const close = computed === null ? undefined : closeAt(text, COMPUTED.lastIndex - 1)

      if (close === undefined || !flat(node))
        break

      // A call on the result runs a method of the container itself when the key names one.
      if (CALL_AFTER.test(text.slice(close, close + 8)))
        return false

      node = VALUE
      cursor = close

      continue
    }

    const key = found[1] ?? found[3] ?? found[4] ?? found[2]!

    if (PROTOTYPE_KEYS.has(key))
      return false

    cursor = SEGMENT.lastIndex

    if (node.kind === 'value')
      continue

    const child = node.kind === 'array' ? arrayItem(node.items, key) : node.props.get(key)

    if (child === undefined) {
      member = key

      break
    }

    node = child
  }

  if (matchAt(WRITE_AFTER, text, cursor) !== undefined || NON_NULL.test(text.slice(cursor, cursor + 8)) || inPattern(text, cursor))
    return false

  if (node.kind === 'value')
    return true

  if (member === 'length')
    return true

  if (member === undefined) {
    if (readBare(text, at, cursor, flat(node)))
      return true

    const loop = node.kind === 'array' ? loopOver(text, at, cursor) : undefined
    const item = node.kind === 'array' ? itemOf(node.items) : undefined

    return loop !== undefined && item !== undefined && itemsRead(text, loop.binding, loop.from, loop.to, item)
  }

  if (node.kind === 'array' && CALLBACKS.has(member) && callbackReads(text, cursor, member, node.items))
    return true

  // A member the literal does not hold reads as undefined unless it is called or followed on, which a built-in method could do.
  return (flat(node) && READERS.has(member)) || !CONTINUES.test(text.slice(cursor, cursor + 12))
}

// The specifiers of the namespaces in the text that are used whole or by a computed key, or exported from a barrel, which only their importers see.
function namespaceMisuse(text: string): string[] {
  const specifiers = [...text.matchAll(EXPORT_NAMESPACE)].map(match => match[1]!)

  for (const [, binding, specifier] of text.matchAll(NAMESPACE_IMPORT)) {
    if (BUILTIN_SPECIFIER.test(specifier!))
      continue

    for (const use of text.matchAll(new RegExp(`(?<![\\w$.])${binding!.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`, 'g'))) {
      const rest = text.slice(use.index + binding!.length)

      // The import's own binding, followed by `from`, is no use.
      if (!DOT_MEMBER.test(rest) && !IMPORT_FROM.test(rest)) {
        specifiers.push(specifier!)

        break
      }
    }
  }

  return specifiers
}

// Whether a module imported by `specifier` from `source` may hold the export, or hand it on: it is the declaring module, a module naming it or re-exporting everything, or a project path that does not resolve. A package outside the project cannot.
function reachesModule(specifier: string, source: SourceFile, name: string, declaredIn: string, sources: readonly SourceFile[]): boolean {
  if (BUILTIN_SPECIFIER.test(specifier))
    return false

  const resolved = resolveFrom(specifier, source.file)

  if (resolved === undefined)
    return specifier.startsWith('.') || PROJECT_ALIAS.test(specifier)

  const target = sources.find(candidate => candidate.file === resolved)

  return target !== undefined && (target.file === declaredIn || new RegExp(`(?<![\\w$])${name.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`).test(target.text) || EXPORT_ALL.test(target.text))
}

// Whether a dynamic import or a `require` in the file may hand over the export: its target is not a literal, or reaches the module holding it.
function reachesByCall(source: SourceFile, name: string, declaredIn: string, sources: readonly SourceFile[]): boolean {
  source.calls ??= [...source.text.matchAll(DYNAMIC)].map(call => call[2])

  let word: RegExp | undefined

  for (const specifier of source.calls) {
    if (specifier === undefined)
      return true

    if (BUILTIN_SPECIFIER.test(specifier))
      continue

    if (PROJECT_ALIAS.test(specifier) && !specifier.startsWith('./') && !specifier.startsWith('../'))
      return true

    if (!specifier.startsWith('.'))
      continue

    const resolved = resolveFrom(specifier, source.file)
    const target = resolved === undefined ? undefined : sources.find(candidate => candidate.file === resolved)

    if (target === undefined)
      continue

    word ??= new RegExp(`(?<![\\w$])${name.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`)

    if (target.file === declaredIn || word.test(target.text) || EXPORT_ALL.test(target.text))
      return true
  }

  return false
}

// Whether `name`, exported from `declaredIn` as `literal`, is read and never written, handed on or reached some other way by any of `sources`.
export function neverWritten(name: string, literal: Literal, declaredIn: string, sources: readonly SourceFile[]): boolean {
  const escaped = name.replace(REGEX_CHARS, '\\$&')
  const uses = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g')
  const quotedImport = new RegExp(`['"]${escaped}['"]\\s+as\\s`)

  // A module outside the project is not read, so a write in it would go unseen.
  if (!sources.some(source => source.file === declaredIn))
    return false

  for (const source of sources) {
    if (source.unreadable === true)
      return false

    source.misuse ??= namespaceMisuse(source.text)

    if (source.misuse.some(specifier => reachesModule(specifier, source, name, declaredIn, sources)) || reachesByCall(source, name, declaredIn, sources))
      return false

    if (!source.text.includes(name))
      continue

    if (EVALUATES.test(source.text) || quotedImport.test(source.text))
      return false

    for (const use of source.code.matchAll(uses)) {
      if (!readsOnly(source.code, use.index, name, literal))
        return false
    }
  }

  return true
}

// The name an exported declarator binds, when it is a plain identifier.
export function declaredName(declarator: string): string | undefined {
  const start = matchAt(WORD, declarator, 0)

  if (start === undefined)
    return undefined

  const rest = declarator.slice(start.length).trim()

  return rest === '' || rest.startsWith(':') ? start : undefined
}
