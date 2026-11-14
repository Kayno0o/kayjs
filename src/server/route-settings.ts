// What a page, layout, endpoint or API module says in its settings object, read off the source: the server never loads a compiler.
export const PAGE_EXPORT = /^export\s+const\s+page\s*=\s*\{/m
const FALSE_KEY = /(?:([A-Za-z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*:\s*false(?![\w$])/y
const SPACE = /\s/

// The keys set to `false` in the object literal `head` opens, `export const page = { ... }` unless named, read without parsing the module: the server never loads a compiler.
export function falseKeys(source: string, head = PAGE_EXPORT): Set<string> {
  const keys = new Set<string>()

  for (const at of entryStarts(source, head)) {
    FALSE_KEY.lastIndex = at
    const key = FALSE_KEY.exec(source)
    // The literal itself, not an expression starting with it: a comma or the closing brace follows.
    const next = key ? source[codeAfter(source, FALSE_KEY.lastIndex)] : undefined

    if (key && (next === ',' || next === '}'))
      keys.add(key[1] ?? key[2] ?? key[3]!)
  }

  return keys
}

export interface UnreadSetting {
  // The setting's key, or `...` for a spread or a computed key, which may carry any.
  key: string
  // Where the entry starts in the source.
  index: number
}

// A getter, setter, async or generator method may lead the key: the entry is then not a literal, so it is reported.
const SETTING_KEY = /(?:(?:async|get|set)\s+(?=[\w$'"*]))?\*?\s*(?:([A-Z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*/iy
const LITERAL_SETTING = /(?:[A-Za-z_$][\w$]*|'[^'\n]*'|"[^"\n]*")\s*:\s*(?:true|false)(?![\w$])/y
const LITERAL_SETTINGS = new Set(['guards', 'layouts'])
const GUARDS_ENTRY = /(?:guards|'guards'|"guards")\s*(:?)\s*/y
const BOOLEAN = /(?:true|false)(?![\w$])/y
const ARROW = /\((?:[^()]|\([^()]*\))*\)\s*=>/y
// What a value starting this way is no guard: a negation, a number, a string, a comment, or a literal that goes on as an expression.
const NOT_A_GUARD = /[!\-+~/'"`\d]|(?:true|false|null|undefined|typeof|void)(?![\w$])/y

// How the entry of `head`'s object starting at `index` sets `guards`: `own` for a guard, a list or `{ load }`, `boolean` for a literal `true` or `false`, `unread` for a value kay takes for neither, such as `!open` or `(false)`, and undefined for any other key or a method.
function guardsEntry(source: string, index: number): 'own' | 'boolean' | 'unread' | undefined {
  GUARDS_ENTRY.lastIndex = index

  const entry = GUARDS_ENTRY.exec(source)

  if (!entry)
    return undefined

  const at = GUARDS_ENTRY.lastIndex

  // `{ guards }` hands over a variable.
  if (entry[1] === '')
    return source[at] === ',' || source[at] === '}' ? 'own' : undefined

  BOOLEAN.lastIndex = at

  if (BOOLEAN.test(source))
    return [',', '}'].includes(source[codeAfter(source, BOOLEAN.lastIndex)]!) ? 'boolean' : 'unread'

  if (source[at] === '(') {
    ARROW.lastIndex = at

    return ARROW.test(source) ? 'own' : 'unread'
  }

  NOT_A_GUARD.lastIndex = at

  return NOT_A_GUARD.test(source) ? 'unread' : 'own'
}

// Whether the object literal `head` opens lists guards of its own: `guards` set to a guard, a list or `{ load }`, run after the `_guard.ts` files above the file. A `guards` read as a literal `true` or `false`, or from a spread, is none.
export function ownGuards(source: string, head = PAGE_EXPORT): boolean {
  return entryStarts(source, head).some(at => guardsEntry(source, at) === 'own')
}

// The entries of the object literal `head` opens that kay does not read as written: a spread or a computed key, which may carry `guards` or `layouts`, and a `layouts` set to anything but a literal `true` or `false`, and a `guards` set to anything but those or a guard, a list or `{ load }`, which the server ignores.
export function unreadSettings(source: string, head = PAGE_EXPORT): UnreadSetting[] {
  const found: UnreadSetting[] = []

  for (const index of entryStarts(source, head)) {
    if (source.startsWith('...', index) || source[index] === '[') {
      found.push({ key: '...', index })

      continue
    }

    SETTING_KEY.lastIndex = index
    const key = SETTING_KEY.exec(source)
    const name = key ? key[1] ?? key[2] ?? key[3]! : undefined

    if (name === undefined || !LITERAL_SETTINGS.has(name))
      continue

    // Written as the server reads it, key, colon and value with no comment or parenthesis between; a `guards` may also be a guard, a list or `{ load }`, which the file's module holds.
    LITERAL_SETTING.lastIndex = index
    const literal = LITERAL_SETTING.test(source) ? [',', '}'].includes(source[codeAfter(source, LITERAL_SETTING.lastIndex)]!) : name === 'guards' && guardsEntry(source, index) === 'own'

    if (!literal)
      found.push({ key: name, index })
  }

  return found
}

// Where each entry of the object literal `head` opens starts, past its brace or a comma: a key, a spread, or the bracket of a computed key.
function entryStarts(source: string, head: RegExp): number[] {
  const starts: number[] = []
  const found = codeMatch(source, head)

  if (!found)
    return starts

  let depth = 1
  // Where a key of the object itself may start: past its brace or a comma.
  let atKey = true

  for (let i = found.index + found[0].length; i < source.length && depth > 0; i++) {
    const char = source[i]!
    const end = literalEnd(source, i)

    if (end !== -1) {
      if (depth === 1 && atKey && (char === '\'' || char === '"'))
        starts.push(i)

      if (char !== '/')
        atKey = false

      i = end
    }
    else if (char === '{' || char === '(' || char === '[') {
      if (depth === 1 && atKey && char === '[')
        starts.push(i)

      depth++
      atKey = false
    }
    else if (char === '}' || char === ')' || char === ']') {
      depth--
    }
    else if (depth === 1 && char === ',') {
      atKey = true
    }
    else if (!SPACE.test(char)) {
      if (depth === 1 && atKey)
        starts.push(i)

      atKey = false
    }
  }

  return starts
}

// The first match of `pattern` in code, not in a comment, a string or a template literal.
function codeMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  // Where the code read so far ends.
  let code = 0

  for (let found = global.exec(source); found; found = global.exec(source)) {
    while (code < found.index) {
      const end = literalEnd(source, code)

      code = end === -1 ? code + 1 : end + 1
    }

    if (code === found.index)
      return found

    global.lastIndex = code
  }

  return undefined
}

// Where the code past `start` resumes, after spaces and comments.
function codeAfter(source: string, start: number): number {
  let at = start

  while (at < source.length) {
    if (SPACE.test(source[at]!))
      at++
    else if (source[at] === '/' && (source[at + 1] === '/' || source[at + 1] === '*'))
      at = literalEnd(source, at) + 1
    else
      break
  }

  return at
}

// Where the comment, string or template literal starting at `start` ends, its last character; -1 when none starts there.
function literalEnd(source: string, start: number): number {
  const char = source[start]

  if (char === '/' && (source[start + 1] === '/' || source[start + 1] === '*')) {
    const end = source[start + 1] === '/' ? source.indexOf('\n', start) : source.indexOf('*/', start + 2) + 1

    return end <= 0 ? source.length : end
  }

  if (char !== '\'' && char !== '"' && char !== '`')
    return -1

  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
    }
    else if (source[i] === char) {
      return i
    }
    else if (char === '`' && source.startsWith('${', i)) {
      i = closingBrace(source, i + 2)
    }
  }

  return source.length
}

// The brace closing a block opened before `start`, past the literals it holds.
function closingBrace(source: string, start: number): number {
  let depth = 1

  for (let i = start; i < source.length; i++) {
    const end = literalEnd(source, i)

    if (end !== -1)
      i = end
    else if (source[i] === '{')
      depth++
    else if (source[i] === '}' && --depth === 0)
      return i
  }

  return source.length
}
