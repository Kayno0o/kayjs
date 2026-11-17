import type { CheckDiagnostic } from '.'
import type { Fix } from '../compiler/ast'
import type { LintLevels } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { OLD_LINK_FLAGS } from '../compiler/link-flags'
import { lintLevel } from '../compiler/lints'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const OLD_FLAG = new RegExp(`(?<![\\w-])(${Object.keys(OLD_LINK_FLAGS).join('|')})(?![\\w-])`, 'g')
const ATTRIBUTE_CALL = /\.(?:get|has|set|remove|toggle)Attribute\(\s*$/

// The content of each string and template literal of a script, as `[start, end]` offsets, a comment skipped: a line comment, a block comment, and a quote opened in one never counts.
function stringRanges(source: string): [number, number][] {
  const found: [number, number][] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!

    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index)

      if (index === -1)
        break

      continue
    }

    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)

      index = close === -1 ? source.length : close + 2

      continue
    }

    if (char !== '\'' && char !== '"' && char !== '`') {
      index++

      continue
    }

    let end = index + 1

    while (end < source.length && source[end] !== source[index] && (source[index] === '`' || source[end] !== '\n'))
      end += source[end] === '\\' ? 2 : 1

    found.push([index + 1, end])
    index = end + 1
  }

  return found
}

function fixFor(selector: boolean, read: boolean, written: string, name: string, start: number, end: number): Fix[] | undefined {
  if (selector)
    return [{ title: `write [${written}]`, safe: true, edits: [{ start: start - 1, end: end + 1, text: `[${written}]` }] }]

  return read ? [{ title: `write ${name}`, safe: false, edits: [{ start, end, text: name }] }] : undefined
}

// The selectors and attribute reads of an app's test files that name a link flag by its name before 1.105, which `deprecated-link-flags` rewrites in the templates: `[data-keep-scroll]` is written `[data-scroll=keep]`, as the template's attribute was. An attribute read by name (`getAttribute('data-keep-scroll')`) gets a fix that is not safe, as the new name holds a word where the old one was there or not; any other string naming the flag (a selector with a value, one built in a template) is reported with no fix.
export async function linkFlagTests(root: string, levels: LintLevels | undefined): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-link-flags', levels)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of (await findProjectFiles(root, TEST_FILE, { project: true, ownKayOnly: true })).sort()) {
    const source = await Bun.file(file).text()
    const strings = stringRanges(source)

    for (const match of source.matchAll(OLD_FLAG)) {
      const name = match[1]!
      const end = match.index + name.length
      const string = strings.find(([from, to]) => match.index >= from && end <= to)

      if (string === undefined)
        continue

      const next = OLD_LINK_FLAGS[name]!
      const selector = source[match.index - 1] === '[' && source[end] === ']'
      const read = !selector && string[1] - string[0] === name.length && ATTRIBUTE_CALL.test(source.slice(Math.max(0, string[0] - 41), string[0] - 1))
      const written = `${next.name}=${next.value}`
      const before = source.slice(0, match.index).split('\n')
      const fixes = fixFor(selector, read, written, next.name, match.index, end)

      found.push({
        file,
        line: before.length,
        column: before.at(-1)!.length + 1,
        end,
        severity: level === 'warn' ? 'warning' : 'error',
        code: 'deprecated-link-flags',
        message: `\`${name}\` is \`${written}\`, deprecated since 1.105: a template written with the new attribute no longer matches this`,
        help: `select \`[${written}]\`; an attribute read follows the new name, whose value is \`${next.value}\` where the old one was present`,
        ...fixes === undefined ? {} : { fixes },
      })
    }
  }

  return found
}
