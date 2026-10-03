import type { Subprocess } from 'bun'
import type { ShadowFile } from '../check'
import type { Diagnostic as KayDiagnostic } from '../compiler'
import type { CompletionItem, CompletionList, DidChangeTextDocumentParams, DocumentDiagnosticReport, DocumentHighlight, Hover, InitializeParams, Location, LocationLink, Position, Range, TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TextEdit, WorkspaceEdit } from './protocol'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileShadow, SHADOW_DIR, shadowPath, TSGO, writeShadowTypes } from '../check'
import { formatKay } from '../compiler/format'
import { offsetAt, positionAt } from '../compiler/mapping'
import { Connection } from './rpc'

// Where a file tsgo names is for the editor: its .kay source for a shadow file, the file itself outside the shadow tree.
interface Target {
  uri: string
  shadow?: ShadowFile
}

interface Document extends ShadowFile {
  uri: string
  shadowUri: string
  version: number
  diagnostics: KayDiagnostic[]
}

const KAY_FILE = /^file:.*\.kay$/
const WORD_CHARACTER = /[\w$]/
// Names generated code declares or imports, never written by the user.
const GENERATED_NAME = /^(?:__props|__default_\d+|kayEvent|Kay(?:For|Show|Omit|Island|Href|Field|Prop|PageContext|PageData|JSX|FormAction|RegisterActions|ActionStub|UseHead|Await))$/
const FULL_SYNC = 1
const ERROR = 1
const CHANGED = 2
const DIAGNOSTICS_DELAY = 150
// How far a question follows names through generated code.
const MAX_HOPS = 16

// Serves .kay files by compiling each to its shadow TSX, forwarding requests to tsgo's language server and mapping positions both ways.
export class KayLanguageServer {
  private root = ''
  private routesDir = ''
  private shadowTree = ''
  private rootUri = ''
  private tsgo?: { connection: Connection, process: Subprocess<'pipe', 'pipe', 'ignore'> }
  private readonly documents = new Map<string, Document>()
  private diagnosticsTimer?: Timer

  constructor(private readonly client: Connection) {
    client.onRequest<InitializeParams>('initialize', async params => this.initialize(params))
    client.onNotification('initialized', () => this.server.notify('initialized', {}))
    client.onNotification<{ textDocument: TextDocumentItem }>('textDocument/didOpen', ({ textDocument }) => this.open(textDocument))
    client.onNotification<DidChangeTextDocumentParams>('textDocument/didChange', params => this.change(params))
    client.onNotification<{ textDocument: TextDocumentIdentifier }>('textDocument/didClose', ({ textDocument }) => this.close(textDocument.uri))
    client.onNotification('textDocument/didSave', () => void guard(this.saved()))
    client.onRequest<TextDocumentPositionParams>('textDocument/hover', async params => this.hover(params))
    client.onRequest<TextDocumentPositionParams>('textDocument/completion', async params => this.completion(params))
    client.onRequest<CompletionItem>('completionItem/resolve', async item => this.resolveCompletion(item))
    client.onRequest<TextDocumentPositionParams>('textDocument/definition', async params => this.definition(params))
    client.onRequest<TextDocumentPositionParams & { context: unknown }>('textDocument/references', async params => this.references(params))
    client.onRequest<TextDocumentPositionParams>('textDocument/documentHighlight', async params => this.highlights(params))
    client.onRequest<TextDocumentPositionParams & { context?: unknown }>('textDocument/signatureHelp', async params => this.signatureHelp(params))
    client.onRequest<TextDocumentPositionParams>('textDocument/prepareRename', async params => this.prepareRename(params))
    client.onRequest<TextDocumentPositionParams & { newName: string }>('textDocument/rename', async params => this.rename(params))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/formatting', ({ textDocument }) => this.format(textDocument.uri))
    client.onRequest('shutdown', async () => this.server.request('shutdown'))
    client.onNotification('exit', () => this.exit())
  }

  get listening(): Promise<void> {
    return this.client.closed
  }

  private get server(): Connection {
    if (!this.tsgo)
      throw new Error('The server is not initialized')

    return this.tsgo.connection
  }

  private async initialize(params: InitializeParams) {
    const rootUri = params.rootUri ?? params.workspaceFolders?.[0]?.uri

    this.root = rootUri ? fileURLToPath(rootUri) : resolve(params.rootPath ?? process.cwd())
    this.routesDir = resolve(this.root, params.initializationOptions?.routes ?? 'src/routes')
    this.shadowTree = `${pathToFileURL(resolve(this.root, SHADOW_DIR)).href}/`
    this.rootUri = `${pathToFileURL(this.root).href}/`
    await writeShadowTypes(this.root, { routes: params.initializationOptions?.routes })

    const child = Bun.spawn([process.execPath, TSGO, '--lsp', '--stdio'], { cwd: this.root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    const connection = new Connection(child.stdout, (data) => {
      child.stdin.write(data)
      void child.stdin.flush()
    })

    this.tsgo = { connection, process: child }
    connection.onUnhandledRequest(() => null)
    connection.onRequest<{ items: unknown[] }>('workspace/configuration', ({ items }) => items.map(() => null))
    connection.onRequest('workspace/diagnostic/refresh', () => this.scheduleDiagnostics())

    const capabilities = { ...params.capabilities, textDocument: { ...params.capabilities.textDocument, diagnostic: { dynamicRegistration: false } } }
    const result = await connection.request<{ capabilities: { completionProvider?: { triggerCharacters?: string[] }, signatureHelpProvider?: unknown } }>('initialize', { ...params, rootUri: pathToFileURL(this.root).href, capabilities, initializationOptions: undefined })

    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: FULL_SYNC, save: { includeText: false } },
        hoverProvider: true,
        completionProvider: { triggerCharacters: result.capabilities.completionProvider?.triggerCharacters ?? ['.'], resolveProvider: true },
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        signatureHelpProvider: result.capabilities.signatureHelpProvider ?? { triggerCharacters: ['(', ','] },
        renameProvider: { prepareProvider: true },
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'kay' },
    }
  }

  private open(item: TextDocumentItem) {
    if (!KAY_FILE.test(item.uri))
      return

    const document = this.compile(item.uri, item.text, item.version)

    this.server.notify('textDocument/didOpen', { textDocument: { uri: document.shadowUri, languageId: 'typescriptreact', version: document.version, text: document.tsx } })
    this.scheduleDiagnostics()
  }

  private change({ textDocument, contentChanges }: DidChangeTextDocumentParams) {
    const previous = this.documents.get(textDocument.uri)

    if (!previous)
      return

    const text = contentChanges.reduce((source, change) => 'range' in change ? applyEdit(source, change.range, change.text) : change.text, previous.source)
    const document = this.compile(textDocument.uri, text, textDocument.version)

    this.server.notify('textDocument/didChange', { textDocument: { uri: document.shadowUri, version: document.version }, contentChanges: [{ text: document.tsx }] })
    this.scheduleDiagnostics()
  }

  private close(uri: string) {
    const document = this.documents.get(uri)

    if (!document)
      return

    this.documents.delete(uri)
    this.server.notify('textDocument/didClose', { textDocument: { uri: document.shadowUri } })
    this.client.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] })
  }

  // Rewrites the shadow tree on disk, so closed .kay files and the editor's own TypeScript server see the saved code.
  private async saved() {
    const { files } = await writeShadowTypes(this.root, { routes: this.routesDir })
    const changes = [...files.keys(), resolve(this.root, SHADOW_DIR, 'kay-env.d.ts')].map(path => ({ uri: pathToFileURL(path).href, type: CHANGED }))

    this.server.notify('workspace/didChangeWatchedFiles', { changes })
    this.scheduleDiagnostics()
  }

  private compile(uri: string, source: string, version: number): Document {
    const file = fileURLToPath(uri)
    const { shadow, diagnostics } = compileShadow(this.root, this.routesDir, file, source)
    const document = { ...shadow, uri, shadowUri: pathToFileURL(shadowPath(this.root, file)).href, version, diagnostics }

    this.documents.set(uri, document)

    return document
  }

  private scheduleDiagnostics() {
    clearTimeout(this.diagnosticsTimer)
    this.diagnosticsTimer = setTimeout(() => void guard(this.publishAllDiagnostics()), DIAGNOSTICS_DELAY)
  }

  // Every open file is checked again on any change, since editing one component can break the files using it.
  private async publishAllDiagnostics() {
    await Promise.all([...this.documents.values()].map(async document => this.publishDiagnostics(document)))
  }

  private async publishDiagnostics(document: Document) {
    // A compile error leaves the shadow TSX half-written, so its type errors would only be noise.
    const compileErrors = document.diagnostics.map(diagnostic => ({
      range: { start: toPosition(document.source, diagnostic.start), end: toPosition(document.source, Math.max(diagnostic.end, diagnostic.start + 1)) },
      severity: ERROR,
      source: 'kay',
      message: diagnostic.message,
    }))
    const report = compileErrors.length > 0 ? undefined : await this.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: document.shadowUri } })

    if (this.documents.get(document.uri) !== document)
      return

    // Related information points into the shadow TSX, a file the user never sees.
    const typeErrors = (report?.items ?? []).map(({ relatedInformation: _related, ...diagnostic }) => ({ ...diagnostic, range: toSourceRange(document, diagnostic.range, true) ?? zeroRange() }))

    this.client.notify('textDocument/publishDiagnostics', { uri: document.uri, version: document.version, diagnostics: [...compileErrors, ...typeErrors] })
  }

  private async hover(params: TextDocumentPositionParams): Promise<Hover | null> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const hover = await this.server.request<Hover | null>('textDocument/hover', target.params)

    if (!hover)
      return null

    return { contents: hover.contents, range: hover.range && toSourceRange(target.document, hover.range) }
  }

  private async completion(params: TextDocumentPositionParams & { context?: unknown }): Promise<CompletionList | null> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const result = await this.server.request<CompletionList | CompletionItem[] | null>('textDocument/completion', { ...target.params, context: params.context })

    if (!result)
      return null

    const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result
    const editRange = list.itemDefaults?.editRange
    const itemDefaults = list.itemDefaults && { ...list.itemDefaults, editRange: editRange && ('start' in editRange ? toSourceRange(target.document, editRange) : mapInsertReplace(target.document, editRange)) }

    return {
      ...list,
      itemDefaults,
      items: list.items.filter(item => !GENERATED_NAME.test(item.label)).map(item => ({ ...mapCompletionItem(target.document, item), data: { uri: target.document.uri, data: item.data } })),
    }
  }

  // Items carry the document they were listed for, since the editor may resolve one after another file asked for completions.
  private async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    const { uri, data } = item.data as { uri: string, data: unknown }
    const document = this.documents.get(uri)
    const resolved = await this.server.request<CompletionItem>('completionItem/resolve', { ...item, data })

    return { ...(document ? mapCompletionItem(document, resolved) : resolved), data: item.data }
  }

  private format(uri: string): TextEdit[] {
    const document = this.documents.get(uri)
    const formatted = document && formatKay(document.source)

    if (!document || !formatted || formatted.diagnostics.length > 0 || formatted.code === document.source)
      return []

    return [{ range: { start: { line: 0, character: 0 }, end: toPosition(document.source, document.source.length) }, newText: formatted.code }]
  }

  private async definition(params: TextDocumentPositionParams): Promise<LocationLink[] | null> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const result = await this.server.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', target.params)
    const locations = result === null ? [] : Array.isArray(result) ? result : [result]
    const links = await Promise.all(locations.map(async location => this.toSourceLink(target.document, location)))

    return links
  }

  private async references(params: TextDocumentPositionParams & { context: unknown }): Promise<Location[] | null> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const { found } = await this.across(target.params, async at => await this.server.request<Location[] | null>('textDocument/references', { ...at, context: params.context }) ?? [])

    return uniqueBy(found.map(({ file, range }) => ({ uri: file.uri, range })), location => `${location.uri} ${rangeKey(location.range)}`)
  }

  private async highlights(params: TextDocumentPositionParams): Promise<DocumentHighlight[] | null> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const { found } = await this.across(target.params, async (at) => {
      const highlights = await this.server.request<DocumentHighlight[] | null>('textDocument/documentHighlight', at) ?? []

      return highlights.map(highlight => ({ ...highlight, uri: at.textDocument.uri }))
    })

    return uniqueBy(found.map(({ spot, range }) => ({ range, kind: spot.kind })), highlight => rangeKey(highlight.range))
  }

  // Signatures carry no positions, so they pass through as they are.
  private async signatureHelp(params: TextDocumentPositionParams & { context?: unknown }): Promise<unknown> {
    const target = this.toShadow(params)

    return target ? this.server.request('textDocument/signatureHelp', { ...target.params, context: params.context }) : null
  }

  // A name only generated code holds cannot be renamed: the editor says so instead of renaming part of it.
  private async prepareRename(params: TextDocumentPositionParams): Promise<unknown> {
    const target = this.toShadow(params)

    if (!target)
      return null

    const result = await this.server.request<Range | { range: Range, placeholder: string } | { defaultBehavior: boolean } | null>('textDocument/prepareRename', target.params)

    if (!result || 'defaultBehavior' in result)
      return result

    const range = toSourceRange(target.document, 'range' in result ? result.range : result)

    if (!range)
      return null

    return 'range' in result ? { ...result, range } : range
  }

  // Only what the user wrote is edited; generated code follows by itself once the source changes.
  private async rename(params: TextDocumentPositionParams & { newName: string }): Promise<WorkspaceEdit | null> {
    const target = this.toShadow(params)

    // TypeScript refuses a name it cannot rename, such as a library's.
    if (!target || !await this.server.request<WorkspaceEdit | null>('textDocument/rename', { ...target.params, newName: params.newName }))
      return null

    // References follow a name through generated code where a rename stops, and editing each of them renames it whole, a server value's reads in the template included.
    const { found, complete } = await this.across(target.params, async at => await this.server.request<Location[] | null>('textDocument/references', { ...at, context: { includeDeclaration: true } }) ?? [])

    // A rename that stopped short would leave the code broken, so none is better.
    if (!complete)
      throw new Error('kay: this name runs through too much generated code to rename it safely')

    const byFile = new Map<string, Map<string, TextEdit>>()

    for (const { spot, file, range } of found) {
      // Generated code repeats some of the user's names, each mapped back to where it came from: an edit is kept only where the source holds the text it replaces.
      if (file.shadow ? textAt(file.shadow.source, range) !== textAt(file.shadow.tsx, spot.range) : !this.editable(file.uri))
        continue

      let edits = byFile.get(file.uri)

      if (!edits)
        byFile.set(file.uri, edits = new Map())

      edits.set(rangeKey(range), { range, newText: params.newName })
    }

    return { changes: Object.fromEntries([...byFile].map(([uri, edits]) => [uri, [...edits.values()]])) }
  }

  // Generated code joins names TypeScript sees apart, such as a server value and the template's reads of it through `__props`: wherever an answer lands in generated code, the question is asked again from there.
  // Not `complete` once it gave up following them, past `MAX_HOPS`.
  private async across<Spot extends { uri: string, range: Range }>(start: TextDocumentPositionParams, ask: (at: TextDocumentPositionParams) => Promise<Spot[]>): Promise<{ found: { spot: Spot, file: Target, range: Range }[], complete: boolean }> {
    const files = new Map<string, Promise<Target | undefined>>()
    const known = new Set<string>([positionKey(start.textDocument.uri, start.position)])
    const queue = [start]
    const found: { spot: Spot, file: Target, range: Range }[] = []
    let hops = 0
    const visit = (uri: string, position: Position) => {
      const key = positionKey(uri, position)

      if (known.has(key))
        return

      known.add(key)

      if (++hops <= MAX_HOPS)
        queue.push({ textDocument: { uri }, position })
    }

    for (let at = queue.pop(); at; at = queue.pop()) {
      for (const spot of await ask(at)) {
        let pending = files.get(spot.uri)

        if (!pending)
          files.set(spot.uri, pending = this.targetOf(spot.uri))

        const file = await pending

        if (!file)
          continue

        const range = file.shadow ? toSourceRange(file.shadow, spot.range) : spot.range

        if (!range) {
          visit(spot.uri, spot.range.start)

          continue
        }

        found.push({ spot, file, range })
        known.add(positionKey(spot.uri, spot.range.start))
        // Every other copy of the name in generated code is asked about too.
        for (const generated of file.shadow?.map.toGeneratedAll(toOffset(file.shadow.source, range.start)) ?? [])
          visit(spot.uri, toPosition(file.shadow!.tsx, generated))
      }
    }

    return { found, complete: hops <= MAX_HOPS }
  }

  // A file a rename may change besides .kay files: one of the project's own.
  private editable(uri: string): boolean {
    return uri.startsWith(this.rootUri) && !uri.includes('/node_modules/')
  }

  // Undefined for the declarations kay generates beside the shadow files.
  private async targetOf(uri: string): Promise<Target | undefined> {
    const shadow = await this.shadowOf(uri)

    if (shadow)
      return { uri: pathToFileURL(shadow.file).href, shadow }

    return uri.startsWith(this.shadowTree) ? undefined : { uri }
  }

  // Definitions inside another component land in its shadow TSX; this points them back at the .kay file.
  private async toSourceLink(origin: Document, location: Location | LocationLink): Promise<LocationLink> {
    const link = 'targetUri' in location ? location : { targetUri: location.uri, targetRange: location.range, targetSelectionRange: location.range }
    const shadow = await this.shadowOf(link.targetUri)
    const originSelectionRange = link.originSelectionRange && toSourceRange(origin, link.originSelectionRange)

    if (!shadow)
      return { ...link, originSelectionRange }

    return {
      originSelectionRange,
      targetUri: pathToFileURL(shadow.file).href,
      targetRange: toSourceRange(shadow, link.targetRange, true) ?? zeroRange(),
      targetSelectionRange: toSourceRange(shadow, link.targetSelectionRange, true) ?? zeroRange(),
    }
  }

  private async shadowOf(uri: string): Promise<ShadowFile | undefined> {
    const open = [...this.documents.values()].find(document => document.shadowUri === uri)

    if (open)
      return open

    const path = fileURLToPath(uri)
    const prefix = `${resolve(this.root, SHADOW_DIR)}/`

    if (!path.startsWith(prefix) || !path.endsWith('.kay.tsx'))
      return undefined

    const file = resolve(this.root, path.slice(prefix.length, -'.tsx'.length))
    const source = Bun.file(file)

    return await source.exists() ? compileShadow(this.root, this.routesDir, file, await source.text()).shadow : undefined
  }

  private toShadow(params: TextDocumentPositionParams): { document: Document, params: TextDocumentPositionParams } | undefined {
    const document = this.documents.get(params.textDocument.uri)
    const generated = document && document.map.toGenerated(toOffset(document.source, params.position))

    if (!document || generated === undefined)
      return undefined

    return { document, params: { textDocument: { uri: document.shadowUri }, position: toPosition(document.tsx, generated) } }
  }

  private exit() {
    this.tsgo?.process.kill()
    process.exit(0)
  }
}

// Runs until the editor closes the stream.
export async function startServer(input: ReadableStream<Uint8Array>, write: (data: string) => void): Promise<void> {
  await new KayLanguageServer(new Connection(input, write)).listening
}

// Background work reports its failure instead of ending the process with an unhandled rejection.
async function guard(task: Promise<void>): Promise<void> {
  try {
    await task
  }
  catch (error) {
    console.error('kay lsp:', error)
  }
}

function mapCompletionItem(document: ShadowFile, item: CompletionItem): CompletionItem {
  const { textEdit, additionalTextEdits, ...rest } = item
  const mapped: CompletionItem = { ...rest }

  if (textEdit) {
    const range = 'range' in textEdit ? toSourceRange(document, textEdit.range) : mapInsertReplace(document, textEdit)

    if (range)
      mapped.textEdit = 'start' in range ? { range, newText: textEdit.newText } : { ...range, newText: textEdit.newText }
    else
      mapped.insertText = textEdit.newText
  }

  // Auto-import edits target the generated imports; only those landing in the user's own code survive.
  const edits = (additionalTextEdits ?? []).flatMap((edit): TextEdit[] => {
    const range = toSourceRange(document, edit.range)

    return range ? [{ range, newText: edit.newText }] : []
  })

  if (edits.length > 0)
    mapped.additionalTextEdits = edits

  return mapped
}

function textAt(text: string, range: Range): string {
  return text.slice(toOffset(text, range.start), toOffset(text, range.end))
}

function positionKey(uri: string, { line, character }: Position): string {
  return `${uri} ${line}:${character}`
}

function rangeKey({ start, end }: Range): string {
  return `${start.line}:${start.character}-${end.line}:${end.character}`
}

function uniqueBy<Item>(items: Item[], key: (item: Item) => string): Item[] {
  const byKey = new Map<string, Item>()

  for (const item of items) {
    const found = key(item)

    if (!byKey.has(found))
      byKey.set(found, item)
  }

  return [...byKey.values()]
}

function mapInsertReplace(document: ShadowFile, edit: { insert: Range, replace: Range }): { insert: Range, replace: Range } | undefined {
  const insert = toSourceRange(document, edit.insert)
  const replace = toSourceRange(document, edit.replace)

  return insert && replace ? { insert, replace } : undefined
}

// A generated range back in the .kay source: exact when copied from it; with `loose`, glue maps to the construct it stands for.
function toSourceRange(document: ShadowFile, range: Range, loose = false): Range | undefined {
  const start = toOffset(document.tsx, range.start)
  const end = toOffset(document.tsx, range.end)

  if (!loose && (!document.map.isExact(start) || !document.map.isExact(end)))
    return undefined

  const sourceStart = document.map.toSource(start)

  if (sourceStart === undefined)
    return undefined

  const sourceEnd = document.map.isExact(end) ? document.map.toSource(end) : undefined

  return {
    start: toPosition(document.source, sourceStart),
    end: toPosition(document.source, sourceEnd !== undefined && sourceEnd >= sourceStart ? sourceEnd : wordEnd(document.source, sourceStart)),
  }
}

function wordEnd(source: string, offset: number): number {
  let end = offset

  while (end < source.length && WORD_CHARACTER.test(source[end]!))
    end++

  return end === offset ? Math.min(offset + 1, source.length) : end
}

function applyEdit(source: string, range: Range, text: string): string {
  return source.slice(0, toOffset(source, range.start)) + text + source.slice(toOffset(source, range.end))
}

function zeroRange(): Range {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
}

// LSP positions are 0-based, the mapping helpers 1-based; both count UTF-16 code units like JS strings.
function toOffset(text: string, position: Position): number {
  return Math.min(offsetAt(text, { line: position.line + 1, column: position.character + 1 }), text.length)
}

function toPosition(text: string, offset: number): Position {
  const { line, column } = positionAt(text, offset)

  return { line: line - 1, character: column - 1 }
}
