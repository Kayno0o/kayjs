import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /\.(?:kay|[cm]?tsx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const WHITESPACE = /\s/
const AWAIT_BEFORE = /await\s+$/

export interface RenamedName {
  from: string
  to: string
  // `key` is an object key (`{ from: 1 }` or the shorthand `{ from }`), `method` a call on any object (`.from(`).
  kind: 'key' | 'method'
  // Only the key of an object literal passed straight to this function, for a name too common to rename everywhere.
  call?: string
  // Only a method called on an `auth` (`auth.from()`, `ctx.locals.auth.from()`), for a name other objects share.
  receiver?: boolean
  // The old method answered a boolean where the new one answers `{ ok }`: `await auth.from(x)` is fixed to `(await auth.to(x)).ok`, any other use reported with no fix.
  answersOk?: boolean
  // Why the old name goes, the end of the message.
  why: string
}

// A key after `{` or `,`, followed by its colon or the end of a shorthand.
function keyPattern(name: string): RegExp {
  return new RegExp(`(?<=[{,]\\s*)${name}(?=\\s*[:,}])`, 'g')
}

// The offsets of `name` as a key of an object literal passed directly to a call of `callee`, skipping strings and comments.
function callKeys(source: string, callee: string, name: string): number[] {
  const found: number[] = []
  const open = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g')
  const key = new RegExp(`^${name}(?=\\s*[:,}])`)

  for (const call of source.matchAll(open)) {
    const stack: string[] = ['(']
    let previous = '('
    let at = call.index + call[0].length

    while (at < source.length && stack.length > 0) {
      const char = source[at]!

      if (char === '"' || char === '\'' || char === '`') {
        at = skipString(source, at)
        previous = 'a'

        continue
      }

      if (char === '/' && source[at + 1] === '/') {
        at = source.indexOf('\n', at)

        if (at === -1)
          break

        continue
      }

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

// The offset after the string or template literal opening at `at`.
function skipString(source: string, at: number): number {
  const quote = source[at]!
  let end = at + 1

  while (end < source.length && source[end] !== quote)
    end += source[end] === '\\' ? 2 : 1

  return end + 1
}

function methodPattern(name: string): RegExp {
  return new RegExp(`(?<=\\.)${name}(?=\\s*\\()`, 'g')
}

// `auth.from(` or `ctx.locals.auth.from(`: the receiver chain, then the name.
function authMethodPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])((?:[\\w$]+\\s*\\??\\.\\s*)*auth)\\s*\\??\\.\\s*(${name})(?=\\s*\\()`, 'g')
}

// The offset after the parenthesis closing the one at `open`.
function closing(source: string, open: number): number {
  let depth = 0
  let at = open

  while (at < source.length) {
    const char = source[at]!

    if (char === '"' || char === '\'' || char === '`') {
      at = skipString(source, at)

      continue
    }

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
  edits: { start: number, end: number, text: string }[] | undefined
}

function placesOf(source: string, rename: RenamedName): Place[] {
  const { from, to, kind, call, receiver, answersOk } = rename

  if (call !== undefined)
    return callKeys(source, call, from).map(start => ({ start, edits: [{ start, end: start + from.length, text: source.slice(start + from.length).trimStart().startsWith(':') ? to : `${to}: ${from}` }] }))

  if (kind === 'key')
    return [...source.matchAll(keyPattern(from))].map(match => ({ start: match.index, edits: [{ start: match.index, end: match.index + from.length, text: source.slice(match.index + from.length).trimStart().startsWith(':') ? to : `${to}: ${from}` }] }))

  if (!receiver)
    return [...source.matchAll(methodPattern(from))].map(match => ({ start: match.index, edits: [{ start: match.index, end: match.index + from.length, text: to }] }))

  return [...source.matchAll(authMethodPattern(from))].map((match) => {
    const start = match.index + match[0].length - from.length
    const end = start + from.length

    if (!answersOk)
      return { start, edits: [{ start, end, text: to }] }

    const awaited = AWAIT_BEFORE.exec(source.slice(0, match.index))
    const stop = closing(source, end + source.slice(end).indexOf('('))

    return { start, edits: awaited === null || stop === -1 ? undefined : [{ start: match.index - awaited[0].length, end: stop, text: `(await ${source.slice(match.index, start)}${to}${source.slice(end, stop)}).ok` }] }
  })
}

// The renames a minor made to an option or a method name: each place the project writes the old name is reported with a safe fix, the old name working three minors (a shorthand `{ from }` becomes `to: from`).
export async function renamedNames(root: string, options: CheckOptions, lint: LintName, renames: RenamedName[]): Promise<CheckDiagnostic[]> {
  const level = lintLevel(lint, options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })).filter(file => !DECLARATION_FILE.test(file))

  for (const file of files) {
    const source = await Bun.file(file).text()

    for (const rename of renames) {
      const { from, to, why } = rename

      if (!source.includes(from))
        continue

      for (const { start, edits } of placesOf(source, rename)) {
        const end = start + from.length

        found.push({
          file,
          ...positionAt(source, start),
          end,
          message: `\`${from}\` is \`${to}\` now: ${why}; the old name keeps working for three minors`,
          help: edits === undefined ? `write \`${to}\` and read \`.ok\` of its answer` : `write \`${to}\``,
          code: lint,
          severity: level === 'warn' ? 'warning' : 'error',
          ...edits && { fixes: [{ title: `Rename ${from} to ${to}`, edits, safe: true }] },
        })
      }
    }
  }

  return found
}

// Every size limit is `maxSize`, whatever it limits.
const BODY_LIMIT: RenamedName[] = [
  { from: 'bodyLimit', to: 'maxSize', kind: 'key', why: 'every size limit of kay and its libraries is `maxSize`' },
]

// A list paged by number takes `pageSize`; `limit` and `offset` stay for a window onto a list.
const PAGE_SIZE: RenamedName[] = [
  { from: 'size', to: 'pageSize', kind: 'key', call: 'infiniteList', why: 'a list paged by number takes `pageSize`' },
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
  return [
    ...await renamedNames(root, options, 'deprecated-body-limit', BODY_LIMIT),
    ...await renamedNames(root, options, 'deprecated-page-size', PAGE_SIZE),
    ...await renamedNames(root, options, 'deprecated-auth-method', AUTH_METHODS),
  ]
}
