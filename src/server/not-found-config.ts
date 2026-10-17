import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { readRedirects } from './redirects'

const CONFIG_OBJECT = /(?:defineConfig\(|export default )\{/
const TARGET = /^(?:\/|https?:\/\/)/
const EMPTY_OBJECT = /^\s*\}/
const IDENTIFIER_START = /[\w$]/
const CONTROL = /\p{Cc}/u
const WHITESPACE = /\s/

// Throws, saying why, when a path and a target are no redirect to add to a config whose redirects are `existing`.
export function checkRedirect(redirect: string, target: string, existing: ReadonlySet<string>): void {
  if (existing.has(redirect))
    throw new Error(`${redirect} is a redirect already`)

  if (CONTROL.test(redirect) || CONTROL.test(target))
    throw new Error('a path and a target hold no control character')

  if (!TARGET.test(target))
    throw new Error(`${target} is no target: it starts with / or is another site's URL`)

  readRedirects({ [redirect]: target })
}

export function redirectEntry(from: string, to: string): string {
  return `${quoted(from)}: ${quoted(to)},`
}

function quoted(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

// Where the config object's own `redirects` key stands: the offset after its `{`, `'other'` for a value that is no literal, undefined when the key is absent.
// Strings and comments are skipped, and only the object's top level is read.
function redirectsOf(config: string, from: number): number | 'other' | undefined {
  let depth = 0

  for (let at = from; at < config.length; at++) {
    const char = config[at]!

    if (char === '/' && config[at + 1] === '/') {
      at = config.indexOf('\n', at)

      if (at === -1)
        break
    }
    else if (char === '/' && config[at + 1] === '*') {
      at = config.indexOf('*/', at + 2) + 1

      if (at === 0)
        break
    }
    else if (char === '\'' || char === '"' || char === '`') {
      const start = at

      for (at++; at < config.length && config[at] !== char; at++) {
        if (config[at] === '\\')
          at++
      }

      if (depth === 1 && config.slice(start + 1, at) === 'redirects' && keyColonAt(config, at + 1))
        return after(config, at + 1)
    }
    else if (char === '{' || char === '[' || char === '(') {
      depth++
    }
    else if (char === '}' || char === ']' || char === ')') {
      if (--depth === 0)
        return undefined
    }
    else if (depth === 1 && IDENTIFIER_START.test(char) && !IDENTIFIER_START.test(config[at - 1] ?? ' ') && config.startsWith('redirects', at) && !IDENTIFIER_START.test(config[at + 9] ?? ' ')) {
      return after(config, at + 9)
    }
  }

  return undefined
}

// The offset past the whitespace and comments from `at`.
function skipTrivia(config: string, at: number): number {
  for (;;) {
    if (WHITESPACE.test(config[at] ?? '')) {
      at++
    }
    else if (config.startsWith('//', at)) {
      const end = config.indexOf('\n', at)

      if (end === -1)
        return config.length

      at = end
    }
    else if (config.startsWith('/*', at)) {
      const end = config.indexOf('*/', at + 2)

      if (end === -1)
        return config.length

      at = end + 2
    }
    else {
      return at
    }
  }
}

// Whether a `:` follows at `at`, past any whitespace and comments.
function keyColonAt(config: string, at: number): boolean {
  return config[skipTrivia(config, at)] === ':'
}

// The offset after the `{` of a `: {` at `at`, `'other'` when the value is no object literal.
function after(config: string, at: number): number | 'other' {
  const colon = skipTrivia(config, at)

  if (config[colon] !== ':')
    return 'other'

  const brace = skipTrivia(config, colon + 1)

  return config[brace] === '{' ? brace + 1 : 'other'
}

// `config` with the redirect added to its `redirects` object, or to a new one in the config object; undefined when there is no literal object to add to.
export function withRedirect(config: string, from: string, to: string): string | undefined {
  const entry = redirectEntry(from, to)
  const object = CONFIG_OBJECT.exec(config)

  if (object === null)
    return undefined

  const start = object.index + object[0].length
  const redirects = redirectsOf(config, start - 1)

  if (redirects === 'other')
    return undefined

  if (redirects !== undefined) {
    const empty = EMPTY_OBJECT.test(config.slice(redirects))

    return `${config.slice(0, redirects)}\n    ${entry}${empty ? '\n  ' : ''}${config.slice(redirects)}`
  }

  const rest = config.slice(start)

  return `${config.slice(0, start)}\n  redirects: {\n    ${entry}\n  },${rest.startsWith('\n') ? rest : `\n${rest.trimStart()}`}`
}

export async function addRedirect(path: string, from: string, to: string): Promise<'written' | 'by hand'> {
  const config = existsSync(path) ? await readFile(path, 'utf8') : undefined
  const next = config === undefined ? undefined : withRedirect(config, from, to)

  if (next === undefined)
    return 'by hand'

  await writeFile(path, next)

  return 'written'
}
