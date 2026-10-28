import type { Span } from '../compiler/ast'
import type { LspHost, Target } from './host'
import type { Location, Range, TextDocumentPositionParams, TextEdit, WorkspaceEdit } from './protocol'
import { findKayFiles, findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { clientUri, editable, toShadow } from './bridge'
import { filePath, rangeKey, textAt, toSourceRange } from './mapping'
import { across } from './navigation'
import { toOffset, toPosition } from './positions'
import { importEdits, moduleImportEdits } from './renames'

const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/

// A name only generated code holds cannot be renamed: the editor says so instead of renaming part of it.
export async function prepareRename(host: LspHost, params: TextDocumentPositionParams): Promise<unknown> {
  const target = toShadow(host, params)

  if (!target)
    return null

  const result = await host.server.request<Range | { range: Range, placeholder: string } | { defaultBehavior: boolean } | null>('textDocument/prepareRename', target.params)

  if (!result || 'defaultBehavior' in result)
    return result

  const range = toSourceRange(target.document, 'range' in result ? result.range : result)

  if (!range)
    return null

  return 'range' in result ? { ...result, range } : range
}

// Only what the user wrote is edited; generated code follows by itself once the source changes.
export async function rename(host: LspHost, params: TextDocumentPositionParams & { newName: string }): Promise<WorkspaceEdit | null> {
  const target = toShadow(host, params)

  // TypeScript refuses a name it cannot rename, such as a library's.
  if (!target || !await host.server.request<WorkspaceEdit | null>('textDocument/rename', { ...target.params, newName: params.newName }))
    return null

  // References follow a name through generated code where a rename stops, and editing each of them renames it whole, a server value's reads in the template included.
  const { found, complete } = await across(host, target.params, async at => await host.server.request<Location[] | null>('textDocument/references', { ...at, context: { includeDeclaration: true } }) ?? [])

  // A rename that stopped short would leave the code broken, so none is better.
  if (!complete)
    throw new Error('kay: this name runs through too much generated code to rename it safely')

  const byFile = new Map<string, Map<string, TextEdit>>()
  const bare = new Map<string, Map<string, Span>>()

  for (const { spot, file, range } of found) {
    // Generated code repeats some of the user's names, each mapped back to where it came from: an edit is kept only where the source holds the text it replaces.
    if (file.shadow ? textAt(file.shadow.source, range) !== textAt(file.shadow.tsx, spot.range) : !editable(host, file.uri))
      continue

    let edits = byFile.get(file.uri)

    if (!edits)
      byFile.set(file.uri, edits = new Map<string, TextEdit>())

    edits.set(rangeKey(range), renamed(file, range, params.newName, bare))
  }

  return { changes: Object.fromEntries([...byFile].map(([uri, edits]) => [uri, [...edits.values()]])) }
}

// The name a bare `{title}` attribute shares with its value is the variable's, so a rename keeps the attribute's own name: `title={heading}`.
export function renamed(file: Target, range: Range, newName: string, bare: Map<string, Map<string, Span>>): TextEdit {
  if (!file.shadow)
    return { range, newText: newName }

  const { source } = file.shadow
  let shorthands = bare.get(file.uri)

  if (!shorthands) {
    bare.set(file.uri, shorthands = new Map<string, Span>())

    for (const element of elementsIn(parseKay(source).template)) {
      for (const attribute of element.attributes) {
        if (attribute.kind === 'expression' && attribute.shorthand)
          shorthands.set(`${attribute.name.start}-${attribute.name.end}`, attribute.shorthand)
      }
    }
  }

  const start = toOffset(source, range.start)
  const end = toOffset(source, range.end)
  const shorthand = shorthands.get(`${start}-${end}`)

  if (shorthand)
    return { range: { start: toPosition(source, shorthand.start), end: toPosition(source, shorthand.end) }, newText: `${source.slice(start, end)}={${newName}}` }

  return { range, newText: newName }
}

// Renaming or moving a `.kay` file, or a folder holding some, rewrites the relative imports of the `.kay` files and TypeScript modules importing it, and those of the files that move.
export async function renamedFiles(host: LspHost, files: { oldUri: string, newUri: string }[]): Promise<WorkspaceEdit | null> {
  const moves = new Map(files.filter(file => file.oldUri.startsWith('file:') && file.newUri.startsWith('file:')).map(file => [filePath(file.oldUri), filePath(file.newUri)]))
  const changes: Record<string, TextEdit[]> = {}

  const modules = (await findProjectFiles(host.root, MODULE_FILE)).filter(file => !file.endsWith('.d.ts'))

  for (const file of [...await findKayFiles(host.root), ...modules]) {
    const open = [...host.documents.values()].find(document => document.file === file)
    const source = open?.source ?? await Bun.file(file).text()
    const edits = file.endsWith('.kay') ? importEdits(file, source, moves) : moduleImportEdits(file, source, moves)

    if (edits.length > 0)
      changes[open?.uri ?? clientUri(host, file)] = edits.map(edit => ({ range: { start: toPosition(source, edit.start), end: toPosition(source, edit.end) }, newText: edit.text }))
  }

  return Object.keys(changes).length > 0 ? { changes } : null
}
