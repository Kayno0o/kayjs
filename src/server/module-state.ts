import { declaredName } from './literal-writes'

// What a module declares at its top level that a second render could find changed: a `let` or `var`, a `const` holding an empty array, object, `Map`, `Set` or the like, which a cache fills, and an exported one holding any array, object or `new`, which another module can change.
// `settings` are the names of exports read as written, which are not state.
// Read statement by statement at bracket depth 0, with strings, templates and comments set aside, so a declarator is told from a default value, a parameter or a quoted comma.
// What type arguments are made of.
const TYPE_ARGUMENT = /[\w$\s,.[\]|&?:'"{}()<>=]/
const WHITESPACE = /\s/
const BRACKETS = /^(?:\[\s*\]|\{\s*\})/
const CAST = /^(?:as|satisfies)\s/
// The end of a cast's type name, whose `<` opens type arguments.
const CAST_TYPE = /\b(?:as|satisfies)\s+[\w$.]+$/
const TYPE_ENTRY = /^type\s/
const NEW_CONTAINER = /^new\s+(?:Map|Set|WeakMap|WeakSet|Array|Object)\b/y
const NEW_VALUE = /^(?:[[{]|new\s)/
const WORD = /[\w$]/
const OPENERS = '([{'
const CLOSERS = ')]}'
// The last character of a line after which the statement goes on, and the first one of the next line that continues it.
const TRAILING = ',=+-*/%&|^<>?:.(['
// What a regular expression literal may follow.
const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^'
const LEADING = '.?:,+-*/%&|=<>'

// Judges whether an exported literal, given its name and initializer, is shown never to change: then it is no state.
export type Unchanged = (name: string, initializer: string) => boolean

// Where the first statement declaring state starts, or undefined when none does.
// With `risks`, an exported container nothing proves unchanged is no state of the module: it is noted there by name, with where it starts, for a page to be stopped by only when it takes it.
export function stateAt(source: string, settings: ReadonlySet<string>, unchanged?: Unchanged, risks?: Map<string, number>): number | undefined {
  let at = skipTrivia(source, 0)

  while (at < source.length) {
    const end = statementEnd(source, at)

    if (statementDeclaresState(source, at, end, settings, unchanged, risks))
      return at

    // A stray closer ends a statement without being part of it.
    at = skipTrivia(source, Math.max(end, at + 1))
  }

  return undefined
}

// The index after the whitespace and comments from `at`.
function skipTrivia(source: string, at: number): number {
  let i = at

  while (i < source.length) {
    if (WHITESPACE.test(source[i]!)) {
      i++
    }
    else if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i)

      i = newline < 0 ? source.length : newline
    }
    else if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2)

      i = close < 0 ? source.length : close + 2
    }
    else {
      break
    }
  }

  return i
}

// The index after the string or template literal opening at `at`, its `${}` holes read as code.
function skipString(source: string, at: number): number {
  const quote = source[at]!

  for (let i = at + 1; i < source.length; i++) {
    const char = source[i]

    if (char === '\\')
      i++
    else if (char === quote)
      return i + 1
    else if (quote === '`' && char === '$' && source[i + 1] === '{')
      i = skipHole(source, i + 1) - 1
  }

  return source.length
}

// The index after the string, template or regular expression literal opening at `at`, or -1 when none does.
// A `/` opens a regular expression where an operand is expected: at the start, or after an operator or an opening bracket.
function skipLiteral(source: string, at: number): number {
  const char = source[at]!

  if (char === '"' || char === '\'' || char === '`')
    return skipString(source, at)

  if (char !== '/' || source[at + 1] === '/' || source[at + 1] === '*')
    return -1

  let before = at - 1

  while (before >= 0 && WHITESPACE.test(source[before]!))
    before--

  if (before >= 0 && !REGEX_AFTER.includes(source[before]!))
    return -1

  let inClass = false

  for (let i = at + 1; i < source.length; i++) {
    const char = source[i]

    if (char === '\n')
      return -1

    if (char === '\\')
      i++
    else if (char === '[')
      inClass = true
    else if (char === ']')
      inClass = false
    else if (char === '/' && !inClass)
      return i + 1
  }

  return -1
}

// The index after the `{}` opening at `at`, whatever it holds.
function skipHole(source: string, at: number): number {
  let depth = 0

  for (let i = at; i < source.length; i++) {
    const char = source[i]!

    const literal = skipLiteral(source, i)

    if (literal >= 0)
      i = literal - 1
    else if (char === '{')
      depth++
    else if (char === '}' && --depth === 0)
      return i + 1
  }

  return source.length
}

// The index after the statement starting at `at`: its `;` at depth 0, or a line end at depth 0 where nothing continues it.
function statementEnd(source: string, at: number): number {
  let depth = 0
  let last = ''

  for (let i = at; i < source.length; i++) {
    const char = source[i]!

    const literal = skipLiteral(source, i)

    if (literal >= 0) {
      i = literal - 1
      last = char === '/' ? ')' : char
    }
    else if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      i = skipTrivia(source, i) - 1
    }
    else if (OPENERS.includes(char)) {
      depth++
      last = char
    }
    else if (CLOSERS.includes(char)) {
      depth--
      last = char

      if (depth < 0)
        return i
    }
    else if (char === ';' && depth === 0) {
      return i + 1
    }
    else if (char === '\n' && depth === 0 && last !== '' && !TRAILING.includes(last)) {
      const next = skipTrivia(source, i)

      if (next >= source.length || !LEADING.includes(source[next]!))
        return i
    }
    else if (!WHITESPACE.test(char)) {
      last = char
    }
  }

  return source.length
}

function statementDeclaresState(source: string, start: number, end: number, settings: ReadonlySet<string>, unchanged: Unchanged | undefined, risks: Map<string, number> | undefined): boolean {
  let i = start
  let word = wordAt(source, i)
  let exported = false

  if (word === 'export') {
    exported = true
    i = skipTrivia(source, i + word.length)
    word = wordAt(source, i)
  }

  if (word === 'let' || word === 'var')
    return true

  return word === 'const' && declaratorsHoldContainer(source, skipTrivia(source, i + word.length), end, exported, settings, unchanged, risks, start)
}

function wordAt(source: string, at: number): string {
  let i = at

  while (i < source.length && WORD.test(source[i]!))
    i++

  return source.slice(at, i)
}

// The declarators of the list from `from` to `end`: each one's left side, and its initializer when it has one.
function declarators(source: string, from: number, end: number): { left: string, initializer: string | undefined }[] {
  const found: { left: string, initializer: string | undefined }[] = []
  let declarator = from
  let depth = 0
  let initial = -1
  // A type annotation's `<>` hold commas that do not end the declarator.
  let angle = 0

  for (let i = from; i <= end; i++) {
    const char = i < end ? source[i]! : ','

    const literal = skipLiteral(source, i)

    if (literal >= 0) {
      i = literal - 1
    }
    else if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      i = skipTrivia(source, i) - 1
    }
    else if (OPENERS.includes(char)) {
      depth++
    }
    else if (CLOSERS.includes(char)) {
      depth--
    }
    else if (depth === 0 && angle === 0 && initial < 0 && char === '=' && source[i + 1] !== '>') {
      initial = i + 1
    }
    else if (depth === 0 && char === '<' && (initial < 0 || angle > 0 || genericCall(source, i) > 0 || CAST_TYPE.test(source.slice(Math.max(0, i - 80), i)))) {
      angle++
    }
    else if (depth === 0 && char === '>' && source[i - 1] !== '=' && angle > 0) {
      angle--
    }
    else if (depth === 0 && angle === 0 && char === ',') {
      found.push(initial >= 0 ? { left: source.slice(declarator, initial - 1), initializer: source.slice(skipTrivia(source, initial), i) } : { left: source.slice(declarator, i), initializer: undefined })

      initial = -1
      declarator = i + 1
    }
  }

  return found
}

// Whether a declarator of the list from `from` to `end` is initialised with an empty container, or for an export one nothing shows unchanged.
function declaratorsHoldContainer(source: string, from: number, end: number, exported: boolean, settings: ReadonlySet<string>, unchanged: Unchanged | undefined, risks: Map<string, number> | undefined, start: number): boolean {
  for (const { left, initializer } of declarators(source, from, end)) {
    if (initializer === undefined || settings.has(left.trim()))
      continue

    if (holdsContainer(initializer, exported) && !(exported && provenUnchanged(left, initializer, unchanged))) {
      const name = exported ? declaredName(left.trim()) : undefined

      if (name === undefined || risks === undefined)
        return true

      risks.set(name, start)
    }
  }

  return false
}

function provenUnchanged(declarator: string, initializer: string, unchanged: Unchanged | undefined): boolean {
  const name = declaredName(declarator.trim())

  return name !== undefined && unchanged?.(name, initializer) === true
}

// Whether an initializer is an empty container, or for an export any array, object or `new`.
function holdsContainer(initializer: string, exported: boolean): boolean {
  if (exported)
    return NEW_VALUE.test(initializer)

  const brackets = BRACKETS.exec(initializer)

  if (brackets === null)
    return newWithoutArguments(initializer)

  const rest = initializer.slice(brackets[0].length)
  const after = rest.slice(skipTrivia(rest, 0))

  return after === '' || CAST.test(after)
}

// `new Map()` and the like, type arguments allowed, with nothing to fill them from.
function newWithoutArguments(initializer: string): boolean {
  NEW_CONTAINER.lastIndex = 0

  const name = NEW_CONTAINER.exec(initializer)

  if (name === null)
    return false

  const close = initializer[name[0].length] === '<' ? genericCall(initializer, name[0].length) : -1
  const open = skipTrivia(initializer, close < 0 ? name[0].length : close + 1)

  if (initializer[open] !== '(')
    return false

  return initializer[skipTrivia(initializer, open + 1)] === ')'
}

// For a `<` in an initializer: the index of its closing `>` when it opens type arguments, `new Map<string, number>()`, else -1.
function genericCall(source: string, at: number): number {
  if (!WORD.test(source[at - 1] ?? ''))
    return -1

  let depth = 0

  for (let i = at; i < source.length; i++) {
    const char = source[i]!

    if (char === '<')
      depth++
    else if (char === '>' && --depth === 0)
      return source[skipTrivia(source, i + 1)] === '(' ? i : -1
    else if (!TYPE_ARGUMENT.test(char))
      return -1
  }

  return -1
}

// A top-level statement of a module: the names it binds, those of its exports, and its text.
interface Declaration {
  locals: string[]
  // An exported name, with the local names it stands for, or none for an `export default` expression, which stands for whatever its text names.
  exports: { name: string, of: string[] | undefined }[]
  text: string
}

const FUNCTION_OR_CLASS = /^(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*\s*|(?:function|class|enum|namespace)\s+)([\w$]+)/
const IDENTIFIER = /[A-Z_$][\w$]*/gi
const EXPORT_CLAUSE = /^\{([^}]*)\}\s*(from\b)?/
const AS = /\s+as\s+/
const QUOTES = /^['"]|['"]$/g

// The top-level statements of a module that bind names or export them, as the scan reads them.
function declarations(source: string): Declaration[] {
  const found: Declaration[] = []
  let at = skipTrivia(source, 0)

  while (at < source.length) {
    const end = statementEnd(source, at)
    const declaration = declarationAt(source, at, end)

    if (declaration !== undefined)
      found.push(declaration)

    at = skipTrivia(source, Math.max(end, at + 1))
  }

  return found
}

function declarationAt(source: string, start: number, end: number): Declaration | undefined {
  const text = source.slice(start, end)
  let i = start
  let word = wordAt(source, i)
  const exported = word === 'export'

  if (exported) {
    i = skipTrivia(source, i + word.length)
    word = wordAt(source, i)
  }

  if (exported && source[i] === '{') {
    const clause = EXPORT_CLAUSE.exec(source.slice(i, end))

    // A re-export from another module binds and uses nothing of this one.
    if (clause === null || clause[2] !== undefined)
      return undefined

    const specifiers = clause[1]!.split(',').map(entry => entry.trim()).filter(entry => entry !== '' && !TYPE_ENTRY.test(entry))

    return { locals: [], exports: specifiers.map((entry) => {
      const [local, exportedName] = entry.split(AS)

      return { name: (exportedName ?? local!).replace(QUOTES, ''), of: [local!.replace(QUOTES, '')] }
    }), text }
  }

  if (exported && word === 'default') {
    i = skipTrivia(source, i + word.length)

    const named = FUNCTION_OR_CLASS.exec(source.slice(i, end))?.[1]

    return { locals: named === undefined ? [] : [named], exports: [{ name: 'default', of: undefined }], text }
  }

  if (word === 'const' || word === 'let' || word === 'var') {
    const locals = declarators(source, skipTrivia(source, i + word.length), end).flatMap((declarator) => {
      const plain = declaredName(declarator.left.trim())

      return plain === undefined ? declarator.left.match(IDENTIFIER) ?? [] : [plain]
    })

    return { locals, exports: exported ? locals.map(name => ({ name, of: [name] })) : [], text }
  }

  const declared = FUNCTION_OR_CLASS.exec(source.slice(i, end))?.[1]

  if (declared === undefined)
    return undefined

  return { locals: [declared], exports: exported ? [{ name: declared, of: [declared] }] : [], text }
}

// Which exports of a module lean on the exported containers of `risks`, a name to where the first container it leans on starts: the container itself, a function or a value built from it, a default or a renamed export of either.
// A binding leans on a container when its text names it or another binding that does, found by name over the module.
export function exposedBy(source: string, risks: ReadonlyMap<string, number>): Map<string, number> {
  const all = declarations(source)
  const leaning = new Map(risks)

  for (let changed = true; changed;) {
    changed = false

    for (const { locals, text } of all) {
      if (locals.every(name => leaning.has(name)))
        continue

      const root = rootOf(text, leaning)

      if (root === undefined)
        continue

      for (const name of locals) {
        if (!leaning.has(name)) {
          leaning.set(name, root)
          changed = true
        }
      }
    }
  }

  const exposed = new Map<string, number>()

  for (const { exports, text } of all) {
    for (const { name, of } of exports) {
      const root = of === undefined ? rootOf(text, leaning) : of.map(local => leaning.get(local)).find(at => at !== undefined)

      if (root !== undefined && !exposed.has(name))
        exposed.set(name, root)
    }
  }

  return exposed
}

// Where the first container among `leaning` that the text names starts, if it names one.
function rootOf(text: string, leaning: ReadonlyMap<string, number>): number | undefined {
  for (const word of text.match(IDENTIFIER) ?? []) {
    const at = leaning.get(word)

    if (at !== undefined)
      return at
  }

  return undefined
}
