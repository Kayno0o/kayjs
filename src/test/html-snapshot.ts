import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { callingTestFile } from './screenshot-match'

const NAME = /^[\w.-]+(?:\/[\w.-]+)*$/
const TOKEN = /<!--[\s\S]*?-->|<(script|style|pre|textarea)\b[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/gi
const COMMENT = /^<!--/
const OPEN_TAG = /^<([a-z][\w:-]*)/i
const CLOSE_TAG = /^<\/\s*[a-z]/i
const RAW = /^<(?:script|style|pre|textarea)\b/i
const WHITESPACE = /\s+/g
// Bun names a built file `<name>-<hash>.<ext>`, the hash eight letters and digits.
const HASHED_FILE = /(\/[\w./-]*?)-[\da-z]{8}(?=\.[a-z\d]+(?:[?"'\s)#]|$))/gi
// A `?v=` cache-busting version, such as a favicon's.
const VERSION = /([?&]v=)[\da-f]{6,}/gi
const NONCE = /(\bnonce=)(["'])[^"']*\2/gi
const STAMP = /(<input\s[^>]*?\sname="kay_since"[^>]*?\svalue=)"[^"]*"/g
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

// A page's markup as a snapshot holds it, the same from one build to the next: comments (the hydration markers among them) left out, the hash of each built file's name and of a `?v=` version, each nonce and the stamp of a `minTime` form replaced by a fixed word, and one tag or run of text a line, indented by depth.
export function normalizeHtml(html: string): string {
  const lines: string[] = []
  let depth = 0

  for (const token of html.replace(HASHED_FILE, '$1-HASH').replace(VERSION, '$1HASH').replace(NONCE, '$1$2NONCE$2').replace(STAMP, '$1"STAMP"').match(TOKEN) ?? []) {
    if (COMMENT.test(token))
      continue

    const indent = '  '.repeat(depth)

    if (RAW.test(token)) {
      lines.push(`${indent}${token.trim()}`)

      continue
    }

    if (!token.startsWith('<')) {
      const text = token.replace(WHITESPACE, ' ').trim()

      if (text !== '')
        lines.push(`${indent}${text}`)

      continue
    }

    if (CLOSE_TAG.test(token))
      depth = Math.max(0, depth - 1)

    lines.push(`${'  '.repeat(depth)}${token.replace(WHITESPACE, ' ')}`)

    const tag = OPEN_TAG.exec(token)?.[1]?.toLowerCase()

    if (tag !== undefined && !VOID.has(tag) && !token.endsWith('/>'))
      depth++
  }

  return `${lines.join('\n')}\n`
}

// What a page's `matchHtml` runs: the test file is read off `stack`, taken where the call began.
export async function matchHtml(stack: string | undefined, html: string, name: string): Promise<void> {
  await matchHtmlFile(normalizeHtml(html), name, callingTestFile(stack, 'matchHtml'))
}

// Compares normalised markup with the baseline `<test dir>/__html__/<test file>/<name>.html`.
// The baseline is written when there is none, or when `KAY_UPDATE_SNAPSHOTS` is set, and a missing one fails under `CI`; a difference writes `<name>.actual.html` beside it and fails, and a match removes it.
export async function matchHtmlFile(normalised: string, name: string, testFile: string): Promise<void> {
  if (!NAME.test(name) || name.split('/').includes('..'))
    throw new Error(`kay: matchHtml takes a name of letters, digits, dots, dashes and slashes, not ${JSON.stringify(name)}`)

  const base = join(dirname(testFile), '__html__', basename(testFile), name)
  const baseline = `${base}.html`
  const actual = `${base}.actual.html`
  const update = (process.env.KAY_UPDATE_SNAPSHOTS ?? '') !== '' && process.env.KAY_UPDATE_SNAPSHOTS !== '0'

  rmSync(actual, { force: true })

  if (update || !existsSync(baseline)) {
    if (!update && (process.env.CI ?? '') !== '')
      throw new Error(`kay: matchHtml has no baseline ${baseline} and a CI run writes none: run the test locally and commit it`)

    mkdirSync(dirname(baseline), { recursive: true })
    await Bun.write(baseline, normalised)

    return
  }

  const expected = await Bun.file(baseline).text()

  if (expected === normalised)
    return

  await Bun.write(actual, normalised)

  const before = expected.split('\n')
  const after = normalised.split('\n')
  const line = after.findIndex((text, at) => text !== before[at])
  const at = line === -1 ? after.length : line

  throw new Error(`kay: the HTML ${name} differs from ${baseline} from line ${at + 1}: expected ${JSON.stringify(before[at] ?? '(end)')}, got ${JSON.stringify(after[at] ?? '(end)')}; see ${actual}, and rewrite the baseline with KAY_UPDATE_SNAPSHOTS=1 if the change is meant`)
}
