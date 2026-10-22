import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /\.(?:kay|[cm]?tsx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const WHITESPACE = /\s/
const WHITESPACE_RUN = /^\s*/
const AWAIT_BEFORE = /await\s+$/

export interface RenamedName {
  from: string
  to: string
  // `outcome` is `ctx.failed(action)` or `ctx.succeeded(action)`, written `action.failed()` or `action.succeeded()`, with `from` and `to` both `failed` or `succeeded`.
  // `key` is an object key (`{ from: 1 }`; the shorthand `{ from }` only with `call`), `method` a call on any object (`.from(`).
  kind: 'key' | 'method' | 'outcome'
  // Only the key of an object literal passed straight to this function, the shorthand included, for a name too common to rename everywhere.
  call?: string
  // Only a method called on an `auth` (`auth.from()`, `ctx.locals.auth.from()`), for a name other objects share.
  receiver?: boolean
  // The old method answered a boolean where the new one answers `{ ok }`: `await auth.from(x)` is fixed to `(await auth.to(x)).ok`, any other use reported with no fix.
  answersOk?: boolean
  // Why the old name goes, the end of the message.
  why: string
}

// A key after `{` or `,` with its colon: a shorthand cannot be told from a variable in a list or a template.
function keyPattern(name: string): RegExp {
  return new RegExp(`(?<=[{,]\\s*)${name}(?=\\s*:)`, 'g')
}

const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/
const WORD_CHAR = /[\w$]/

// The offset after the regex literal opening at `at`, or -1 when the line ends first, so a division is not taken for one.
function regexEnd(source: string, at: number): number {
  let end = at + 1
  let inClass = false

  while (end < source.length && source[end] !== '\n') {
    const char = source[end]!

    if (char === '\\') {
      end++
    }
    else if (char === '[') {
      inClass = true
    }
    else if (char === ']') {
      inClass = false
    }
    else if (char === '/' && !inClass) {
      end++

      while (end < source.length && WORD_CHAR.test(source[end]!))
        end++

      return end
    }

    end++
  }

  return -1
}

// The source with strings, regex literals, template text and comments blanked out, offset for offset, so a name in one is never matched. A `${}` of a template stays code.
export function mask(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at++) {
      if (out[at] !== '\n')
        out[at] = ' '
    }
  }

  // The template literal opening at `at`: its text blanked, its expressions scanned as code. Returns the offset after it.
  const template = (at: number, expression: (from: number) => number): number => {
    let end = at + 1
    let from = at

    while (end < source.length) {
      const char = source[end]!

      if (char === '\\') {
        end += 2
      }
      else if (char === '`') {
        blank(from, end + 1)

        return end + 1
      }
      else if (char === '$' && source[end + 1] === '{') {
        blank(from, end + 2)
        end = expression(end + 2)
        from = end
        end++
      }
      else {
        end++
      }
    }

    blank(from, source.length)

    return source.length
  }

  // Scans code from `at` to the end, or in a template expression to the `}` closing it, whose offset it returns.
  const code = (start: number, inTemplate: boolean): number => {
    let at = start
    let depth = 0
    let previous = ''
    let tail = ''

    while (at < source.length) {
      const char = source[at]!
      const next = source[at + 1]

      if (char === '/' && (next === '/' || next === '*')) {
        const stop = next === '/' ? source.indexOf('\n', at) : source.indexOf('*/', at + 2)
        const end = stop === -1 ? source.length : stop + (next === '*' ? 2 : 0)

        blank(at, end)
        at = end

        continue
      }

      if (char === '`') {
        at = template(at, from => code(from, true))
        previous = 'a'
        tail = ''

        continue
      }

      // An apostrophe after a word character is prose (`don't`), never the start of a string.
      if (char === '"' || (char === '\'' && !WORD_CHAR.test(source[at - 1] ?? ''))) {
        let end = at + 1

        while (end < source.length && source[end] !== char && source[end] !== '\n')
          end += source[end] === '\\' ? 2 : 1

        blank(at, Math.min(end + 1, source.length))
        at = end + 1
        previous = 'a'
        tail = ''

        continue
      }

      if (char === '/' && (previous === '' || '(,=:[!&|?{;+-*%<>~^'.includes(previous) || REGEX_AFTER_WORD.test(tail.trimEnd()))) {
        const end = regexEnd(source, at)

        if (end !== -1) {
          blank(at, end)
          at = end
          previous = 'a'
          tail = ''

          continue
        }
      }

      if (inTemplate && char === '{') {
        depth++
      }
      else if (inTemplate && char === '}') {
        if (depth === 0)
          return at

        depth--
      }

      if (!WHITESPACE.test(char)) {
        previous = char
        tail = WORD_CHAR.test(char) ? tail + char : ''
      }
      else if (tail !== '' && char !== '\n') {
        tail += ' '
      }

      at++
    }

    return source.length
  }

  code(0, false)

  return out.join('')
}

// The offset after the type arguments opening at `at` (a `<`), an arrow's `=>` not closing one, or -1 when they do not close.
function typeArgumentsEnd(source: string, at: number): number {
  let depth = 0
  let braces = 0

  for (let end = at; end < source.length && end < at + 400; end++) {
    const char = source[end]

    if (char === '{')
      braces++
    else if (char === '}')
      braces--
    else if (char === '<')
      depth++
    else if (char === '>' && source[end - 1] !== '=' && --depth === 0)
      return end + 1
    // A `;` outside an object type ends the statement, so it was a comparison and not type arguments.
    else if (char === ';' && braces <= 0)
      return -1
  }

  return -1
}

// The offsets of `name` as a key of an object literal passed directly to a call of `callee`, in `source` with its strings and comments blanked.
function callKeys(source: string, callee: string, name: string): number[] {
  const found: number[] = []
  const open = new RegExp(`(?<![\\w$.])${callee}\\s*(?=[<(])`, 'g')
  const key = new RegExp(`^${name}(?![\\w$])(?=\\s*[:,}])`)

  for (const call of source.matchAll(open)) {
    const stack: string[] = ['(']
    let previous = '('
    let at = call.index + call[0].length

    if (source[at] === '<') {
      const end = typeArgumentsEnd(source, at)

      at = end === -1 ? -1 : end + (WHITESPACE_RUN.exec(source.slice(end))?.[0].length ?? 0)

      if (at === -1 || source[at] !== '(')
        continue
    }

    at++

    while (at < source.length && stack.length > 0) {
      const char = source[at]!

      if (char === '(' || char === '[' || char === '{')
        stack.push(char)
      else if (char === ')' || char === ']' || char === '}')
        stack.pop()
      else if (stack.length === 2 && stack[1] === '{' && (previous === '{' || previous === ',') && key.test(source.slice(at, at + name.length + 40)))
        found.push(at)

      if (!WHITESPACE.test(char))
        previous = char

      at++
    }
  }

  return found
}

// `ctx.failed(add)`, the action a plain name or a path of them.
function outcomePattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])ctx\\s*\\.\\s*${name}\\(\\s*[\\p{ID_Start}$_][\\p{ID_Continue}$]*(?:\\s*\\.\\s*[\\p{ID_Start}$_][\\p{ID_Continue}$]*)*\\s*\\)`, 'gu')
}

function methodPattern(name: string): RegExp {
  return new RegExp(`(?<=\\.)${name}(?=\\s*\\()`, 'g')
}

// `auth.from(` or `ctx.locals.auth.from(`: the receiver chain, then the name.
const authPatterns = new Map<string, RegExp>()

function authMethodPattern(name: string): RegExp {
  const known = authPatterns.get(name)

  if (known)
    return known

  const pattern = new RegExp(`(?<![\\w$.])((?:[\\w$]+\\s*\\??\\.\\s*)*auth)\\s*\\??\\.\\s*(${name})(?=\\s*\\()`, 'g')

  authPatterns.set(name, pattern)

  return pattern
}

// The offset after the parenthesis closing the one at `open`, in a source with its strings blanked.
function closing(source: string, open: number): number {
  let depth = 0
  let at = open

  while (at < source.length) {
    const char = source[at]!

    if (char === '(')
      depth++
    else if (char === ')' && --depth === 0)
      return at + 1

    at++
  }

  return -1
}

interface Place {
  start: number
  // What the report underlines and names when it is not `from`.
  old?: string
  now?: string
  edits: { start: number, end: number, text: string }[] | undefined
}

const STATEMENT_END = /^[ \t]*(?:;|\r?\n|$|\})/
const AFTER_CALL = /^\s*(?:\?\.|[.[(])/

// The places `rename` matches in `scan`, `source` with its strings and comments blanked, the edits written from `source`.
function placesOf(source: string, scan: string, rename: RenamedName): Place[] {
  const { from, to, kind, call, receiver, answersOk } = rename
  const key = (start: number): Place => ({ start, edits: [{ start, end: start + from.length, text: scan.slice(start + from.length).trimStart().startsWith(':') ? to : `${to}: ${from}` }] })

  if (kind === 'outcome') {
    return [...scan.matchAll(outcomePattern(from))].map((match) => {
      const action = source.slice(match.index + match[0].indexOf('(') + 1, match.index + match[0].lastIndexOf(')')).trim()
      const now = `${action}.${to}()`

      return { start: match.index, old: source.slice(match.index, match.index + match[0].length), now, edits: [{ start: match.index, end: match.index + match[0].length, text: now }] }
    })
  }

  if (call !== undefined)
    return callKeys(scan, call, from).map(key)

  if (kind === 'key')
    return [...scan.matchAll(keyPattern(from))].map(match => key(match.index))

  if (!receiver)
    return [...scan.matchAll(methodPattern(from))].map(match => ({ start: match.index, edits: [{ start: match.index, end: match.index + from.length, text: to }] }))

  return [...scan.matchAll(authMethodPattern(from))].map((match) => {
    const start = match.index + match[0].length - from.length
    const end = start + from.length

    if (!answersOk)
      return { start, edits: [{ start, end, text: to }] }

    const awaited = AWAIT_BEFORE.exec(scan.slice(0, match.index))
    const stop = closing(scan, end + scan.slice(end).indexOf('('))

    if (awaited === null || stop === -1 || AFTER_CALL.test(scan.slice(stop)))
      return { start, edits: undefined }

    const from_ = match.index - awaited[0].length
    const call_ = `${source.slice(match.index, start)}${to}${source.slice(end, stop)}`
    const lineStart = scan.lastIndexOf('\n', from_ - 1) + 1
    const alone = scan.slice(lineStart, from_).trim() === '' && STATEMENT_END.test(scan.slice(stop))

    // A line starting with the call would start with a parenthesis, joining the line before it.
    if (!alone && scan.slice(lineStart, from_).trim() === '')
      return { start, edits: undefined }

    // A statement keeps no `.ok`, which a line starting with a parenthesis would also join to the one before it.
    return { start, edits: [{ start: from_, end: stop, text: alone ? `await ${call_}` : `(await ${call_}).ok` }] }
  })
}

export interface RenameGroup {
  lint: LintName
  renames: RenamedName[]
}

// The renames a minor made to an option or a method name: each place the project writes the old name is reported with a safe fix, the old name working three minors. Strings and comments are never matched, and a `// kay-allow` comment allows a lint on its line.
async function renamedNames(root: string, options: CheckOptions, groups: RenameGroup[]): Promise<CheckDiagnostic[]> {
  const active = groups.filter(({ lint }) => lintLevel(lint, options.lints) !== 'allow')

  if (active.length === 0)
    return []

  const found: CheckDiagnostic[] = []
  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })).filter(file => !DECLARATION_FILE.test(file))

  for (const file of files) {
    const source = await Bun.file(file).text()
    const scan = mask(source)
    const levelAt = lintLevels(source, options.lints)
    const seen = new Set<string>()

    for (const { lint, renames } of active) {
      for (const rename of renames) {
        const { from, to, why } = rename

        if (!source.includes(from))
          continue

        for (const { start, edits, old, now } of placesOf(source, scan, rename)) {
          const level = levelAt(lint, start)

          if (level === 'allow' || seen.has(`${lint}:${start}`))
            continue

          seen.add(`${lint}:${start}`)

          found.push({
            file,
            ...positionAt(source, start),
            end: start + (old?.length ?? from.length),
            message: `\`${old ?? from}\` is \`${now ?? to}\` now: ${why}; the old name keeps working for three minors`,
            help: edits === undefined ? `write \`${to}\` and read \`.ok\` of its answer` : `write \`${now ?? to}\``,
            code: lint,
            severity: level === 'warn' ? 'warning' : 'error',
            ...edits && { fixes: [{ title: `Rename ${old ?? from} to ${now ?? to}`, edits, safe: true }] },
          })
        }
      }
    }
  }

  return found
}

// Every size limit is `maxSize`, whatever it limits.
const BODY_LIMIT_WHY = 'every size limit of kay and its libraries is `maxSize`'
const BODY_LIMIT: RenamedName[] = [
  { from: 'bodyLimit', to: 'maxSize', kind: 'key', why: BODY_LIMIT_WHY },
  { from: 'bodyLimit', to: 'maxSize', kind: 'key', call: 'api', why: BODY_LIMIT_WHY },
  { from: 'bodyLimit', to: 'maxSize', kind: 'key', call: 'action', why: BODY_LIMIT_WHY },
]

// A list paged by number takes `pageSize`; `limit` and `offset` stay for a window onto a list.
const PAGE_SIZE: RenamedName[] = [
  { from: 'size', to: 'pageSize', kind: 'key', call: 'infiniteList', why: 'a list paged by number takes `pageSize`' },
]

// A form's outcome is read from the action, in an island or a page alike.
const OUTCOME_WHY = 'an action reads its own outcome, `add.failed()` and `add.succeeded()`, in a page, a component and an island alike'
const OUTCOMES: RenamedName[] = [
  { from: 'failed', to: 'failed', kind: 'outcome', why: OUTCOME_WHY },
  { from: 'succeeded', to: 'succeeded', kind: 'outcome', why: OUTCOME_WHY },
]

// kayjs-auth's methods: `list*` for a collection, `get*` for one, `revoke*` for a credential and `delete*` for a record.
const WHY = 'kayjs-auth names a collection `list*`, one item `get*`, a credential `revoke*` and a record `delete*`'
const AUTH_METHODS: RenamedName[] = [
  { from: 'sessions', to: 'listSessions', kind: 'method', receiver: true, why: WHY },
  { from: 'passkeys', to: 'listPasskeys', kind: 'method', receiver: true, why: WHY },
  { from: 'tokens', to: 'listTokens', kind: 'method', receiver: true, why: WHY },
  { from: 'members', to: 'listMembers', kind: 'method', receiver: true, why: WHY },
  { from: 'organizations', to: 'listOrganizations', kind: 'method', receiver: true, why: WHY },
  { from: 'organization', to: 'getOrganization', kind: 'method', receiver: true, why: WHY },
  { from: 'invitations', to: 'listInvitations', kind: 'method', receiver: true, why: WHY },
  { from: 'myInvitations', to: 'listMyInvitations', kind: 'method', receiver: true, why: WHY },
  { from: 'invitation', to: 'getInvitation', kind: 'method', receiver: true, why: WHY },
  { from: 'oauthClients', to: 'listOAuthClients', kind: 'method', receiver: true, why: WHY },
  { from: 'identities', to: 'listIdentities', kind: 'method', receiver: true, why: WHY },
  { from: 'auditLog', to: 'listAuditLog', kind: 'method', receiver: true, why: WHY },
  { from: 'adminAuditLog', to: 'listAdminAuditLog', kind: 'method', receiver: true, why: WHY },
  { from: 'removePasskey', to: 'revokePasskey', kind: 'method', receiver: true, why: WHY },
  { from: 'removeMember', to: 'deleteMember', kind: 'method', receiver: true, why: WHY },
  { from: 'endSession', to: 'revokeSession', kind: 'method', receiver: true, answersOk: true, why: `${WHY}, and a refusal answers \`{ ok }\`` },
]

// The renames of the 1.70 naming conventions, each under its own lint.
export async function renameChecks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedNames(root, options, [
    { lint: 'deprecated-body-limit', renames: BODY_LIMIT },
    { lint: 'deprecated-page-size', renames: PAGE_SIZE },
    { lint: 'deprecated-auth-method', renames: AUTH_METHODS },
    { lint: 'deprecated-ctx-outcome', renames: OUTCOMES },
  ])
}
