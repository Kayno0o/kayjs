import type { ShadowFile, SpanMode } from '../check/shadow'
import type { CompletionItem, Position, Range, TextEdit, WorkspaceEdit } from './protocol'
import { fileURLToPath } from 'node:url'
import { generatedSpan, sourceSpan } from '../check/shadow'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { toOffset, toPosition } from './positions'

const IMPORT_DECLARATION = /^\s*import\s/
const TRAILING_SEMICOLON = /;$/
// A one-line named import, as generated code writes them: its names, then its quoted module.
const NAMED_IMPORT = /^import \{([^}]*)\} from (['"][^'"]+['"])/
const RESERVED_CHARACTER = /[!'()*]/g

export function mapCompletionItem(document: ShadowFile, item: CompletionItem, offset: number): CompletionItem {
  const { textEdit, additionalTextEdits, ...rest } = item
  const mapped: CompletionItem = { ...rest }

  if (textEdit) {
    const range = 'range' in textEdit ? toSourceRange(document, textEdit.range) : mapInsertReplace(document, textEdit)

    if (range)
      mapped.textEdit = 'start' in range ? { range, newText: textEdit.newText } : { ...range, newText: textEdit.newText }
    else
      mapped.insertText = textEdit.newText
  }

  const edits = additionalTextEdits && sourceEdits(document, additionalTextEdits, offset)

  if (edits && edits.length > 0)
    mapped.additionalTextEdits = edits

  return mapped
}

// tsgo's edits of a shadow file as edits of its source, all or none: what was copied maps back, and an added import goes to the fence the code at `offset` belongs to.
export function sourceEdits(document: ShadowFile, edits: TextEdit[], offset: number): TextEdit[] | undefined {
  const mapped: TextEdit[] = []

  for (const edit of edits) {
    const range = toSourceRange(document, edit.range)

    // A new import goes after the fence's own in its style, even when tsgo puts it among them, styled after generated code.
    if (range && !IMPORT_DECLARATION.test(edit.newText)) {
      mapped.push({ range, newText: edit.newText })
    }
    else {
      const declaration = IMPORT_DECLARATION.test(edit.newText) ? edit.newText.trim() : mergedImport(document.tsx, edit)

      if (declaration === undefined || declaration === '')
        return undefined

      mapped.push(importEdit(document.source, offset, declaration))
    }
  }

  return mapped
}

// tsgo adds a name to an import generated code already has, such as `kay/dom`'s: the names it adds become an import of their own.
export function mergedImport(tsx: string, edit: TextEdit): string | undefined {
  const line = tsx.split('\n')[edit.range.start.line] ?? ''
  const before = NAMED_IMPORT.exec(line)

  if (!before || edit.range.end.line !== edit.range.start.line)
    return undefined

  const after = NAMED_IMPORT.exec(line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character))
  const names = (match: RegExpExecArray) => match[1]!.split(',').map(name => name.trim()).filter(name => name !== '')
  const existing = new Set(names(before))
  const added = after && after[2] === before[2] ? names(after).filter(name => !existing.has(name)) : []

  return added.length > 0 ? `import { ${added.join(', ')} } from ${before[2]}` : undefined
}

// After the last import of the fence the offset is in, the component script by default; a file without a script gets one.
export function importEdit(source: string, offset: number, declaration: string): TextEdit {
  const { script, server, module } = parseKay(source)
  const inServer = server !== undefined && offset >= server.start && offset <= server.end
  const inModule = module !== undefined && offset >= module.start && offset <= module.end
  const component = inModule ? module : script
  const fence = inServer ? server : component

  if (!fence)
    return { range: { start: toPosition(source, 0), end: toPosition(source, 0) }, newText: `---\n${declaration.replace(TRAILING_SEMICOLON, '')}\n---\n` }

  const hoisted = (inServer ? analyzeServer(source, fence)?.hoisted : analyzeScript(source, script, [], [], module).hoisted.filter(span => span.start >= fence.start && span.end <= fence.end)) ?? []
  const last = hoisted.filter(span => source.startsWith('import', span.start)).at(-1)
  const position = toPosition(source, last ? last.end : fence.start)
  // tsgo reads the semicolon style off generated code; the fence's own imports, or kay's style without them, decide instead.
  const statement = last && source.slice(last.start, last.end).trimEnd().endsWith(';') ? declaration : declaration.replace(TRAILING_SEMICOLON, '')

  return { range: { start: position, end: position }, newText: last ? `\n${statement}` : `${statement}\n` }
}

// A source range in the shadow TSX, when both ends were copied there.
export function toShadowRange(document: ShadowFile, range: Range): Range | undefined {
  const span = generatedSpan(document, toOffset(document.source, range.start), toOffset(document.source, range.end))

  return span && { start: toPosition(document.tsx, span.start), end: toPosition(document.tsx, span.end) }
}

export function fileEdits(edit: WorkspaceEdit): [string, TextEdit[]][] {
  return [...Object.entries(edit.changes ?? {}), ...(edit.documentChanges ?? []).flatMap(change => 'edits' in change ? [[change.textDocument.uri, change.edits] as [string, TextEdit[]]] : [])]
}

export function textAt(text: string, range: Range): string {
  return text.slice(toOffset(text, range.start), toOffset(text, range.end))
}

export function positionKey(uri: string, { line, character }: Position): string {
  return `${filePath(uri)} ${line}:${character}`
}

// URIs of one file differ by how they are percent-encoded, so files are compared by path.
export function filePath(uri: string): string {
  return uri.startsWith('file:') ? fileURLToPath(uri) : uri
}

// Every character but the unreserved ones is percent-encoded, as VS Code writes a file URI.
export function vscodeUri(path: string): string {
  return `file://${path.split('/').map(segment => encodeURIComponent(segment).replaceAll(RESERVED_CHARACTER, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`
}

export function rangeKey({ start, end }: Range): string {
  return `${start.line}:${start.character}-${end.line}:${end.character}`
}

export function uniqueBy<Item>(items: Item[], key: (item: Item) => string): Item[] {
  const byKey = new Map<string, Item>()

  for (const item of items) {
    const found = key(item)

    if (!byKey.has(found))
      byKey.set(found, item)
  }

  return [...byKey.values()]
}

export function mapInsertReplace(document: ShadowFile, edit: { insert: Range, replace: Range }): { insert: Range, replace: Range } | undefined {
  const insert = toSourceRange(document, edit.insert)
  const replace = toSourceRange(document, edit.replace)

  return insert && replace ? { insert, replace } : undefined
}

// A generated range back in the .kay source.
export function toSourceRange(document: ShadowFile, range: Range, mode: SpanMode = 'exact'): Range | undefined {
  const span = sourceSpan(document, toOffset(document.tsx, range.start), toOffset(document.tsx, range.end), mode)

  return span && { start: toPosition(document.source, span.start), end: toPosition(document.source, span.end) }
}

export function applyEdit(source: string, range: Range, text: string): string {
  return source.slice(0, toOffset(source, range.start)) + text + source.slice(toOffset(source, range.end))
}

export function zeroRange(): Range {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
}
