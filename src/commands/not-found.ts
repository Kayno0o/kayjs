import type { MissingPath } from '../server/not-found'
import type { Command } from './command'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { missingStore, NOT_FOUND_FILE } from '../server/not-found'
import { readRedirects } from '../server/redirects'
import { formatOption, printDocument, printFailure, projectRoot, shellQuote, withStdoutOnStderr } from './command'
import { USAGES } from './usages'

const CONFIG_OBJECT = /(?:defineConfig\(|export default )\{/
const TARGET = /^(?:\/|https?:\/\/)/
const EMPTY_OBJECT = /^\s*\}/
const IDENTIFIER_START = /[\w$]/
const CONTROL = /\p{Cc}/u
const KEY_COLON = /^\s*:/
const COLON_BRACE = /^\s*:\s*\{/
const PARAM_SEGMENT = /:[A-Z_$][\w$]*/gi
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g
const REFERRER_LIMIT = 3

// The paths visitors asked for and found nothing at, most hit first, read from the file the production server keeps.
// `--redirect <path>` turns one into a redirect in kay.config.ts, to `--to` or to the suggested target.
export const notFound: Command = {
  usage: USAGES['not-found'],
  options: { format: { type: 'string' }, redirect: { type: 'string' }, to: { type: 'string' }, file: { type: 'string' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }, refuse) => {
    const format = formatOption('not-found', values.format)

    if (format === undefined)
      return 1

    const root = projectRoot('not-found', path, format)

    if (root === undefined)
      return 1

    const redirect = typeof values.redirect === 'string' ? values.redirect : undefined
    const to = typeof values.to === 'string' ? values.to : undefined

    if (to !== undefined && redirect === undefined)
      return refuse('--to goes with --redirect')

    const file = typeof values.file === 'string' ? values.file : join(root, NOT_FOUND_FILE)

    buildingWithoutEnv()

    try {
      const config = await withStdoutOnStderr(async () => loadConfig(root))
      const redirects = Object.keys(config.redirects ?? {})
      const redirected = new Set(redirects)
      const store = existsSync(file) ? missingStore(file) : undefined

      try {
        const all = store?.list() ?? []
        const missing = all.filter(row => !answered(row.path, redirects))

        if (redirect !== undefined) {
          const found = missing.find(row => row.path === redirect)
          const target = to ?? found?.target

          if (target === undefined)
            throw new Error(`${redirect} has no suggested target: name one with --to <path>`)

          if (redirected.has(redirect))
            throw new Error(`${redirect} is a redirect already`)

          if (CONTROL.test(redirect) || CONTROL.test(target))
            throw new Error('a path and a target hold no control character')

          if (!TARGET.test(target))
            throw new Error(`${target} is no target: it starts with / or is another site's URL`)

          readRedirects({ [redirect]: target })

          const written = await addRedirect(join(root, 'kay.config.ts'), redirect, target)

          if (written === 'by hand') {
            printFailure('not-found', `kay.config.ts has no \`redirects\` object literal to add the redirect to: add it by hand\n  ${redirectEntry(redirect, target)}`, format)

            return 1
          }

          store?.forget(redirect)

          if (format === 'json')
            printDocument({ redirect: { from: redirect, to: target } })
          else
            console.log(`Added to ${relative(process.cwd(), join(root, 'kay.config.ts')) || 'kay.config.ts'}: ${redirectEntry(redirect, target)}`)

          return 0
        }

        if (format === 'json') {
          printDocument({ missing })

          return 0
        }

        console.log(formatListing(missing, all.length > 0))

        return 0
      }
      finally {
        store?.close()
      }
    }
    catch (error) {
      printFailure('not-found', error instanceof Error ? error.message : error, format)

      return 1
    }
  },
}

function formatListing(missing: MissingPath[], redirected: boolean): string {
  if (missing.length === 0 && redirected)
    return 'Every recorded path has a redirect.'

  if (missing.length === 0)
    return 'No missing path recorded: the production server records the pages visitors asked for and found nothing at in data/not-found.sqlite.'

  return missing.map(({ path, hits, referrers, target, reason }) => {
    const from = referrers.slice(0, REFERRER_LIMIT).map(({ host }) => host).join(', ')
    const lines = [`${String(hits).padStart(6)}  ${path}${from === '' ? '' : `  (from ${from}${referrers.length > REFERRER_LIMIT ? ', ...' : ''})`}`]

    if (target !== undefined)
      lines.push(`        -> ${target}  (${reason}) kay not-found --redirect ${shellQuote(path)}`)

    return lines.join('\n')
  }).join('\n')
}

function redirectEntry(from: string, to: string): string {
  return `${quoted(from)}: ${quoted(to)},`
}

function quoted(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

// Whether a redirect of the config takes the path: `:name` stands for a segment, a final `*` for the rest.
export function answered(path: string, redirects: string[]): boolean {
  return redirects.some((from) => {
    const star = from.endsWith('/*')
    const body = (star ? from.slice(0, -2) : from).replace(REGEX_SPECIALS, '\\$&').replace(PARAM_SEGMENT, '[^/]+')

    return new RegExp(`^${body}${star ? '(?:/.*)?' : ''}$`).test(path)
  })
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

      if (depth === 1 && config.slice(start + 1, at) === 'redirects' && KEY_COLON.test(config.slice(at + 1, at + 40)))
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

function after(config: string, at: number): number | 'other' {
  const rest = config.slice(at)
  const colon = COLON_BRACE.exec(rest)

  return colon === null ? 'other' : at + colon[0].length
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

async function addRedirect(path: string, from: string, to: string): Promise<'written' | 'by hand'> {
  const config = existsSync(path) ? await readFile(path, 'utf8') : undefined
  const next = config === undefined ? undefined : withRedirect(config, from, to)

  if (next === undefined)
    return 'by hand'

  await writeFile(path, next)

  return 'written'
}
