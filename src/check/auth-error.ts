import type { Fix } from '../compiler/ast'
import { parseProgram } from '../compiler/estree'
import { parseKay } from '../compiler/parser'
import { walk } from './ast'

// The TypeScript codes of a string compared with a value that cannot be one: `===`, `!==`, `==` and `!=` (2367), and a `case` of a `switch` (2678).
const NO_OVERLAP = 2367
const NOT_COMPARABLE = 2678
const AUTH_FAILURE = 'AuthFailure<'

const LITERAL = '(?:\'[^\'\\n]*\'|"[^"\\n]*"|`[^`\\n$]*`)'
const CHAIN = '[\\w$]+(?:\\??\\.[\\w$]+)*?\\??\\.error'
const OPERATOR = '(?:===|!==|==|!=)'
const ERROR_FIRST = new RegExp(`^(${CHAIN})\\s*${OPERATOR}\\s*${LITERAL}`)
const LITERAL_FIRST = new RegExp(`^${LITERAL}\\s*${OPERATOR}\\s*(${CHAIN})(?![\\w$])`)
const ENDS_IN_ERROR = /\??\.error$/
const PLAIN_CHAIN = /^[\w$]+(?:\??\.[\w$]+)*$/

export interface AuthErrorFound {
  message: string
  help: string
  fix?: Fix | undefined
}

function codeFix(at: number, chain: string): Fix {
  return { title: 'Read `error.code`', edits: [{ start: at, end: at, text: chain.includes('?.') ? '?.code' : '.code' }], safe: true }
}

// The innermost `switch` over an `.error` that holds the offset, with where its subject ends: parsed from the script and server fences of a .kay file, or the whole of a module.
function switchOver(file: string, source: string, offset: number): { end: number, chain: string } | undefined {
  const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
  const spans = parsed ? [parsed.script, parsed.server, parsed.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]
  let found: { end: number, chain: string } | undefined

  for (const { start: base, end } of spans) {
    const text = source.slice(base, end)
    const { program } = parseProgram(text, { lang: file.endsWith('.ts') ? 'ts' : 'tsx', recover: true })

    walk(program, (node) => {
      if (node.type !== 'SwitchStatement' || offset < base + node.start || offset >= base + node.end)
        return

      const subject = text.slice(node.discriminant.start, node.discriminant.end)

      if (ENDS_IN_ERROR.test(subject) && PLAIN_CHAIN.test(subject))
        found = { end: base + node.discriminant.end, chain: subject }
    })
  }

  return found
}

// A comparison of a kayjs-auth result's `error` with a kind, `result.error === 'limited'`, which TypeScript refuses since 1.92 as `error` is an object holding the kind as `code`: the lint reports it with a fix reading `error.code`. `message` is what TypeScript said, `offset` where its error begins in `source`, and nothing comes back for any other comparison.
export function authErrorKind(file: string, source: string, offset: number, code: number | undefined, message: string): AuthErrorFound | undefined {
  if (!message.includes(AUTH_FAILURE))
    return undefined

  const help = 'read the kind as `error.code`, `result.error.code === \'limited\'`'

  if (code === NO_OVERLAP) {
    const rest = source.slice(offset, offset + 400)
    const first = ERROR_FIRST.exec(rest)
    const reversed = first ? undefined : LITERAL_FIRST.exec(rest)
    const chain = first?.[1] ?? reversed?.[1]

    if (chain === undefined)
      return { message: 'A kayjs-auth result carries `error` as an `ErrorShape` since 1.92, with the kind as `error.code`', help }

    const at = offset + (first ? chain.length : reversed![0].length)

    return { message: `\`${chain}\` is an object since 1.92, with the kind as \`${chain}.code\``, help, fix: codeFix(at, chain) }
  }

  if (code === NOT_COMPARABLE) {
    const found = switchOver(file, source, offset)

    return found === undefined
      ? { message: 'A kayjs-auth result carries `error` as an `ErrorShape` since 1.92, with the kind as `error.code`', help: 'switch over `error.code`' }
      : { message: `\`${found.chain}\` is an object since 1.92, with the kind as \`${found.chain}.code\``, help: 'switch over `error.code`', fix: codeFix(found.end, found.chain) }
  }

  return undefined
}
