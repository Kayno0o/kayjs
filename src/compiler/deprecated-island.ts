import type { Diagnostic, Fix, KayFile, Span } from './ast'
import type { ScriptAnalysis } from './script'
import { elementsIn } from './ast'
import { islandExport } from './island-arguments'

const FENCE_WORD = /^---([ \t]+)(client|island|static)\b/
const LABELED_LINE = /^---[ \t]*[a-z<]/
const TRAILING_COMMA = /,$/
// A `//` comment closing the text, which would swallow what a call writes after it on the same line.
const LINE_COMMENT_END = /\/\/[^\n]*$/

// The object an `export const island = { ... }` of the module fence gives, without its `as const`: its properties as written, and the statement to take out.
function exportedObject(script: ScriptAnalysis): { properties: string, statement: { start: number, end: number } } | undefined {
  const asked = islandExport(script)
  const fence = script.moduleFence

  if (asked?.form !== 'const' || fence === undefined)
    return undefined

  for (const statement of fence.ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration')
      continue

    const init = statement.declaration.declarations.find(declarator => declarator.id.type === 'Identifier' && declarator.id.name === 'island')?.init
    const object = init?.type === 'TSAsExpression' || init?.type === 'TSSatisfiesExpression' ? init.expression : init

    if (object?.type !== 'ObjectExpression')
      return undefined

    const inner = fence.code.slice(object.start + 1, object.end - 1).trim().replace(TRAILING_COMMA, '')

    return { properties: inner, statement: asked.span }
  }

  return undefined
}

// The edit taking the word `island`, `static` or `client` off a script fence line: a bare `---` opens the script only as the first fence of the file, so after a named fence the line keeps `script`. `before` is the text above the line that stays.
export function wordEdit(line: Span, wordEnd: number, before: string): Fix['edits'][number] {
  return before.trim() === '' ? { start: line.start + 3, end: wordEnd, text: '' } : { start: line.start + 4, end: wordEnd, text: 'script' }
}

// A fence line naming a role beside an `island()` call: the two say it twice, and the fence line would win over the call. The fix drops the word, which may change the role the call says.
export function fenceBesideCall(file: KayFile): Diagnostic[] {
  const island = file.island
  const line = file.scriptLine
  const fence = [file.client !== island?.span ? file.client : undefined, file.pin?.start !== island?.span.start ? file.pin : undefined].find(span => span !== undefined)

  if (island === undefined || line === undefined || fence === undefined)
    return []

  return [{ ...fence, code: 'fence-invalid', message: 'A fence line and `island()` both say how the component renders', help: 'keep `island()` and write `---` for the fence line', fixes: [{ title: 'Drop the fence word', safe: false, edits: [wordEdit(line, fence.end, file.source.slice(0, line.start))] }] }]
}

// The `--- island`, `--- static` and `--- client` fence lines, and `export const island = { ... }` in a `--- module` fence, since 1.105: the script declares `island({ render, hydrate, persist })` as it declares `props<T>()`, one place for what a component says of its role. The fix moves each into the call; none when the file has no script fence line to put it in.
export function deprecatedIslandForms(file: KayFile, script: ScriptAnalysis): Diagnostic[] {
  const line = file.scriptLine
  const word = line === undefined ? null : FENCE_WORD.exec(file.source.slice(line.start, line.end))
  const exported = exportedObject(script)

  // A file that declares `island()` already says the rest there, and `ignoredIslandExport` reports the export.
  if (line === undefined || file.script === undefined || file.island !== undefined || (word === null && exported === undefined))
    return []

  const render = word?.[2] === 'client' || word?.[2] === 'static' ? word[2] : undefined
  const edits: Fix['edits'] = []
  // What stays above the script's fence line.
  let before = file.source.slice(0, line.start)

  if (exported !== undefined) {
    const module = file.module!
    const rest = file.source.slice(module.start, exported.statement.start) + file.source.slice(exported.statement.end, module.end)
    const labeled = LABELED_LINE.test(file.source.slice(module.end, module.end + 8))
    const header = file.source.lastIndexOf('\n', module.start - 2) + 1
    const own = file.source[exported.statement.end] === '\n' ? 1 : 0

    // A fence holding nothing else goes with its line, when a labeled line closes it and the next fence does not need it.
    if (rest.trim() === '' && labeled && file.source.slice(header, module.start).trim() === '--- module') {
      edits.push({ start: header, end: module.end, text: '' })
      // A module fence below the script line changes nothing above it.
      before = header < line.start ? file.source.slice(0, header) + file.source.slice(module.end, line.start) : before
    }
    else {
      edits.push({ start: exported.statement.start, end: exported.statement.end + own, text: '' })
    }
  }

  if (word !== null)
    edits.push(wordEdit(line, line.start + 3 + word[1]!.length + word[2]!.length, before))

  const properties = [render === undefined ? '' : `render: '${render}'`, exported?.properties ?? ''].filter(each => each !== '')

  // The call goes first in the script, which a `--- client` or `--- island` fence line no longer opens.
  edits.push({ start: file.script.start, end: file.script.start, text: `island(${properties.length === 0 ? '' : `{ ${properties.join(', ')}${LINE_COMMENT_END.test(properties.at(-1)!) ? '\n' : ' '}}`})\n` })

  const at = word === null ? exported!.statement : { start: line.start + 3 + word[1]!.length, end: line.start + 3 + word[1]!.length + word[2]!.length }

  return [{
    ...at,
    code: 'deprecated-island-fence',
    checkOnly: true,
    message: word === null ? '`export const island` in a `--- module` fence is `island({ ... })` in the script, deprecated since 1.105' : `\`--- ${word[2]}\` is \`island(${render === undefined ? '' : `{ render: '${render}' }`})\` in the script, deprecated since 1.105`,
    help: 'write `island({ render: \'client\' | \'static\', hydrate, persist, interactive })` at the top of the script, and `---` for its fence line',
    fixes: [{ title: 'Write `island()` in the script', safe: true, edits }],
  }]
}

// `hydrate="client"` and `server="defer"` on a component call, since 1.105: `render="client"` says how a use renders, and `hydrate` is only when it hydrates; a deferred server island is `defer` beside `server`.
export function deprecatedIslandAttributes(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const element of elementsIn(file.template)) {
    if (!element.component)
      continue

    for (const attribute of element.attributes) {
      if (attribute.kind !== 'static')
        continue

      const name = file.source.slice(attribute.name.start, attribute.name.end)

      if (name === 'hydrate' && attribute.text === 'client')
        found.push({ ...attribute.name, code: 'deprecated-island-attributes', checkOnly: true, message: '`hydrate="client"` is `render="client"`, deprecated since 1.105', help: 'write `render="client"`: `hydrate` is only when an island hydrates', fixes: [{ title: 'Write `render="client"`', safe: true, edits: [{ ...attribute.name, text: 'render' }] }] })

      if (name === 'server' && attribute.text === 'defer') {
        const quoted = '"\''.includes(file.source[attribute.value.end] ?? '')

        found.push({ ...attribute.name, code: 'deprecated-island-attributes', checkOnly: true, message: '`server="defer"` is `server defer`, deprecated since 1.105', help: 'write `server defer`, or `defer` alone', fixes: [{ title: 'Write `server defer`', safe: true, edits: [{ start: attribute.name.start, end: attribute.value.end + (quoted ? 1 : 0), text: 'server defer' }] }] })
      }
    }
  }

  return found
}
