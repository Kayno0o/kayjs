// Draft messages: a machine's translation waiting for a person, a message whose line in its locale's file ends on a `// draft` comment.
import type * as t from '@babel/types'
import type { KayConfig } from '../config'
import type { Message } from '../runtime/i18n'
import { existsSync } from 'node:fs'
import { parse } from '@babel/parser'
import { KayError } from '../compiler/errors'
import { messagesFile } from './i18n'

const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const DRAFT = /^\s*draft\b/
const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const INDENT = /^[ \t]*/
const INDENTED = /^([ \t]+)\S/gm
const PLURAL_KEYS = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

// A message as its file writes it: its dotted key, the line its key is on, and the `// draft` comment on that line when there is one.
interface WrittenMessage {
  key: string
  line: number
  draft?: t.CommentLine | undefined
}

// The keys of the messages a file marks `// draft`, with the line each is on, in the order written; none for a file kay cannot read the messages of.
export function draftMessages(source: string): { key: string, line: number }[] {
  return writtenMessages(source).filter(message => message.draft !== undefined).map(({ key, line }) => ({ key, line }))
}

// The source with every `// draft` comment of its messages removed, and how many it removed: one comment after several messages of a line counts once.
export function acceptDrafts(source: string): { source: string, accepted: number } {
  const comments = new Map(writtenMessages(source).flatMap(message => message.draft === undefined ? [] : [[message.draft.start!, message.draft] as const]))
  const drafts = [...comments.values()].toSorted((a, b) => b.start! - a.start!)
  let accepted = source

  for (const comment of drafts) {
    const before = accepted.slice(0, comment.start).trimEnd()

    accepted = before + accepted.slice(comment.end)
  }

  return { source: accepted, accepted: drafts.length }
}

// Writes `messages`, keyed as `t()` names them, into the file of a locale `i18n` translates from the default one, each marked `// draft` at its place in the nesting, the file created when it is missing; a key the file already has is left as written. Answers the keys written.
export async function writeDraftMessages(root: string, config: Pick<KayConfig, 'i18n'>, locale: string, messages: Record<string, Message>): Promise<string[]> {
  const { i18n } = config

  if (!i18n)
    throw new KayError('locales-invalid', 'kay: writeDraftMessages writes a locale\'s messages, and kay.config.ts sets no i18n')

  if (!i18n.locales.includes(locale) || locale === i18n.defaultLocale)
    throw new KayError('locales-invalid', `kay: writeDraftMessages was given the locale ${JSON.stringify(locale)}, which is not one of those translated from ${i18n.defaultLocale}: ${i18n.locales.filter(code => code !== i18n.defaultLocale).join(', ')}`)

  const file = messagesFile(root, i18n, locale)
  let source = existsSync(file) ? await Bun.file(file).text() : 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n'
  const style = styleOf(source)
  const written: string[] = []

  for (const [key, message] of Object.entries(messages)) {
    const next = withMessage(source, key.split('.'), message, style)

    if (next !== source)
      written.push(key)

    source = next
  }

  await Bun.write(file, source)

  return written
}

// How the file breaks and indents its lines, which the lines written follow.
interface Style {
  newline: string
  unit: string
}

function styleOf(source: string): Style {
  const indents = [...source.matchAll(INDENTED)].map(match => match[1]!)
  const spaces = indents.filter(indent => !indent.includes('\t')).map(indent => indent.length)

  return {
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    unit: indents.some(indent => indent.startsWith('\t')) ? '\t' : ' '.repeat(spaces.length === 0 ? 2 : Math.min(...spaces)),
  }
}

// The source with one message added under its key, or as it was when the key is there already, or a part of it is a message rather than a group.
function withMessage(source: string, parts: string[], message: Message, style: Style): string {
  let object: t.ObjectExpression | undefined = messagesObject(source)

  if (!object)
    throw new KayError('locales-invalid', 'kay: the messages file does not export its messages as `export default defineMessages({ ... })`')

  for (const [index, part] of parts.entries()) {
    const found: t.ObjectProperty | undefined = object.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyName(property) === part)

    if (!found)
      return inserted(source, object, entryText(parts.slice(index), message, style.unit), style)

    if (index === parts.length - 1 || found.value.type !== 'ObjectExpression' || isPluralObject(found.value))
      return source

    object = found.value
  }

  return source
}

// The source with `entry`, lines of text without their indent, added as the object's last property.
function inserted(source: string, object: t.ObjectExpression, entry: string[], { newline, unit }: Style): string {
  const outer = lineIndent(source, object.start!)
  const last = object.properties.at(-1)

  // A one-line object, `{}` or `{ home: 'Accueil' }`, opens on lines of its own so the comment ends one, what it held kept as written on the first.
  if (object.loc!.start.line === object.loc!.end.line) {
    const inner = `${outer}${unit}`
    const held = source.slice(object.start! + 1, object.end! - 1).trim()
    const comma = last && !followedByComma(source, last.end!, object.end! - 1) ? ',' : ''
    const kept = held === '' ? [] : [`${inner}${held}${comma}`]
    const added = entry.map(line => `${inner}${line}`)

    return `${source.slice(0, object.start!)}{${newline}${[...kept, ...added].join(newline)}${newline}${outer}}${source.slice(object.end!)}`
  }

  const inner = last ? lineIndent(source, last.start!) : `${outer}${unit}`
  const brace = object.end! - 1
  const lineStart = source.lastIndexOf('\n', brace - 1) + 1
  // The closing brace alone on its line takes the entry above it, one sharing a line with the last property after a line break.
  const alone = source.slice(lineStart, brace).trim() === ''
  const at = alone ? lineStart : brace
  const lines = entry.map(line => `${inner}${line}${newline}`).join('')
  const added = alone ? lines : `${newline}${lines}${outer}`
  const comma = last && !followedByComma(source, last.end!, brace) ? last.end! : undefined

  if (comma === undefined)
    return source.slice(0, at) + added + source.slice(at)

  return `${source.slice(0, comma)},${source.slice(comma, at)}${added}${source.slice(at)}`
}

// A message's lines under its key, each group opened for the parts left: `nav: {`, `  home: 'Accueil', // draft`, `},`.
function entryText(parts: string[], message: Message, unit: string): string[] {
  const [part, ...rest] = parts

  if (rest.length === 0)
    return [`${keyText(part!)}: ${messageText(message)}, // draft`]

  return [`${keyText(part!)}: {`, ...entryText(rest, message, unit).map(line => `${unit}${line}`), '},']
}

function messageText(message: Message): string {
  if (typeof message === 'string')
    return quoted(message)

  return `{ ${Object.entries(message).map(([form, text]) => `${form}: ${quoted(text)}`).join(', ')} }`
}

function quoted(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function keyText(key: string): string {
  return IDENTIFIER.test(key) ? key : quoted(key)
}

// Whether a comma comes after `from`, past spaces and comments, before `until`.
function followedByComma(source: string, from: number, until: number): boolean {
  const between = source.slice(from, until).replaceAll(COMMENTS, '')

  return between.trimStart().startsWith(',')
}

function lineIndent(source: string, offset: number): string {
  return INDENT.exec(source.slice(source.lastIndexOf('\n', offset - 1) + 1))![0]
}

// Every message the file's default export writes as a literal, with its `// draft` comment.
function writtenMessages(source: string): WrittenMessage[] {
  const ast = parsed(source)
  const object = ast && messagesObjectOf(ast)

  if (!object)
    return []

  const drafts = new Map((ast.comments ?? []).filter((comment): comment is t.CommentLine => comment.type === 'CommentLine' && DRAFT.test(comment.value)).map(comment => [comment.loc!.start.line, comment]))
  const found: WrittenMessage[] = []
  const walk = (node: t.ObjectExpression, prefix: string) => {
    for (const property of node.properties) {
      if (property.type !== 'ObjectProperty')
        continue

      const name = keyName(property)

      if (name === undefined)
        continue

      const key = `${prefix}${name}`
      const { value } = property

      if (value.type === 'ObjectExpression' && !isPluralObject(value)) {
        walk(value, `${key}.`)

        continue
      }

      if (value.type === 'StringLiteral' || value.type === 'TemplateLiteral' || value.type === 'ObjectExpression') {
        const line = property.loc!.start.line

        found.push({ key, line, draft: drafts.get(line) })
      }
    }
  }

  walk(object, '')

  return found
}

function messagesObject(source: string): t.ObjectExpression | undefined {
  const ast = parsed(source)

  return ast && messagesObjectOf(ast)
}

function parsed(source: string): t.File | undefined {
  try {
    return parse(source, { sourceType: 'module', plugins: ['typescript'] })
  }
  catch {
    return undefined
  }
}

// The object `export default defineMessages({ ... })` or `export default { ... }` gives, through `satisfies`, `as` and parentheses.
function messagesObjectOf(ast: t.File): t.ObjectExpression | undefined {
  const exported = ast.program.body.find((statement): statement is t.ExportDefaultDeclaration => statement.type === 'ExportDefaultDeclaration')
  let node: t.Node | undefined = exported?.declaration

  while (node && (node.type === 'TSSatisfiesExpression' || node.type === 'TSAsExpression' || node.type === 'ParenthesizedExpression'))
    node = node.expression

  if (node?.type === 'CallExpression')
    node = node.arguments[0]

  return node?.type === 'ObjectExpression' ? node : undefined
}

function keyName(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

// A plural's forms, `{ one: '...', other: '...' }`, read as one message as `isPlural` reads the value.
function isPluralObject(node: t.ObjectExpression): boolean {
  const keys = node.properties.map(property => property.type === 'ObjectProperty' ? keyName(property) : undefined)

  return keys.includes('other') && keys.every(key => key !== undefined && PLURAL_KEYS.has(key))
}
