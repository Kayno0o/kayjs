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
  severity?: 1 | 2 | 3 | 4
  code?: number | string
  source?: string
  [key: string]: unknown
}

export interface DocumentDiagnosticReport {
  kind: 'full' | 'unchanged'
  items?: Diagnostic[]
}

export interface Hover {
  contents: unknown
  range?: Range
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
  insertText?: string
  textEdit?: TextEdit | InsertReplaceEdit
  additionalTextEdits?: TextEdit[]
  [key: string]: unknown
}

export interface CompletionList {
  isIncomplete: boolean
  items: CompletionItem[]
  itemDefaults?: { editRange?: Range | { insert: Range, replace: Range }, [key: string]: unknown }
}

export interface Location {
  uri: string
  range: Range
}

export interface LocationLink {
  originSelectionRange?: Range
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
}

export interface DocumentHighlight {
  range: Range
  kind?: number
}

export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>
}

export interface InitializeParams {
  rootUri?: string | null
  rootPath?: string | null
  workspaceFolders?: { uri: string, name: string }[] | null
  capabilities: Record<string, unknown> & { textDocument?: Record<string, unknown> }
  initializationOptions?: { routes?: string }
  [key: string]: unknown
}
