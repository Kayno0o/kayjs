import type { Subprocess } from 'bun'
import type { CheckOptions } from '../check'
import type { ShadowFile } from '../check/shadow'
import type { Diagnostic as KayDiagnostic } from '../compiler'
import type { Span } from '../compiler/ast'
import type { KayConfig } from '../config'
import type { CodeAction, CodeActionParams, CompletionItem, CompletionList, DidChangeTextDocumentParams, DocumentDiagnosticReport, DocumentHighlight, FileEvent, Hover, InitializeParams, Location, LocationLink, Position, Range, TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TextEdit, WorkspaceEdit } from './protocol'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findKayFiles, TSCONFIG } from '../build/files'
import { TSGO, UNUSED_CODES, writeShadowTypes } from '../check'
import { compileShadow, SHADOW_DIR, shadowPath } from '../check/shadow'
import { formatKay } from '../compiler/format'
import { lintLevels, typeLint } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { loadConfig } from '../config'
import { Connection } from './rpc'

// Where a file tsgo names is for the editor: its .kay source for a shadow file, the file itself outside the shadow tree.
interface Target {
  uri: string
  shadow?: ShadowFile
}

// A folder holding a tsconfig.json: its .kay files compile against its own routes and config, into its own shadow tree.
interface Project {
  root: string
  options: CheckOptions
  routesDir: string
  shadowTree: string
  shadowFiles: Set<string>
  // As of the last shadow write: the static components only islands render.
  islandOnly: Set<string>
  configured: boolean
}

interface Document extends ShadowFile {
  uri: string
  shadowUri: string
  version: number
  diagnostics: KayDiagnostic[]
  // Compiled as rendered inline with the islands that alone render it.
  insideIsland: boolean
}

const KAY_FILE = /^file:.*\.kay$/
const IMPORT_DECLARATION = /^\s*import\s/
const TRAILING_SEMICOLON = /;$/
// A one-line named import, as generated code writes them: its names, then its quoted module.
const NAMED_IMPORT = /^import \{([^}]*)\} from (['"][^'"]+['"])/
const RESERVED_CHARACTER = /[!'()*]/g
const WORD_CHARACTER = /[\w$]/
// Names generated code declares or imports, never written by the user.
const GENERATED_NAME = /^(?:__props|__default_\d+|kayEvent|Kay(?:LoopFor|StaticFor|Show|Omit|ComponentClass|Dynamic|TemplateHelpers|Island|IslandBrand|HydrateWhen|Href|Html|Field|Prop|FunctionProp|Children|IdentityKey|PageContext|PrerenderedContext|PageData|JSX|FormAction|RegisterActions|ActionStub|UseHead|Await))$/
const FULL_SYNC = 1
const ERROR = 1 as const
const WARNING = 2 as const
const UNNECESSARY = 1
const CREATED = 1
const CHANGED = 2
const DELETED = 3
// What the editor reports changing on disk: components, the modules they import, and the configs deciding how those resolve.
const WATCHED = '**/*.{kay,ts,tsx,js,jsx,json}'
const DIAGNOSTICS_DELAY = 150
const QUICK_FIX = 'quickfix'
const PACKAGE_TYPES = join(SHADOW_DIR, 'kay-packages.d.ts')
const DEFAULT_MEMBER = '.default'
// Completions offer names from modules not imported yet, as editors do for TypeScript by default; added imports are quoted the way kay's own code is, since generated code would mislead the guess.
const TYPESCRIPT_SETTINGS = { suggest: { autoImports: true }, preferences: { quoteStyle: 'single' } }
const TYPESCRIPT_SECTIONS = new Set(['js/ts', 'typescript', 'javascript'])
// How far a question follows names through generated code.
const MAX_HOPS = 16

// Serves .kay files by compiling each to its shadow TSX, forwarding requests to tsgo's language server and mapping positions both ways.
export class KayLanguageServer {
  private root = ''
  private routesSetting: string | undefined
  private nodeUris = false
  private watchesFiles = false
  private readonly projects = new Map<string, Project>()
  private tsgo?: { connection: Connection, process: Subprocess<'pipe', 'pipe', 'ignore'> }
  private readonly documents = new Map<string, Document>()
  private diagnosticsTimer?: Timer

  constructor(private readonly client: Connection) {
    client.onRequest<InitializeParams>('initialize', async params => this.initialize(params))
    client.onNotification('initialized', () => void guard(this.initialized()))
    client.onNotification<{ changes: FileEvent[] }>('workspace/didChangeWatchedFiles', ({ changes }) => void guard(this.filesChanged(changes)))
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
    client.onRequest<CodeActionParams>('textDocument/codeAction', async params => this.codeActions(params))
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

    this.root = rootUri !== undefined && rootUri !== '' ? resolve(fileURLToPath(rootUri)) : resolve(params.rootPath ?? process.cwd())
    this.routesSetting = params.initializationOptions?.routes
    // A client that writes URIs the way Node does keeps getting them that way, any other the way VS Code does.
    this.nodeUris = rootUri !== undefined && rootUri !== vscodeUri(this.root) && rootUri === pathToFileURL(this.root).href

    await this.writeShadows()
    this.watchesFiles = (params.capabilities.workspace as { didChangeWatchedFiles?: { dynamicRegistration?: boolean } } | undefined)?.didChangeWatchedFiles?.dynamicRegistration === true

    const child = Bun.spawn([process.execPath, TSGO, '--lsp', '--stdio'], { cwd: this.root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    const connection = new Connection(child.stdout, (data) => {
      void child.stdin.write(data)
      void child.stdin.flush()
    })

    this.tsgo = { connection, process: child }
    connection.onUnhandledRequest(() => null)
    connection.onRequest<{ items: { section?: string }[] }>('workspace/configuration', ({ items }) => items.map(item => TYPESCRIPT_SECTIONS.has(item.section ?? '') ? TYPESCRIPT_SETTINGS : null))
    connection.onRequest('workspace/diagnostic/refresh', () => this.scheduleDiagnostics())

    // tsgo asks this server for its settings, whatever the editor supports.
    const capabilities = { ...params.capabilities, workspace: { ...params.capabilities.workspace as object, configuration: true }, textDocument: { ...params.capabilities.textDocument, diagnostic: { dynamicRegistration: false } } }
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
        codeActionProvider: { codeActionKinds: [QUICK_FIX] },
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'kay' },
    }
  }

  // Asks the editor to report file changes on disk, when it can, so a component created, deleted or changed outside it reaches tsgo.
  private async initialized() {
    this.server.notify('initialized', {})

    if (this.watchesFiles)
      await this.client.request('client/registerCapability', { registrations: [{ id: 'kay-files', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: WATCHED }] } }] })
  }

  // A .kay file changing on disk rewrites the shadow tree; any other file goes to tsgo as is. The shadow tree is this server's own to report.
  private async filesChanged(changes: FileEvent[]) {
    const others = changes.flatMap(change => change.uri.startsWith('file:') && !KAY_FILE.test(change.uri) && !this.shadowProject(fileURLToPath(change.uri)) ? [{ uri: pathToFileURL(fileURLToPath(change.uri)).href, type: change.type }] : [])

    if (others.length > 0)
      this.server.notify('workspace/didChangeWatchedFiles', { changes: others })

    if (changes.some(change => KAY_FILE.test(change.uri)))
      await this.saved()
    else if (others.length > 0)
      this.scheduleDiagnostics()
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

  // Rewrites the shadow tree on disk, so closed .kay files and the editor's own TypeScript server see the saved code; tsgo hears which shadow files came and went, so imports of them resolve again.
  private async saved() {
    this.server.notify('workspace/didChangeWatchedFiles', { changes: await this.writeShadows() })
    // An open component that came to be rendered only by islands, or stopped being, compiles again as such.
    for (const previous of this.documents.values()) {
      const file = fileURLToPath(previous.uri)

      if ((this.projects.get(projectRoot(this.root, file))?.islandOnly.has(file) ?? false) !== previous.insideIsland) {
        const document = this.compile(previous.uri, previous.source, previous.version)

        this.server.notify('textDocument/didChange', { textDocument: { uri: document.shadowUri, version: document.version }, contentChanges: [{ text: document.tsx }] })
      }
    }
    this.scheduleDiagnostics()
  }

  // Writes the shadow tree of every project holding a .kay file, and returns the shadow files that came, changed and went.
  private async writeShadows(): Promise<FileEvent[]> {
    const roots = new Set((await findKayFiles(this.root, { project: true })).map(file => projectRoot(this.root, file)))
    const changes: FileEvent[] = []

    for (const [root, project] of this.projects) {
      if (!roots.has(root)) {
        changes.push(...[...project.shadowFiles].map((path): FileEvent => ({ uri: pathToFileURL(path).href, type: DELETED })))
        this.projects.delete(root)
      }
    }

    await Promise.all([...roots].map(async (root) => {
      const project = this.projectAt(root)

      if (!project.configured)
        await this.configure(project)

      const types = await writeShadowTypes(root, project.options)
      const files = new Set(types.files.keys())

      changes.push(
        ...[...files].map((path): FileEvent => ({ uri: pathToFileURL(path).href, type: project.shadowFiles.has(path) ? CHANGED : CREATED })),
        ...[...project.shadowFiles].filter(path => !files.has(path)).map((path): FileEvent => ({ uri: pathToFileURL(path).href, type: DELETED })),
        { uri: pathToFileURL(join(project.shadowTree, 'kay-env.d.ts')).href, type: CHANGED },
      )
      project.shadowFiles = files
      project.islandOnly = types.islandOnly
    }))

    return changes
  }

  // The editor's setting wins over the project's `kay.config.ts`, as `pages()` options do; it names the workspace folder's pages, so only that project takes it.
  private async configure(project: Project) {
    const config = await projectConfig(project.root)

    project.options = { routes: (project.root === this.root ? this.routesSetting : undefined) ?? config.routes, publicDir: config.publicDir, i18n: config.i18n, api: config.api, settings: config.settings, lints: config.lints }
    project.routesDir = resolve(project.root, project.options.routes ?? 'src/routes')
    project.configured = true
  }

  // A project first met here compiles with the defaults until the next save reads its config.
  private projectAt(root: string): Project {
    let project = this.projects.get(root)

    if (!project)
      this.projects.set(root, project = { root, options: {}, routesDir: resolve(root, 'src/routes'), shadowTree: `${resolve(root, SHADOW_DIR)}/`, shadowFiles: new Set(), islandOnly: new Set(), configured: false })

    return project
  }

  private shadowProject(path: string): Project | undefined {
    return [...this.projects.values()].find(project => path.startsWith(project.shadowTree))
  }

  private compile(uri: string, source: string, version: number): Document {
    const file = fileURLToPath(uri)
    const project = this.projectAt(projectRoot(this.root, file))
    const insideIsland = project.islandOnly.has(file)
    const { shadow, diagnostics } = compileShadow(project.root, project.routesDir, file, source, insideIsland, project.options.lints)
    const document = { ...shadow, uri, shadowUri: pathToFileURL(shadowPath(project.root, file)).href, version, diagnostics, insideIsland }

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
    // A compile error leaves the shadow TSX half-written, so its type errors would only be noise; one found by type checking only leaves it whole.
    const rangeOf = (span: Span) => ({ start: toPosition(document.source, span.start), end: toPosition(document.source, Math.max(span.end, span.start + 1)) })
    const compileErrors = document.diagnostics.map(diagnostic => ({
      range: rangeOf(diagnostic),
      severity: diagnostic.severity === 'warning' ? WARNING : ERROR,
      source: 'kay',
      ...diagnostic.code !== undefined && { code: diagnostic.code },
      message: [diagnostic.label !== undefined && diagnostic.label !== '' ? `${diagnostic.message} (${diagnostic.label})` : diagnostic.message, ...[['note', diagnostic.note], ['help', diagnostic.help]].flatMap(([kind, text]) => text === undefined ? [] : [`${kind}: ${text}`])].join('\n'),
      ...diagnostic.related && { relatedInformation: diagnostic.related.map(span => ({ location: { uri: document.uri, range: rangeOf(span) }, message: span.label })) },
      ...diagnostic.code === 'unread-name' && { tags: [UNNECESSARY] },
    }))
    const report = document.diagnostics.some(diagnostic => !diagnostic.checkOnly) ? undefined : await this.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: document.shadowUri } })

    if (this.documents.get(document.uri) !== document)
      return

    // Related information points into the shadow TSX, a file the user never sees. Unused code, a hint to TypeScript without `noUnusedLocals`, is the `unread-name` lint in a .kay file, as `kay check` reports it.
    const levelAt = lintLevels(document.source, this.projectAt(projectRoot(this.root, document.file)).options.lints)
    const typeErrors = (report?.items ?? []).flatMap(({ relatedInformation: _related, ...diagnostic }) => {
      const range = toSourceRange(document, diagnostic.range, true)
      const lint = typeLint(diagnostic.message)

      // A lint the types find, `identity-key` say, at its level as `kay check` reports it.
      if (lint) {
        const level = levelAt(lint.code, range ? toOffset(document.source, range.start) : 0)

        return level === 'allow' ? [] : [{ ...diagnostic, code: lint.code, message: `${lint.message}: ${lint.help}`, severity: level === 'warn' ? WARNING : ERROR, range: range ?? zeroRange() }]
      }

      if (!UNUSED_CODES.has(Number(diagnostic.code)))
        return [{ ...diagnostic, range: range ?? zeroRange() }]

      // A name kay generated is no unused code of the user's.
      const level = range && levelAt('unread-name', toOffset(document.source, range.start))

      return range && level !== 'allow' ? [{ ...diagnostic, code: 'unread-name', severity: level === 'warn' ? WARNING : ERROR, tags: [UNNECESSARY], range }] : []
    })

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
      items: list.items.filter(item => !GENERATED_NAME.test(item.label)).map(item => ({ ...mapCompletionItem(target.document, item, target.offset), data: { uri: target.document.uri, offset: target.offset, data: item.data } })),
    }
  }

  // Items carry the document they were listed for, since the editor may resolve one after another file asked for completions.
  private async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    const { uri, offset, data } = item.data as { uri: string, offset: number, data: unknown }
    const document = this.documents.get(uri)
    const resolved = await this.server.request<CompletionItem>('completionItem/resolve', { ...item, data })

    return { ...(document ? mapCompletionItem(document, resolved, offset) : resolved), data: item.data }
  }

  // Quick fixes whose every edit lands in what the user wrote, an added import moved into its fence: kay's own, then TypeScript's.
  private async codeActions(params: CodeActionParams): Promise<CodeAction[] | null> {
    const document = this.documents.get(params.textDocument.uri)
    const wanted = params.context.only?.includes(QUICK_FIX) ?? true

    if (!document || !wanted)
      return null

    const own = kayFixes(document, toOffset(document.source, params.range.start), toOffset(document.source, params.range.end))
    const range = toShadowRange(document, params.range)

    if (!range)
      return own.length > 0 ? own : null

    const diagnostics = params.context.diagnostics.flatMap((diagnostic) => {
      const mapped = diagnostic.source === 'kay' ? undefined : toShadowRange(document, diagnostic.range)

      return mapped ? [{ ...diagnostic, range: mapped }] : []
    })
    const actions = await this.server.request<CodeAction[] | null>('textDocument/codeAction', { textDocument: { uri: document.shadowUri }, range, context: { ...params.context, diagnostics, only: [QUICK_FIX] } })
    const offset = toOffset(document.source, params.range.start)

    return [...own, ...(actions ?? []).flatMap((action): CodeAction[] => {
      const changes = action.edit && action.command == null ? fileEdits(action.edit) : undefined
      const edits = changes?.length === 1 && changes[0]![0] === document.shadowUri ? sourceEdits(document, changes[0]![1], offset) : undefined

      return edits ? [{ title: action.title, kind: action.kind, isPreferred: action.isPreferred, edit: { changes: { [document.uri]: edits } } }] : []
    })]
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

    const links = await this.sourceLinks(target.document, await this.definitionsAt(target.params), new Set([positionKey(target.params.textDocument.uri, target.params.position)]))

    return uniqueBy(links, link => `${link.targetUri} ${rangeKey(link.targetSelectionRange)}`)
  }

  private async definitionsAt(at: TextDocumentPositionParams): Promise<(Location | LocationLink)[]> {
    const result = await this.server.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', at)

    return result === null ? [] : Array.isArray(result) ? result : [result]
  }

  // Definitions inside another component land in its shadow TSX; this points them back at the .kay file.
  // One that lands in generated glue, such as the `return { srv }` handing a server value to the template, is asked again from there, to reach the declaration it stands for.
  private async sourceLinks(origin: Document, locations: (Location | LocationLink)[], asked: Set<string>): Promise<LocationLink[]> {
    const links = await Promise.all(locations.map(async (location) => {
      const link = 'targetUri' in location ? location : { targetUri: location.uri, targetRange: location.range, targetSelectionRange: location.range }
      const shadow = await this.shadowOf(link.targetUri)
      const originSelectionRange = link.originSelectionRange && toSourceRange(origin, link.originSelectionRange)
      const declared = shadow ? undefined : await packageDeclaration(link.targetUri, link.targetSelectionRange.start.line)

      // A library component's declaration stands for its shadow file, which leads on to its `.kay` source.
      if (declared) {
        const key = positionKey(declared.textDocument.uri, declared.position)

        if (!asked.has(key) && asked.size <= MAX_HOPS) {
          asked.add(key)

          const followed = await this.sourceLinks(origin, await this.definitionsAt(declared), asked)

          if (followed.length > 0)
            return followed.map(found => ({ ...found, originSelectionRange }))
        }
      }

      if (!shadow)
        return [{ ...link, targetUri: this.clientUri(filePath(link.targetUri)), originSelectionRange }]

      const targetUri = this.clientUri(shadow.file)
      const selection = toSourceRange(shadow, link.targetSelectionRange)

      if (selection)
        return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, true) ?? selection, targetSelectionRange: selection }]

      const key = positionKey(link.targetUri, link.targetSelectionRange.start)

      if (!asked.has(key) && asked.size <= MAX_HOPS) {
        asked.add(key)

        const followed = await this.sourceLinks(origin, await this.definitionsAt({ textDocument: { uri: link.targetUri }, position: link.targetSelectionRange.start }), asked)

        if (followed.length > 0)
          return followed.map(found => ({ ...found, originSelectionRange }))
      }

      return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, true) ?? zeroRange(), targetSelectionRange: toSourceRange(shadow, link.targetSelectionRange, true) ?? zeroRange() }]
    }))

    return links.flat()
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
        byFile.set(file.uri, edits = new Map<string, TextEdit>())

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
    const path = filePath(uri)

    return path.startsWith(`${this.root}/`) && !path.includes('/node_modules/')
  }

  // The URI the editor knows a file by: the one of its open document, else written like the editor writes them.
  private clientUri(path: string): string {
    return [...this.documents.values()].find(document => document.file === path)?.uri ?? (this.nodeUris ? pathToFileURL(path).href : vscodeUri(path))
  }

  // Undefined for the declarations kay generates beside the shadow files.
  private async targetOf(uri: string): Promise<Target | undefined> {
    const shadow = await this.shadowOf(uri)

    if (shadow)
      return { uri: this.clientUri(shadow.file), shadow }

    return this.shadowProject(filePath(uri)) ? undefined : { uri: this.clientUri(filePath(uri)) }
  }

  private async shadowOf(uri: string): Promise<ShadowFile | undefined> {
    const path = filePath(uri)
    const open = [...this.documents.values()].find(document => filePath(document.shadowUri) === path)

    if (open)
      return open

    const project = this.shadowProject(path)

    if (!project || !path.endsWith('.kay.tsx'))
      return undefined

    const file = resolve(project.root, path.slice(project.shadowTree.length, -'.tsx'.length))
    const source = Bun.file(file)

    return await source.exists() ? compileShadow(project.root, project.routesDir, file, await source.text(), project.islandOnly.has(file)).shadow : undefined
  }

  // `offset` is the position in the .kay source.
  private toShadow(params: TextDocumentPositionParams): { document: Document, offset: number, params: TextDocumentPositionParams } | undefined {
    const document = this.documents.get(params.textDocument.uri)

    if (!document)
      return undefined

    const offset = toOffset(document.source, params.position)
    const generated = document.map.toGenerated(offset)

    if (generated === undefined)
      return undefined

    return { document, offset, params: { textDocument: { uri: document.shadowUri }, position: toPosition(document.tsx, generated) } }
  }

  private exit() {
    this.tsgo?.process.kill()
    process.exit(0)
  }
}

// A `kay.config.ts` that fails to load leaves the defaults rather than the editor without a language server.
async function projectConfig(root: string): Promise<KayConfig> {
  try {
    return await loadConfig(root)
  }
  catch (error) {
    console.error('kay lsp: kay.config.ts failed to load', error)

    return {}
  }
}

// The nearest folder above `file` holding a tsconfig.json, within the workspace; the workspace folder itself otherwise.
function projectRoot(workspace: string, file: string): string {
  for (let dir = dirname(file); dir.startsWith(`${workspace}/`); dir = dirname(dir)) {
    if (existsSync(join(dir, TSCONFIG)))
      return dir
  }

  return workspace
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

function mapCompletionItem(document: ShadowFile, item: CompletionItem, offset: number): CompletionItem {
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
function sourceEdits(document: ShadowFile, edits: TextEdit[], offset: number): TextEdit[] | undefined {
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
function mergedImport(tsx: string, edit: TextEdit): string | undefined {
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

// After the last import of the server fence for server code, of the component script otherwise; a file without a script gets one.
function importEdit(source: string, offset: number, declaration: string): TextEdit {
  const { script, server } = parseKay(source)
  const inServer = server !== undefined && offset >= server.start && offset <= server.end
  const fence = inServer ? server : script

  if (!fence)
    return { range: { start: toPosition(source, 0), end: toPosition(source, 0) }, newText: `---\n${declaration.replace(TRAILING_SEMICOLON, '')}\n---\n` }

  const hoisted = (inServer ? analyzeServer(source, fence)?.hoisted : analyzeScript(source, fence).hoisted) ?? []
  const last = hoisted.filter(span => source.startsWith('import', span.start)).at(-1)
  const position = toPosition(source, last ? last.end : fence.start)
  // tsgo reads the semicolon style off generated code; the fence's own imports, or kay's style without them, decide instead.
  const statement = last && source.slice(last.start, last.end).trimEnd().endsWith(';') ? declaration : declaration.replace(TRAILING_SEMICOLON, '')

  return { range: { start: position, end: position }, newText: last ? `\n${statement}` : `${statement}\n` }
}

// A source range in the shadow TSX, when both ends were copied there.
function toShadowRange(document: ShadowFile, range: Range): Range | undefined {
  const start = document.map.toGenerated(toOffset(document.source, range.start))
  const end = document.map.toGenerated(toOffset(document.source, range.end))

  return start === undefined || end === undefined ? undefined : { start: toPosition(document.tsx, start), end: toPosition(document.tsx, end) }
}

function fileEdits(edit: WorkspaceEdit): [string, TextEdit[]][] {
  return [...Object.entries(edit.changes ?? {}), ...(edit.documentChanges ?? []).flatMap(change => 'edits' in change ? [[change.textDocument.uri, change.edits] as [string, TextEdit[]]] : [])]
}

function textAt(text: string, range: Range): string {
  return text.slice(toOffset(text, range.start), toOffset(text, range.end))
}

function positionKey(uri: string, { line, character }: Position): string {
  return `${filePath(uri)} ${line}:${character}`
}

// Where the `.default` a line of `kay-packages.d.ts` reads sits, which tsgo takes on to the component's shadow file.
async function packageDeclaration(uri: string, line: number): Promise<TextDocumentPositionParams | undefined> {
  if (!filePath(uri).endsWith(PACKAGE_TYPES))
    return undefined

  const text = (await Bun.file(filePath(uri)).text()).split('\n')[line] ?? ''
  const at = text.lastIndexOf(DEFAULT_MEMBER)

  return at === -1 ? undefined : { textDocument: { uri }, position: { line, character: at + 1 } }
}

// URIs of one file differ by how they are percent-encoded, so files are compared by path.
function filePath(uri: string): string {
  return uri.startsWith('file:') ? fileURLToPath(uri) : uri
}

// Every character but the unreserved ones is percent-encoded, as VS Code writes a file URI.
function vscodeUri(path: string): string {
  return `file://${path.split('/').map(segment => encodeURIComponent(segment).replaceAll(RESERVED_CHARACTER, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`
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

// The fixes kay's own diagnostics carry, for those touching the range the editor asks about; two reads in one statement offer its fixes once.
function kayFixes(document: Document, start: number, end: number): CodeAction[] {
  const fixes = document.diagnostics.filter(diagnostic => diagnostic.start <= end && diagnostic.end >= start).flatMap(diagnostic => diagnostic.fixes ?? [])

  return uniqueBy(fixes, fix => JSON.stringify(fix)).map(fix => ({
    title: fix.title,
    kind: QUICK_FIX,
    edit: { changes: { [document.uri]: fix.edits.map(change => ({ range: { start: toPosition(document.source, change.start), end: toPosition(document.source, change.end) }, newText: change.text })) } },
  }))
}

// LSP positions are 0-based, the mapping helpers 1-based; both count UTF-16 code units like JS strings.
function toOffset(text: string, position: Position): number {
  return Math.min(offsetAt(text, { line: position.line + 1, column: position.character + 1 }), text.length)
}

function toPosition(text: string, offset: number): Position {
  const { line, column } = positionAt(text, offset)

  return { line: line - 1, character: column - 1 }
}
