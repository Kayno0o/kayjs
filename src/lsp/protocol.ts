// The slice of the Language Server Protocol the .kay server reads or rewrites; everything else passes through untouched.

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface TextDocumentIdentifier {
  uri: string
}

export interface TextDocumentItem extends TextDocumentIdentifier {
  languageId: string
  version: number
  text: string
}

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier
  position: Position
}

export interface DidChangeTextDocumentParams {
  textDocument: TextDocumentIdentifier & { version: number }
  contentChanges: ({ text: string } | { range: Range, text: string })[]
}

export interface Diagnostic {
  range: Range
  message: string
  severity?: 1 | 2 | 3 | 4 | undefined
  code?: number | string | undefined
  source?: string | undefined
  [key: string]: unknown
}

export interface DocumentDiagnosticReport {
  kind: 'full' | 'unchanged'
  items?: Diagnostic[] | undefined
}

export interface Hover {
  contents: unknown
  range?: Range | undefined
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface InsertReplaceEdit {
  newText: string
  insert: Range
  replace: Range
}

export interface CompletionItem {
  label: string
  insertText?: string | undefined
  textEdit?: TextEdit | InsertReplaceEdit | undefined
  additionalTextEdits?: TextEdit[] | undefined
  [key: string]: unknown
}

export interface CompletionList {
  isIncomplete: boolean
  items: CompletionItem[]
  itemDefaults?: { editRange?: Range | { insert: Range, replace: Range } | undefined, [key: string]: unknown } | undefined
}

export interface Location {
  uri: string
  range: Range
}

export interface LocationLink {
  originSelectionRange?: Range | undefined
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
}

export interface DocumentHighlight {
  range: Range
  kind?: number | undefined
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]> | undefined
  documentChanges?: ({ textDocument: TextDocumentIdentifier, edits: TextEdit[] } | { kind: string })[] | undefined
}

export interface CodeActionParams {
  textDocument: TextDocumentIdentifier
  range: Range
  context: { diagnostics: Diagnostic[], only?: string[], [key: string]: unknown }
}

export interface CodeAction {
  title: string
  kind?: string | undefined
  diagnostics?: Diagnostic[] | undefined
  edit?: WorkspaceEdit | undefined
  command?: unknown
  [key: string]: unknown
}

// A file the editor saw created (1), changed (2) or deleted (3) on disk.
export interface FileEvent {
  uri: string
  type: 1 | 2 | 3
}

export interface InitializeParams {
  rootUri?: string | null | undefined
  rootPath?: string | null | undefined
  workspaceFolders?: { uri: string, name: string }[] | null | undefined
  capabilities: Record<string, unknown> & { textDocument?: Record<string, unknown> }
  initializationOptions?: { routes?: string } | undefined
  [key: string]: unknown
}
