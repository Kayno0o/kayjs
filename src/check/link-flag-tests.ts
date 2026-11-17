import type { CheckDiagnostic } from '.'
import type { Fix } from '../compiler/ast'
import type { Node } from '../compiler/estree'
import type { LintLevels } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { OLD_LINK_FLAGS } from '../compiler/link-flags'
import { lintLevel } from '../compiler/lints'
import { childrenOf } from './ast'

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const OLD_FLAG = new RegExp(`(?<![\\w-])(${Object.keys(OLD_LINK_FLAGS).join('|')})(?![\\w-])`, 'g')
const DATASET_END = /dataset$/
const ATTRIBUTE_CALL = /\.(?:get|has|set|remove|toggle)Attribute\(\s*$/

// The `dataset` property of each old flag: `data-keep-scroll` is `keepScroll`.
const DATASET_NAMES = new Map(Object.keys(OLD_LINK_FLAGS).map(name => [name.slice(5).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()), name]))

interface Scanned {
  // The content of each string literal and template chunk, as `[start, end]` offsets.
  strings: [number, number][]
  // The `x.dataset.<flag>` member expressions, and whether each is assigned, updated or deleted.
  datasets: { node: Node, written: boolean }[]
}

// What the parsed program holds that names a flag, so a regex literal or a comment cannot shift what is a string.
function scan(source: string): Scanned {
  const found: Scanned = { strings: [], datasets: [] }
  const visit = (node: Node, parent: Node | undefined) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      found.strings.push([node.start + 1, node.end - 1])
    }
    else if (node.type === 'TemplateElement') {
      // The span holds its delimiters: a backtick or `}` before, a backtick or `${` after.
      found.strings.push([node.start + 1, node.end - (source[node.end - 1] === '`' ? 1 : 2)])
    }
    else if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && DATASET_NAMES.has(node.property.name) && node.object.type === 'MemberExpression' && !node.object.computed && node.object.property.type === 'Identifier' && node.object.property.name === 'dataset') {
      const assigned = parent?.type === 'AssignmentExpression' && parent.left === node

      found.datasets.push({ node, written: assigned || parent?.type === 'UpdateExpression' || (parent?.type === 'UnaryExpression' && parent.operator === 'delete') })
    }

    for (const child of childrenOf(node))
      visit(child, node)
  }

  visit(parseProgram(source, { lang: 'ts', recover: true }).program, undefined)

  return found
}

// The selectors, attribute reads and `dataset` reads of an app's test files that name a link flag by its name before 1.105, which `deprecated-link-flags` rewrites in the templates: `[data-keep-scroll]` is written `[data-scroll=keep]`, as the template's attribute was.
// An attribute read by name (`getAttribute('data-keep-scroll')`) and a read of `dataset.keepScroll` get a fix that is not safe, as the new name holds a word where the old one was there or not; any other string naming the flag (a selector with a value, one built in a template) and a write of `dataset` are reported with no fix.
export async function linkFlagTests(root: string, levels: LintLevels | undefined): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-link-flags', levels)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of (await findProjectFiles(root, TEST_FILE, { project: true, ownKayOnly: true })).sort()) {
    const source = await Bun.file(file).text()
    const { strings, datasets } = scan(source)
    const report = (start: number, end: number, message: string, help: string, fixes: Fix[] | undefined) => {
      const before = source.slice(0, start).split('\n')

      found.push({ file, line: before.length, column: before.at(-1)!.length + 1, end, severity: level === 'warn' ? 'warning' : 'error', code: 'deprecated-link-flags', message, help, ...fixes === undefined ? {} : { fixes } })
    }

    for (const match of source.matchAll(OLD_FLAG)) {
      const name = match[1]!
      const end = match.index + name.length
      const string = strings.find(([from, to]) => match.index >= from && end <= to)

      if (string === undefined)
        continue

      const next = OLD_LINK_FLAGS[name]!
      const written = `${next.name}=${next.value}`
      const selector = source[match.index - 1] === '[' && source[end] === ']'
      const read = !selector && string[1] - string[0] === name.length && ATTRIBUTE_CALL.test(source.slice(Math.max(0, string[0] - 201), string[0] - 1))
      let fixes: Fix[] | undefined

      if (selector)
        fixes = [{ title: `write [${written}]`, safe: true, edits: [{ start: match.index - 1, end: end + 1, text: `[${written}]` }] }]
      else if (read)
        fixes = [{ title: `write ${next.name}`, safe: false, edits: [{ start: match.index, end, text: next.name }] }]

      report(match.index, end, `\`${name}\` is \`${written}\`, deprecated since 1.105: a template written with the new attribute no longer matches this`, `select \`[${written}]\`; an attribute read follows the new name, whose value is \`${next.value}\` where the old one was present`, fixes)
    }

    for (const { node, written } of datasets) {
      const member = node as Node & { object: Node, property: Node & { name: string } }
      const old = OLD_LINK_FLAGS[DATASET_NAMES.get(member.property.name)!]!
      const to = `dataset.${old.name.slice(5)} === '${old.value}'`
      const fixes: Fix[] | undefined = written ? undefined : [{ title: `write ${to}`, safe: false, edits: [{ start: node.start, end: node.end, text: `(${source.slice(member.object.start, member.object.end).replace(DATASET_END, '')}${to})` }] }]

      report(node.start, node.end, `\`dataset.${member.property.name}\` is \`${to}\`, deprecated since 1.105: the template's attribute is \`${old.name}\``, `read \`${to}\`; a write is set on \`${old.name}\` by hand`, fixes)
    }
  }

  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}
