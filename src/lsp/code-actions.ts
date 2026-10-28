import type { Span } from '../compiler/ast'
import type { Document, LspHost } from './host'
import type { CodeAction, CodeActionParams, TextEdit } from './protocol'
import { FIX_ALL, QUICK_FIX } from './host'
import { fileEdits, sourceEdits, toShadowRange, uniqueBy } from './mapping'
import { toOffset, toPosition } from './positions'

// Quick fixes whose every edit lands in what the user wrote, an added import moved into its fence: kay's own, then TypeScript's.
export async function codeActions(host: LspHost, params: CodeActionParams): Promise<CodeAction[] | null> {
  const document = host.documents.get(params.textDocument.uri)
  const only = params.context.only

  if (!document)
    return null

  const fixAll = only === undefined || only.some(kind => FIX_ALL.startsWith(kind)) ? safeFixes(document) : []
  const fixes = (only?.includes(QUICK_FIX) ?? true) ? await quickFixes(host, document, params) : null
  const actions = [...fixAll, ...fixes ?? []]

  return actions.length > 0 || fixes ? actions : null
}

export async function quickFixes(host: LspHost, document: Document, params: CodeActionParams): Promise<CodeAction[] | null> {
  const own = kayFixes(document, toOffset(document.source, params.range.start), toOffset(document.source, params.range.end))
  const range = toShadowRange(document, params.range)

  if (!range)
    return own.length > 0 ? own : null

  const diagnostics = params.context.diagnostics.flatMap((diagnostic) => {
    const mapped = diagnostic.source === 'kay' ? undefined : toShadowRange(document, diagnostic.range)

    return mapped ? [{ ...diagnostic, range: mapped }] : []
  })
  const actions = await host.server.request<CodeAction[] | null>('textDocument/codeAction', { textDocument: { uri: document.shadowUri }, range, context: { ...params.context, diagnostics, only: [QUICK_FIX] } })
  const offset = toOffset(document.source, params.range.start)

  return [...own, ...(actions ?? []).flatMap((action): CodeAction[] => {
    const changes = action.edit && action.command == null ? fileEdits(action.edit) : undefined
    const edits = changes?.length === 1 && changes[0]![0] === document.shadowUri ? sourceEdits(document, changes[0]![1], offset) : undefined

    return edits ? [{ title: action.title, kind: action.kind, isPreferred: action.isPreferred, edit: { changes: { [document.uri]: edits } } }] : []
  })]
}

// Every safe fix of the file at once, the first of each problem and none whose edits overlap another's: what `kay check --fix` would write, offered to run on save.
export function safeFixes(document: Document): CodeAction[] {
  const taken: Span[] = []
  const edits: TextEdit[] = []

  for (const fix of document.diagnostics.flatMap(diagnostic => diagnostic.fixes?.find(candidate => candidate.safe) ?? [])) {
    if (fix.edits.some(edit => taken.some(other => edit.start === other.start || (edit.start < other.end && other.start < edit.end))))
      continue

    taken.push(...fix.edits)
    edits.push(...fix.edits.map(edit => ({ range: { start: toPosition(document.source, edit.start), end: toPosition(document.source, edit.end) }, newText: edit.text })))
  }

  return edits.length > 0 ? [{ title: 'Fix all safe problems in this file', kind: FIX_ALL, edit: { changes: { [document.uri]: edits } } }] : []
}

// The fixes kay's own diagnostics carry, for those touching the range the editor asks about; two reads in one statement offer its fixes once.
export function kayFixes(document: Document, start: number, end: number): CodeAction[] {
  const fixes = document.diagnostics.filter(diagnostic => diagnostic.start <= end && diagnostic.end >= start).flatMap(diagnostic => diagnostic.fixes ?? [])

  return uniqueBy(fixes, fix => JSON.stringify(fix)).map(fix => ({
    title: fix.title,
    kind: QUICK_FIX,
    edit: { changes: { [document.uri]: fix.edits.map(change => ({ range: { start: toPosition(document.source, change.start), end: toPosition(document.source, change.end) }, newText: change.text })) } },
  }))
}
