import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintLevel } from '../compiler/lints'
import type { UiToken } from './ui-tokens'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CSS_FILE, findProjectFiles, KAY_FILE } from '../build/files'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { UI_TOKEN_UTILITIES, UI_TOKENS, UNKNOWN_KUI_UTILITY } from './ui-tokens'

const NAME = /(?<![\w-])--[\w-]*kui-[\w-]+/g
const COMMENT = /\/\*[\s\S]*?\*\//g
const APPLY = /@apply\b[^;{}]*/g
const VAR_BEFORE = /var\(\s*$/
const THEME_BEFORE = /theme\(\s*$/
const DECLARED_AFTER = /^['"`]?\s*:/
const CSS_DECLARED_AFTER = /^\s*:/
const SHORTHAND_BEFORE = /-\($/
const SHORTHAND_AFTER = /^\s*\)/

interface Scan {
  file: string
  source: string
  // The source with comments blanked, which is what is searched; the same length, so positions agree.
  code: string
  css: boolean
  level: (offset: number) => LintLevel
  found: CheckDiagnostic[]
  // The tokens a declaration of stays as written, so what reads them is left alone too: rewriting it would drop the app's own value.
  kept: Set<UiToken>
  // What each report is about and whether it reads the token or declares it, to drop the fixes of the kept ones once every file is read.
  reports: { diagnostic: CheckDiagnostic, token: UiToken, declaration: boolean }[]
  // The blocks a declaration was renamed in, by the block and the new name, so two old names never become one.
  renamed: Set<string>
}

// An app's use of a kayjs-ui theme token under a name removed in 1.75, which builds nothing or resolves to nothing: a declaration, a `var()`, `--theme()`, a `(--name)` or a utility reading it, in a stylesheet, a `.kay` file or src/ui.ts. The fix writes what the alias in theme.css rendered, so no pixel moves: a reference or a utility is always rewritten, a declaration only where the new name reads the old one and the block does not set the new one.
export async function removedUiTokens(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('removed-ui-token', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const kept = new Set<UiToken>()
  const reports: Scan['reports'] = []
  const ui = join(root, 'src/ui.ts')
  const files = [...await findProjectFiles(root, CSS_FILE, { project: true, ownOnly: true }), ...await findProjectFiles(root, KAY_FILE, { project: true, ownOnly: true }), ...existsSync(ui) ? [ui] : []]

  for (const file of files) {
    const source = await Bun.file(file).text()

    if (!source.includes('kui-'))
      continue

    const css = CSS_FILE.test(file)
    // Comments are blanked, not cut, so a position still points into the file.
    const code = css ? source.replace(COMMENT, blank) : blankComments(source)
    const levelAt = lintLevels(source, options.lints)

    scanNames({ file, source, code, css, level: offset => levelAt('removed-ui-token', offset), found, kept, reports, renamed: new Set() })
  }

  // A name the app declares and keeps is read as the app set it, so a reference to it is reported only.
  for (const { diagnostic, token, declaration } of reports) {
    if (!declaration && kept.has(token))
      delete diagnostic.fixes
  }

  return found
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

// A `.kay` file or src/ui.ts with its `//` and `/* */` comments blanked, quoted strings left alone so a URL in one is not a comment; a quote ends at its line, as prose in a template holds apostrophes, and only a backtick runs on.
function blankComments(source: string): string {
  let out = ''
  let index = 0
  let quote = ''

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      if (char === '\\' && next !== undefined && next !== '\n') {
        out += char + next
        index += 2

        continue
      }

      if (char === quote || (char === '\n' && quote !== '`'))
        quote = ''
    }
    else if (char === '"' || char === '\'' || char === '`') {
      quote = char
    }
    else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      const end = close < 0 ? source.length : close + 2

      out += blank(source.slice(index, end))
      index = end

      continue
    }
    else if (char === '/' && next === '/' && source[index - 1] !== ':') {
      const newline = source.indexOf('\n', index)
      const end = newline < 0 ? source.length : newline

      out += blank(source.slice(index, end))
      index = end

      continue
    }

    out += char
    index++
  }

  return out
}

function scanNames(scan: Scan): void {
  const { code, css } = scan

  for (const match of code.matchAll(NAME)) {
    const token = UI_TOKENS[match[0]]

    if (token)
      reportName(scan, match[0], match.index, token)
  }

  // A stylesheet reads utilities in `@apply` only; elsewhere any string may hold a class.
  for (const segment of css ? code.matchAll(APPLY) : [{ 0: code, index: 0 }])
    scanUtilities(scan, segment[0], segment.index)
}

function push(scan: Scan, token: UiToken | undefined, declaration: boolean, start: number, end: number, message: string, help: string | undefined, edits?: { start: number, end: number, text: string }[]): void {
  const level = scan.level(start)

  if (level === 'allow')
    return

  if (token && declaration && !edits)
    scan.kept.add(token)

  const diagnostic: CheckDiagnostic = {
    file: scan.file,
    ...positionAt(scan.source, start),
    end,
    message,
    ...help === undefined ? {} : { help },
    code: 'removed-ui-token',
    severity: level === 'warn' ? 'warning' : 'error',
    ...edits && { fixes: [{ title: edits.length === 1 ? `Write \`${edits[0]!.text}\`` : 'Rewrite it', edits, safe: true }] },
  }

  scan.found.push(diagnostic)

  if (token)
    scan.reports.push({ diagnostic, token, declaration })
}

const SINCE = 'since 1.75, when kayjs-ui stopped aliasing its old `kui-` names to the app\'s own'

function reportName(scan: Scan, name: string, start: number, token: UiToken): void {
  const { code, css } = scan
  const end = start + name.length
  const before = code.slice(Math.max(0, start - 16), start)
  const after = code.slice(end, end + 16)
  const instead = token.to === undefined ? 'no longer a token' : `\`${token.to}\``
  const message = `\`${name}\` is ${instead} ${SINCE}`
  const help = token.help ?? (token.to === undefined ? undefined : `write \`${token.to}\``)

  if ((css ? CSS_DECLARED_AFTER : DECLARED_AFTER).test(after) && !before.endsWith('(')) {
    const safe = token.declares === true && token.to !== undefined && !declaredNearby(scan, start, token.to)

    push(scan, token, true, start, end, message, help ?? 'restyle it from your `@theme` with the new name', safe ? [{ start, end, text: token.to! }] : undefined)

    return
  }

  const reference = VAR_BEFORE.exec(before)

  if (reference) {
    const from = start - before.length + reference.index

    // The new name keeps a fallback the app wrote; a name that folded into a value takes the value, fallback and all.
    if (token.to !== undefined) {
      push(scan, token, false, start, end, message, help, [{ start, end, text: token.to }])

      return
    }

    const close = token.value === undefined ? -1 : closing(code, from + 3)

    push(scan, token, false, start, end, message, help, close < 0 ? undefined : [{ start: from, end: close + 1, text: token.value! }])

    return
  }

  if (THEME_BEFORE.test(before) || (SHORTHAND_BEFORE.test(before) && SHORTHAND_AFTER.test(after))) {
    push(scan, token, false, start, end, message, help, token.to === undefined ? undefined : [{ start, end, text: token.to }])
  }
}

// The index of the parenthesis closing the one at `open`, or -1.
function closing(code: string, open: number): number {
  let depth = 0

  for (let index = open; index < code.length; index++) {
    if (code[index] === '(')
      depth++
    else if (code[index] === ')' && --depth === 0)
      return index
  }

  return -1
}

// Whether the declaration at `start` sits where its new name is already set: in the same braces of a stylesheet, on the same line anywhere else. Two old names becoming one new name count too.
function declaredNearby(scan: Scan, start: number, to: string): boolean {
  const { code, css } = scan
  // Outside a stylesheet there are no braces to scope by, so the whole file counts.
  const here = css ? blockAround(code, start) : { from: 0, to: code.length }
  const key = `${here.from}:${to}`

  if (scan.renamed.has(key) || declaration(to).test(code.slice(here.from, here.to)))
    return true

  scan.renamed.add(key)

  return false
}

const declarations = new Map<string, RegExp>()

function declaration(name: string): RegExp {
  let found = declarations.get(name)

  if (!found)
    declarations.set(name, found = new RegExp(`(?<![\\w-])${name}['"\`]?\\s*:`))

  return found
}

// The text between the braces holding `at`, the whole file when it is at the top.
function blockAround(code: string, at: number): { from: number, to: number } {
  let depth = 0
  let from = 0
  let to = code.length

  for (let index = at - 1; index >= 0; index--) {
    if (code[index] === '}') {
      depth++
    }
    else if (code[index] === '{' && depth-- === 0) {
      from = index + 1

      break
    }
  }

  depth = 0

  for (let index = at; index < code.length; index++) {
    if (code[index] === '{') {
      depth++
    }
    else if (code[index] === '}' && depth-- === 0) {
      to = index

      break
    }
  }

  return { from, to }
}

function scanUtilities(scan: Scan, text: string, base: number): void {
  const known = new Set<number>()

  for (const { pattern, tokens } of UI_TOKEN_UTILITIES) {
    for (const match of text.matchAll(pattern)) {
      const [whole, negative, prefix, name] = match as unknown as [string, string, string, string]
      const token = tokens.get(name)!
      const start = base + match.index
      const end = start + whole.length

      known.add(start)

      const modified = text[match.index + whole.length] === '/'
      const old = `${negative}${prefix}-kui-${name}`
      const replacement = token.utility === undefined || (modified && token.utility.includes('/')) ? undefined : `${negative}${prefix}-${token.utility}`

      push(scan, token, false, start, end, `\`${old}\` is ${replacement === undefined ? 'no longer a utility' : `\`${replacement}\``} ${SINCE}`, token.help ?? (replacement === undefined ? undefined : `write \`${replacement}\``), replacement === undefined ? undefined : [{ start, end, text: replacement }])
    }
  }
  for (const match of text.matchAll(UNKNOWN_KUI_UTILITY)) {
    const start = base + match.index

    if (!known.has(start))
      push(scan, undefined, false, start, start + match[0].length, `\`${match[0]}\` builds nothing: it has no \`kui-\` form ${SINCE}`, 'write the app\'s own theme name, such as `bg-surface` for `--color-surface`: the mapping is under 1.75.0 in llms/upgrading.md')
  }
}
