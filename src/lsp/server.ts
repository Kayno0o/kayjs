import type { Subprocess } from 'bun'
import type { CheckOptions } from '../check'
import type { KayConfig } from '../config'
import type { Document, LspHost, Project } from './host'
import type { CodeActionParams, CodeLens, CompletionItem, Diagnostic, DidChangeTextDocumentParams, DocumentSymbol, FileEvent, FoldingRange, InitializeParams, Range, TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TextEdit } from './protocol'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KAY_DIR } from '../build/assets'
import { findKayFiles, inWalkScope, realPath } from '../build/files'
import { throughNodeModules } from '../build/libraries'
import { importedSignals } from '../build/signals'
import { configCheckOptions, stopProbes, writeShadowTypes } from '../check'
import { servedLocales } from '../check/diagnose'
import { withoutMissingCaptcha } from '../check/project'
import { compileShadow, layoutQueries, shadowOptionsFor } from '../check/shadow'
import { programShadows } from '../check/shadow-types'
import { formatKay } from '../compiler/format'
import { nativeExe } from '../compiler/native-typescript'
import { CONFIG_FILE } from '../config'
import { loadConfigWithin } from '../config-loader'
import { tailwindSorter } from '../format/tailwind'
import { projectPaths, projectRootOf } from '../project'
import { routeMounts } from '../server/routes'
import { codeActions } from './code-actions'
import { completion, resolveCompletion } from './completions'
import { DiagnosticsQueue } from './diagnostics'
import { links } from './document-links'
import { FIX_ALL, guard, QUICK_FIX, shadowSettingsOf } from './host'
import { islandLens } from './island-lens'
import { applyEdit, filePath, vscodeUri } from './mapping'
import { definition, highlights, hover, inlayHints, references, signatureHelp } from './navigation'
import { documentSymbols, foldingRanges } from './outline'
import { toOffset, toPosition } from './positions'
import { ProjectChecks } from './project-checks'
import { formatRange } from './range-format'
import { prepareRename, rename, renamedFiles } from './rename'
import { Connection } from './rpc'
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from './semantic-tokens'

export { DEPENDENTS_DELAY, DIAGNOSTICS_DELAY } from './diagnostics'

const LAYOUT_SHADOW_SUFFIX = '/_layout.kay.tsx'
const KAY_FILE = /^file:.*\.kay$/
// The one TypeScript file the server completes besides the components: where an app restyles them.
const UI_DOCUMENT = /^file:.*\/src\/ui\.ts$/
const SCRIPT_FILE = /\.(?:[cm]?ts|tsx)$/
const FULL_SYNC = 1
const CREATED = 1
const CHANGED = 2
const DELETED = 3
// What the editor reports changing on disk: components, the modules they import, the configs deciding how those resolve, and the collections' entries.
const WATCHED = '**/*.{kay,ts,tsx,js,jsx,json,md,yaml,yml}'

// How long the events of one save, the editor's save notice and its file watcher's, are waited for before the shadow tree is written once for them all; short of the diagnostics' delay.
const SAVE_EVENTS_DELAY = 25
// Completions offer names from modules not imported yet, as editors do for TypeScript by default; added imports are quoted the way kay's own code is, since generated code would mislead the guess.
// Types come from the project's own packages, so the server fetches none with npm, which would also run in a project with no npm of its own.
// Hints for what the author did not write: the type of a variable and of a return, and the name of a parameter given a literal.
const INLAY_HINTS = { variableTypes: { enabled: true, suppressWhenTypeMatchesName: true }, functionLikeReturnTypes: { enabled: true }, parameterNames: { enabled: 'literals', suppressWhenArgumentMatchesName: true } }
const TYPESCRIPT_SETTINGS = { suggest: { autoImports: true }, preferences: { quoteStyle: 'single' }, inlayHints: INLAY_HINTS, disableAutomaticTypeAcquisition: true }
const TYPESCRIPT_SECTIONS = new Set(['js/ts', 'typescript', 'javascript'])
// The modules of the kay running this server, which a config read again keeps rather than loading a second copy of.
const OWN_MODULES = `${resolve(import.meta.dir, '..')}${sep}`

// Serves .kay files by compiling each to its shadow TSX, forwarding requests to tsgo's language server and mapping positions both ways.
export class KayLanguageServer implements LspHost {
  root = ''
  private routesSetting: string | undefined
  nodeUris = false
  private watchesFiles = false
  readonly projects = new Map<string, Project>()
  private tsgo?: { connection: Connection, process: Subprocess<'pipe', 'pipe', 'ignore'> }
  readonly documents = new Map<string, Document>()
  // The open `src/ui.ts` documents by uri; TypeScript's server types them, kay adds the parts, variants and tokens.
  readonly uiFiles = new Map<string, string>()
  // Numbers the probe documents, so two asked at once never share one.
  private probeCount = 0
  private readonly diagnostics = new DiagnosticsQueue(this)
  private readonly checks = new ProjectChecks(this, this.diagnostics)
  // The save waiting for its other events to come, whether any of them changed a module, and the shadow tree's write in flight.
  private savePending: Promise<void> | undefined
  private saveModulesChanged = false
  private saveWriting: Promise<void> = Promise.resolve()

  constructor(readonly client: Connection) {
    client.onRequest<InitializeParams>('initialize', async params => this.initialize(params))
    client.onNotification('initialized', () => void guard(this.initialized()))
    client.onNotification<{ changes: FileEvent[] }>('workspace/didChangeWatchedFiles', ({ changes }) => void guard(this.filesChanged(changes)))
    client.onNotification<{ textDocument: TextDocumentItem }>('textDocument/didOpen', ({ textDocument }) => this.open(textDocument))
    client.onNotification<DidChangeTextDocumentParams>('textDocument/didChange', params => this.change(params))
    client.onNotification<{ textDocument: TextDocumentIdentifier }>('textDocument/didClose', ({ textDocument }) => this.close(textDocument.uri))
    client.onNotification('textDocument/didSave', () => void guard(this.saved()))
    client.onRequest<TextDocumentPositionParams>('textDocument/hover', async params => hover(this, params))
    client.onRequest<TextDocumentPositionParams>('textDocument/completion', async params => completion(this, params))
    client.onRequest<CompletionItem>('completionItem/resolve', async item => resolveCompletion(this, item))
    client.onRequest<TextDocumentPositionParams>('textDocument/definition', async params => definition(this, params))
    client.onRequest<TextDocumentPositionParams & { context: unknown }>('textDocument/references', async params => references(this, params))
    client.onRequest<TextDocumentPositionParams>('textDocument/documentHighlight', async params => highlights(this, params))
    client.onRequest<TextDocumentPositionParams & { context?: unknown }>('textDocument/signatureHelp', async params => signatureHelp(this, params))
    client.onRequest<TextDocumentPositionParams>('textDocument/prepareRename', async params => prepareRename(this, params))
    client.onRequest<TextDocumentPositionParams & { newName: string }>('textDocument/rename', async params => rename(this, params))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/formatting', async ({ textDocument }) => this.format(textDocument.uri))
    client.onRequest<{ textDocument: TextDocumentIdentifier, range: Range }>('textDocument/rangeFormatting', async params => this.formatSelection(params))
    client.onRequest<CodeActionParams>('textDocument/codeAction', async params => codeActions(this, params))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/documentSymbol', ({ textDocument }) => this.symbols(textDocument.uri))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/documentLink', async ({ textDocument }) => links(this, textDocument.uri))
    client.onRequest<{ textDocument: TextDocumentIdentifier, range: Range }>('textDocument/inlayHint', async params => inlayHints(this, params))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/semanticTokens/full', ({ textDocument }) => this.tokens(textDocument.uri))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/foldingRange', ({ textDocument }) => this.folds(textDocument.uri))
    client.onRequest<{ textDocument: TextDocumentIdentifier }>('textDocument/codeLens', ({ textDocument }) => this.lenses(textDocument.uri))
    client.onRequest<{ files: { oldUri: string, newUri: string }[] }>('workspace/willRenameFiles', async ({ files }) => inWalkScope(async () => renamedFiles(this, files)))
    client.onRequest('shutdown', async () => this.server.request('shutdown'))
    client.onNotification('exit', () => this.exit())
  }

  get problems(): Map<string, Diagnostic[]> {
    return this.checks.problems
  }

  nextProbe(): number {
    return ++this.probeCount
  }

  get listening(): Promise<void> {
    return this.client.closed
  }

  get server(): Connection {
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

    const child = Bun.spawn([nativeExe(), '--lsp', '--stdio'], { cwd: this.root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    const connection = new Connection(child.stdout, (data) => {
      void child.stdin.write(data)
      void child.stdin.flush()
    })

    this.tsgo = { connection, process: child }
    connection.onUnhandledRequest(() => null)
    connection.onRequest<{ items: { section?: string }[] }>('workspace/configuration', ({ items }) => items.map(item => TYPESCRIPT_SECTIONS.has(item.section ?? '') ? TYPESCRIPT_SETTINGS : null))
    connection.onRequest('workspace/diagnostic/refresh', () => this.diagnostics.scheduleDiagnostics())

    // tsgo asks this server for its settings, whatever the editor supports.
    const capabilities = { ...params.capabilities, workspace: { ...params.capabilities.workspace as object, configuration: true }, textDocument: { ...params.capabilities.textDocument, diagnostic: { dynamicRegistration: false }, inlayHint: { dynamicRegistration: false } } }
    const result = await connection.request<{ capabilities: { completionProvider?: { triggerCharacters?: string[] }, signatureHelpProvider?: unknown } }>('initialize', { ...params, rootUri: pathToFileURL(this.root).href, capabilities, initializationOptions: undefined })

    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: FULL_SYNC, save: { includeText: false } },
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['@', ...result.capabilities.completionProvider?.triggerCharacters ?? ['.']], resolveProvider: true },
        definitionProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        signatureHelpProvider: result.capabilities.signatureHelpProvider ?? { triggerCharacters: ['(', ','] },
        renameProvider: { prepareProvider: true },
        codeActionProvider: { codeActionKinds: [QUICK_FIX, FIX_ALL] },
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        documentSymbolProvider: true,
        foldingRangeProvider: true,
        semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }, full: true },
        inlayHintProvider: true,
        documentLinkProvider: {},
        codeLensProvider: {},
      },
      workspace: { fileOperations: { willRename: { filters: [{ pattern: { glob: '**/*.kay' } }, { pattern: { glob: '**', matches: 'folder' } }] } } },
      serverInfo: { name: 'kay' },
    }
  }

  // Asks the editor to report file changes on disk, when it can, so a component created, deleted or changed outside it reaches tsgo.
  private async initialized() {
    this.server.notify('initialized', {})

    if (this.watchesFiles)
      await this.client.request('client/registerCapability', { registrations: [{ id: 'kay-files', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: WATCHED }] } }] })

    this.checks.scheduleProjectChecks()
  }

  // A file changing on disk rewrites the shadow tree, which reads the config, guards, API modules and settings beside the .kay files; any file but a .kay one goes to tsgo as is. What kay writes under `.kay` is its own.
  private async filesChanged(changes: FileEvent[]) {
    const changed = changes.flatMap(change => change.uri.startsWith('file:') && !relative(this.root, fileURLToPath(change.uri)).split(sep).includes(KAY_DIR) ? [{ path: fileURLToPath(change.uri), type: change.type }] : [])
    const others = changed.filter(change => !change.path.endsWith('.kay')).map(change => ({ uri: pathToFileURL(change.path).href, type: change.type }))

    if (changed.length === 0)
      return

    if (others.length > 0)
      this.server.notify('workspace/didChangeWatchedFiles', { changes: others })

    // `kay.config.ts`, or a module it imported, changing makes every project read its config again.
    // A module that holds `createAuth` may turn the CAPTCHA off, which `missing-captcha` reads project-wide.
    const authChanged = await Promise.all(changed.filter(change => SCRIPT_FILE.test(change.path)).map(async change => change.type === DELETED || await createsAuth(change.path)))

    if (changed.some(change => basename(change.path) === CONFIG_FILE || realPath(change.path) in require.cache) || authChanged.includes(true)) {
      for (const project of this.projects.values())
        project.configured = false
    }

    await this.saved(others.length > 0)
  }

  private open(item: TextDocumentItem) {
    if (UI_DOCUMENT.test(item.uri))
      this.uiFiles.set(item.uri, item.text)

    if (!KAY_FILE.test(item.uri))
      return

    const document = this.compile(item.uri, item.text, item.version)

    this.server.notify('textDocument/didOpen', { textDocument: { uri: document.shadowUri, languageId: 'typescriptreact', version: document.version, text: document.tsx } })
    this.diagnostics.scheduleDiagnostics([document.uri])
  }

  private change({ textDocument, contentChanges }: DidChangeTextDocumentParams) {
    const ui = this.uiFiles.get(textDocument.uri)

    if (ui !== undefined) {
      this.uiFiles.set(textDocument.uri, contentChanges.reduce((source, change) => 'range' in change ? applyEdit(source, change.range, change.text) : change.text, ui))

      return
    }

    const previous = this.documents.get(textDocument.uri)

    if (!previous)
      return

    const text = contentChanges.reduce((source, change) => 'range' in change ? applyEdit(source, change.range, change.text) : change.text, previous.source)
    const document = this.compile(textDocument.uri, text, textDocument.version)

    this.server.notify('textDocument/didChange', { textDocument: { uri: document.shadowUri, version: document.version }, contentChanges: [{ text: document.tsx }] })
    this.diagnostics.scheduleDiagnostics([document.uri])
    this.diagnostics.scheduleDependents(document)
  }

  private close(uri: string) {
    this.uiFiles.delete(uri)

    const document = this.documents.get(uri)

    if (!document)
      return

    this.documents.delete(uri)
    this.server.notify('textDocument/didClose', { textDocument: { uri: document.shadowUri } })
    this.client.notify('textDocument/publishDiagnostics', { uri, diagnostics: this.problems.get(document.file) ?? [] })
  }

  // Rewrites the shadow tree on disk, so closed .kay files and the editor's own TypeScript server see the saved code; tsgo hears which shadow files came and went, so imports of them resolve again.
  // `modulesChanged` is true when a file other than a .kay file changed on disk, whose signals the open components may take on or lose.
  private async saved(modulesChanged = false) {
    this.saveModulesChanged ||= modulesChanged
    this.savePending ??= this.writeSaved()

    return this.savePending
  }

  // One write for the events one save makes, after the one before ended.
  private async writeSaved() {
    await Bun.sleep(SAVE_EVENTS_DELAY)

    const modulesChanged = this.saveModulesChanged
    const previous = this.saveWriting

    this.saveModulesChanged = false
    this.savePending = undefined
    this.saveWriting = (async () => {
      try {
        await previous
      }
      catch {
        // Its own caller heard of it.
      }

      await this.writeAfterSave(modulesChanged)
    })()

    return this.saveWriting
  }

  private async writeAfterSave(modulesChanged: boolean) {
    const options = new Map([...this.projects].map(([root, project]) => [root, project.options]))

    for (const project of this.projects.values())
      project.lookups = { interfaces: new Map(), typedProps: new Map() }

    const changes = await this.writeShadows()
    // The layouts are read from disk to tell their queries, so only a pass in which one came, changed or went reads them.
    const layoutsChanged = changes.some(({ uri }) => uri.endsWith(LAYOUT_SHADOW_SUFFIX))

    this.server.notify('workspace/didChangeWatchedFiles', { changes })
    // An open component that came to be rendered only by islands, or stopped being, whose project read its config again, or that takes as signals those a changed module now exports, or stops, or whose layouts above gain or drop a `query`, compiles again before the files are checked.
    for (const previous of this.documents.values()) {
      if (this.needsCompile(previous, options, modulesChanged, layoutsChanged))
        this.refresh(previous)
    }
    this.diagnostics.scheduleDiagnostics()
    this.checks.scheduleProjectChecks()
  }

  private needsCompile(previous: Document, options: Map<string, CheckOptions>, modulesChanged: boolean, layoutsChanged: boolean): boolean {
    const file = fileURLToPath(previous.uri)
    const project = this.projects.get(projectRootOf(file, this.root))

    return (project?.islandOnly.has(file) ?? false) !== previous.insideIsland
      || (project !== undefined && project.options !== options.get(project.root))
      || (modulesChanged && JSON.stringify(importedSignals(file, previous.source)) !== previous.signals)
      || (layoutsChanged && project !== undefined && JSON.stringify(layoutQueries(file, previous.source, project.routesDir, project.mounts)) !== previous.queries)
  }

  // Writes the shadow tree of every project holding a .kay file, and returns the shadow files that came, changed and went.
  private async writeShadows(): Promise<FileEvent[]> {
    return inWalkScope(async () => this.writeShadowTrees())
  }

  private async writeShadowTrees(): Promise<FileEvent[]> {
    const roots = new Set((await findKayFiles(this.root, { project: true })).map(file => projectRootOf(file, this.root)))
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
      // Hashing the text the lsp wrote is enough: `writeShadowTypes` rewrites a file whenever its text differs from disk, so what tsgo reads at the notification is the text stamped, whoever wrote there meanwhile.
      const stamps = new Map([...types.files].map(([path, shadow]) => [path, Bun.hash.wyhash(shadow.tsx)] as const))

      changes.push(
        ...[...files].flatMap((path): FileEvent[] => {
          const uri = pathToFileURL(path).href

          if (!project.shadowFiles.has(path))
            return [{ uri, type: CREATED }]

          return stamps.get(path) !== project.shadowStamps.get(path) ? [{ uri, type: CHANGED }] : []
        }),
        ...[...project.shadowFiles].filter(path => !files.has(path)).map((path): FileEvent => ({ uri: pathToFileURL(path).href, type: DELETED })),
        { uri: pathToFileURL(join(project.shadowTree, 'kay-env.d.ts')).href, type: CHANGED },
        // An extension's tsconfig is read again, as its options may have changed.
        ...types.programs.map((program): FileEvent => ({ uri: pathToFileURL(program.tsconfig).href, type: CHANGED })),
      )
      project.shadowFiles = files
      project.shadowStamps = stamps
      project.islandOnly = types.islandOnly
      project.unreached = types.unreached
      project.libraries = types.libraries
      project.types = types
    }))

    return changes
  }

  // The editor's setting wins over the project's `kay.config.ts`, as `pages()` options do; it names the workspace folder's pages, so only that project takes it.
  private async configure(project: Project) {
    const root = `${realPath(project.root)}${sep}`

    // Read again, the config imports the project's modules afresh rather than as first loaded.
    for (const path of Object.keys(require.cache)) {
      if (path.startsWith(root) && !path.startsWith(OWN_MODULES) && !path.split(sep).includes('node_modules'))
        delete require.cache[path]
    }

    const config = await projectConfig(project.root)

    project.options = await withoutMissingCaptcha(project.root, { ...configCheckOptions(config), routes: (project.root === this.root ? this.routesSetting : undefined) ?? config.routes })
    project.routesDir = projectPaths(project.root, project.options).routes
    project.mounts = routeMounts(project.root, project.options.extensions)
    project.locales = servedLocales(project.options.i18n)
    project.configured = true
    project.lookups = { interfaces: new Map(), typedProps: new Map() }
  }

  // A project first met here compiles with the defaults until the next save reads its config.
  projectAt(root: string): Project {
    let project = this.projects.get(root)

    if (!project)
      this.projects.set(root, project = { root, options: {}, routesDir: projectPaths(root).routes, mounts: [], locales: [], shadowTree: `${projectPaths(root).types}/`, shadowFiles: new Set(), shadowStamps: new Map(), islandOnly: new Set(), unreached: new Set(), libraries: [], probes: new Map(), configured: false, lookups: { interfaces: new Map(), typedProps: new Map() } })

    return project
  }

  shadowProject(path: string): Project | undefined {
    return [...this.projects.values()].find(project => path.startsWith(project.shadowTree))
  }

  // An open file compiled again from the same text, for what changed around it.
  private refresh(previous: Document) {
    const document = this.compile(previous.uri, previous.source, previous.version)

    this.server.notify('textDocument/didChange', { textDocument: { uri: document.shadowUri, version: document.version }, contentChanges: [{ text: document.tsx }] })
  }

  private compile(uri: string, source: string, version: number): Document {
    const file = fileURLToPath(uri)
    const project = this.projectAt(projectRootOf(file, this.root))
    const compiling = shadowOptionsFor(shadowSettingsOf(project), file)
    const { insideIsland } = compiling
    const signals = importedSignals(file, source)
    const placed = this.placed(project, file)
    const { shadow, diagnostics, queries } = compileShadow(project.root, placed.file, source, { ...compiling, signals, shadowOf: placed.shadowOf })
    const document = { ...shadow, uri, shadowUri: pathToFileURL(placed.shadowOf(placed.file)).href, version, diagnostics, insideIsland, signals: JSON.stringify(signals), queries: JSON.stringify(queries) }

    this.documents.set(uri, document)

    return document
  }

  // A page of an extension with options of its own is compiled as the app reaches it, by its `node_modules` link whichever path the editor opened it by, and shadowed beside its real path, where its tsconfig is.
  placed(project: Project, file: string): { file: string, shadowOf: (file: string) => string } {
    const programs = project.types?.programs ?? []
    const library = programs.map(program => program.library).find(held => held.dir !== held.realDir && file.startsWith(held.realDir + sep))

    return { file: library ? throughNodeModules(library, file) : file, shadowOf: programShadows(project.root, programs) }
  }

  private symbols(uri: string): DocumentSymbol[] {
    const document = this.documents.get(uri)

    return document ? documentSymbols(document.source) : []
  }

  private lenses(uri: string): CodeLens[] {
    const document = this.documents.get(uri)

    if (!document)
      return []

    const path = filePath(uri)
    const project = this.projectAt(projectRootOf(path, this.root))
    const route = path.startsWith(`${project.routesDir}${sep}`)

    return islandLens(document.source, path, { route, insideIsland: project.islandOnly.has(path), signals: importedSignals(path, document.source) })
  }

  // Signals, props and server values told apart from other names, whose tokens TypeScript does not know.
  private tokens(uri: string): { data: number[] } {
    const document = this.documents.get(uri)

    return { data: document ? semanticTokens(document.source, importedSignals(document.file, document.source)) : [] }
  }

  private folds(uri: string): FoldingRange[] {
    const document = this.documents.get(uri)

    return document ? foldingRanges(document.source) : []
  }

  private async format(uri: string): Promise<TextEdit[]> {
    const document = this.documents.get(uri)
    const formatted = document && formatKay(document.source, { sortClasses: await tailwindSorter(projectRootOf(document.file, this.root)) })

    if (!document || !formatted || formatted.diagnostics.length > 0 || formatted.code === document.source)
      return []

    return [{ range: { start: { line: 0, character: 0 }, end: toPosition(document.source, document.source.length) }, newText: formatted.code }]
  }

  // The top-level blocks of the template the range touches, formatted whole.
  private async formatSelection({ textDocument, range }: { textDocument: TextDocumentIdentifier, range: Range }): Promise<TextEdit[]> {
    const document = this.documents.get(textDocument.uri)

    if (!document)
      return []

    const edits = formatRange(document.source, { start: toOffset(document.source, range.start), end: toOffset(document.source, range.end) }, { sortClasses: await tailwindSorter(projectRootOf(document.file, this.root)) })

    return edits.map(edit => ({ range: { start: toPosition(document.source, edit.start), end: toPosition(document.source, edit.end) }, newText: edit.text }))
  }

  private exit() {
    this.tsgo?.process.kill()
    stopProbes()
    process.exit(0)
  }
}

// Whether a module on disk holds `createAuth`, one that cannot be read holding none.
async function createsAuth(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).text()).includes('createAuth')
  }
  catch {
    return false
  }
}

// A `kay.config.ts` that fails to load leaves the defaults rather than the editor without a language server.
async function projectConfig(root: string): Promise<KayConfig> {
  try {
    return await loadConfigWithin(root)
  }
  catch (error) {
    console.error('kay lsp: kay.config.ts failed to load', error)

    return {}
  }
}

// Runs until the editor closes the stream.
export async function startServer(input: ReadableStream<Uint8Array>, write: (data: string) => void): Promise<void> {
  await new KayLanguageServer(new Connection(input, write)).listening
}
