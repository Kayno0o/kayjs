import type { Subprocess } from 'bun'
import type { KayLibrary } from '../build/libraries'
import type { CheckDiagnostic, CheckOptions, ProbeMemory, ShadowTypes } from '../check'
import type { ShadowFile, SpanMode } from '../check/shadow'
import type { Diagnostic as KayDiagnostic } from '../compiler'
import type { Span } from '../compiler/ast'
import type { KayConfig } from '../config'
import type { RouteMount } from '../server/routes'
import type { CodeAction, CodeActionParams, CompletionItem, CompletionList, Diagnostic, DidChangeTextDocumentParams, DocumentDiagnosticReport, DocumentHighlight, FileEvent, Hover, InitializeParams, Location, LocationLink, Position, Range, TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TextEdit, WorkspaceEdit } from './protocol'
import { existsSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KAY_DIR } from '../build/assets'
import { findKayFiles, realPath } from '../build/files'
import { importedSignals } from '../build/signals'
import { configCheckOptions, configProblems, contentChecks, generatedChecks, generatedProblem, projectProblems, stopProbes, TSGO, writeShadowTypes } from '../check'
import { diagnoseShadow, reportsTypeErrors, servedByTheApp, servedLocales } from '../check/diagnose'
import { compileShadow, generatedSpan, layoutQueries, shadowPath, shadowSource, sourceSpan } from '../check/shadow'
import { formatKay } from '../compiler/format'
import { lintLevels } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { GENERATED_NAME } from '../compiler/names'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { CONFIG_FILE, loadConfig } from '../config'
import { projectPaths, projectRootOf, SHADOW_DIR } from '../project'
import { routeMounts } from '../server/routes'
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
  // The routes its extensions mount, and their directories, which every compile reads.
  mounts: RouteMount[]
  // The prefixes its locales serve pages under.
  locales: string[]
  shadowTree: string
  shadowFiles: Set<string>
  // The content hash of each, as the last write left it: a time stamp cannot tell two writes within one millisecond apart.
  shadowStamps: Map<string, bigint>
  // As of the last shadow write: the static components only islands render, the library components the app never imports, whose errors are the library's, and the libraries.
  islandOnly: Set<string>
  unreached: Set<string>
  libraries: KayLibrary[]
  // What the checking scripts found last, run again only for a change in what they read.
  probes: ProbeMemory
  // The last shadow write, which the project-wide checks read.
  types?: ShadowTypes
  configured: boolean
}

interface Document extends ShadowFile {
  uri: string
  shadowUri: string
  version: number
  diagnostics: KayDiagnostic[]
  // Compiled as rendered inline with the islands that alone render it.
  insideIsland: boolean
  // The signals of the modules it imports, as compiled with: a module changing them compiles the file again.
  signals: string
  // The `query` types of the layouts above it, as compiled with: a layout gaining or dropping one compiles the file again.
  queries: string
}

const LAYOUT_SHADOW_SUFFIX = '/_layout.kay.tsx'
const KAY_FILE = /^file:.*\.kay$/
const IMPORT_DECLARATION = /^\s*import\s/
const TRAILING_SEMICOLON = /;$/
// A one-line named import, as generated code writes them: its names, then its quoted module.
const NAMED_IMPORT = /^import \{([^}]*)\} from (['"][^'"]+['"])/
const RESERVED_CHARACTER = /[!'()*]/g
const FULL_SYNC = 1
const ERROR = 1 as const
const WARNING = 2 as const
const UNNECESSARY = 1
const CREATED = 1
const CHANGED = 2
const DELETED = 3
// What the editor reports changing on disk: components, the modules they import, the configs deciding how those resolve, and the collections' entries.
const WATCHED = '**/*.{kay,ts,tsx,js,jsx,json,md,yaml,yml}'

// How long a change waits for the next before the files are checked again, as typing makes many; the first after a quiet spell is checked at once.
export const DIAGNOSTICS_DELAY = 150
// How long the project-wide checks wait after a save for the next, as saving every file at once makes.
const PROJECT_CHECKS_DELAY = 300
// How long the events of one save, the editor's save notice and its file watcher's, are waited for before the shadow tree is written once for them all; short of the diagnostics' delay.
const SAVE_EVENTS_DELAY = 25
const QUICK_FIX = 'quickfix'
const PACKAGE_TYPES = join(SHADOW_DIR, 'kay-packages.d.ts')
const DEFAULT_MEMBER = '.default'
// Completions offer names from modules not imported yet, as editors do for TypeScript by default; added imports are quoted the way kay's own code is, since generated code would mislead the guess.
const TYPESCRIPT_SETTINGS = { suggest: { autoImports: true }, preferences: { quoteStyle: 'single' } }
const TYPESCRIPT_SECTIONS = new Set(['js/ts', 'typescript', 'javascript'])
// How far a question follows names through generated code.
const MAX_HOPS = 16
// The modules of the kay running this server, which a config read again keeps rather than loading a second copy of.
const OWN_MODULES = `${resolve(import.meta.dir, '..')}${sep}`

// Serves .kay files by compiling each to its shadow TSX, forwarding requests to tsgo's language server and mapping positions both ways.
export class KayLanguageServer {
  private root = ''
  private routesSetting: string | undefined
  private nodeUris = false
  private watchesFiles = false
  private readonly projects = new Map<string, Project>()
  private tsgo?: { connection: Connection, process: Subprocess<'pipe', 'pipe', 'ignore'> }
  private readonly documents = new Map<string, Document>()
  // The quiet spell since the last change, and whether another came during it, which publishes again once it ends.
  private diagnosticsTimer: Timer | undefined
  private diagnosticsDue = false
  // Whether every open file is being published, and whether another publish was asked for during it, which runs once it ends.
  private publishing = false
  private publishAgain = false
  private projectChecksTimer?: Timer
  // The run of the project-wide checks in flight, and whether a save came during it.
  private projectChecks: Promise<void> | undefined
  private projectChecksStale = false
  // The save waiting for its other events to come, whether any of them changed a module, and the shadow tree's write in flight.
  private savePending: Promise<void> | undefined
  private saveModulesChanged = false
  private saveWriting: Promise<void> = Promise.resolve()
  // What the project-wide checks found, by file.
  private problems = new Map<string, Diagnostic[]>()

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

    this.scheduleProjectChecks()
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
    if (changed.some(change => basename(change.path) === CONFIG_FILE || realPath(change.path) in require.cache)) {
      for (const project of this.projects.values())
        project.configured = false
    }

    await this.saved(others.length > 0)
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

    const changes = await this.writeShadows()
    // The layouts are read from disk to tell their queries, so only a pass in which one came, changed or went reads them.
    const layoutsChanged = changes.some(({ uri }) => uri.endsWith(LAYOUT_SHADOW_SUFFIX))

    this.server.notify('workspace/didChangeWatchedFiles', { changes })
    // An open component that came to be rendered only by islands, or stopped being, whose project read its config again, or that takes as signals those a changed module now exports, or stops, or whose layouts above gain or drop a `query`, compiles again before the files are checked.
    for (const previous of this.documents.values()) {
      if (this.needsCompile(previous, options, modulesChanged, layoutsChanged))
        this.refresh(previous)
    }
    this.scheduleDiagnostics()
    this.scheduleProjectChecks()
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

    project.options = { ...configCheckOptions(config), routes: (project.root === this.root ? this.routesSetting : undefined) ?? config.routes }
    project.routesDir = projectPaths(project.root, project.options).routes
    project.mounts = routeMounts(project.root, project.options.extensions)
    project.locales = servedLocales(project.options.i18n)
    project.configured = true
  }

  // A project first met here compiles with the defaults until the next save reads its config.
  private projectAt(root: string): Project {
    let project = this.projects.get(root)

    if (!project)
      this.projects.set(root, project = { root, options: {}, routesDir: projectPaths(root).routes, mounts: [], locales: [], shadowTree: `${projectPaths(root).types}/`, shadowFiles: new Set(), shadowStamps: new Map(), islandOnly: new Set(), unreached: new Set(), libraries: [], probes: new Map(), configured: false })

    return project
  }

  private shadowProject(path: string): Project | undefined {
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
    const insideIsland = project.islandOnly.has(file)
    const signals = importedSignals(file, source)
    const { shadow, diagnostics, queries } = compileShadow(project.root, file, source, { routesDir: project.routesDir, mounts: project.mounts, insideIsland, lints: project.options.lints, signals })
    const document = { ...shadow, uri, shadowUri: pathToFileURL(shadowPath(project.root, file)).href, version, diagnostics, insideIsland, signals: JSON.stringify(signals), queries: JSON.stringify(queries) }

    this.documents.set(uri, document)

    return document
  }

  private scheduleDiagnostics() {
    if (this.diagnosticsTimer === undefined)
      void guard(this.publishAllDiagnostics())
    else
      this.diagnosticsDue = true

    clearTimeout(this.diagnosticsTimer)
    this.diagnosticsTimer = setTimeout(() => {
      this.diagnosticsTimer = undefined

      if (this.diagnosticsDue) {
        this.diagnosticsDue = false
        void guard(this.publishAllDiagnostics())
      }
    }, DIAGNOSTICS_DELAY)
  }

  // What `kay check` finds across the project, run after a save rather than on every keystroke, since it reads every collection, catalog and route.
  private scheduleProjectChecks() {
    clearTimeout(this.projectChecksTimer)
    this.projectChecksTimer = setTimeout(() => void guard(this.runProjectChecks()), PROJECT_CHECKS_DELAY)
  }

  private async runProjectChecks() {
    if (this.projectChecks) {
      this.projectChecksStale = true

      return
    }

    try {
      this.projectChecks = this.publishProblems()
      await this.projectChecks
    }
    finally {
      this.projectChecks = undefined

      // A save during a run, even a failed one, runs the checks again.
      if (this.projectChecksStale) {
        this.projectChecksStale = false
        this.scheduleProjectChecks()
      }
    }
  }

  // Each file whose problems changed, an open component's along with its own diagnostics, and none any longer for a file that had some.
  private async publishProblems() {
    const found = new Map<string, Diagnostic[]>()

    for (const problem of (await Promise.all([...this.projects.values()].map(async project => this.problemsOf(project)))).flat())
      found.set(problem.file, [...found.get(problem.file) ?? [], problemDiagnostic(problem)])

    const previous = this.problems

    this.problems = found

    let openChanged = false

    for (const file of new Set([...previous.keys(), ...found.keys()])) {
      if (Bun.deepEquals(previous.get(file), found.get(file)))
        continue

      if ([...this.documents.values()].some(open => open.file === file))
        openChanged = true
      else
        this.client.notify('textDocument/publishDiagnostics', { uri: this.clientUri(file), diagnostics: found.get(file) ?? [] })
    }

    // An open file goes through the one publish at a time, which reads the problems just stored.
    if (openChanged)
      await this.publishAllDiagnostics()
  }

  private async problemsOf(project: Project): Promise<CheckDiagnostic[]> {
    const { root, options, types } = project

    if (!types)
      return []

    const content = await contentChecks(root, options, project.probes)
    const [problems, typeErrors] = await Promise.all([projectProblems(root, options, content, project.probes), this.generatedTypeErrors(root)])

    return [...configProblems(root, options, types), ...typeErrors.flatMap(diagnostic => generatedProblem(root, diagnostic, types, content) ?? []), ...problems]
  }

  // What tsgo finds in the modules kay writes for it to check what only types tell, each opened for the question.
  private async generatedTypeErrors(root: string): Promise<CheckDiagnostic[]> {
    const found = await Promise.all(generatedChecks(root).filter(file => existsSync(file)).map(async (file) => {
      const uri = pathToFileURL(file).href

      this.server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: await Bun.file(file).text() } })

      try {
        const report = await this.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri } })

        return (report.items ?? []).map((diagnostic): CheckDiagnostic => ({ file, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1, code: typeof diagnostic.code === 'number' ? `TS${diagnostic.code}` : undefined, message: diagnostic.message }))
      }
      finally {
        this.server.notify('textDocument/didClose', { textDocument: { uri } })
      }
    }))

    return found.flat()
  }

  // Every open file is checked again on any change, since editing one component can break the files using it. A slow tsgo runs one publish at a time, those asked for meanwhile making one more, which sees the latest text.
  private async publishAllDiagnostics() {
    if (this.publishing) {
      this.publishAgain = true

      return
    }

    this.publishing = true

    try {
      // Settled, not rejected at the first failure, so none is still running when the next publish starts.
      const settled = await Promise.allSettled([...this.documents.values()].map(async document => this.publishDiagnostics(document)))
      const failed = settled.find(result => result.status === 'rejected')

      if (failed)
        throw failed.reason
    }
    finally {
      this.publishing = false

      if (this.publishAgain) {
        this.publishAgain = false
        void guard(this.publishAllDiagnostics())
      }
    }
  }

  private async publishDiagnostics(document: Document) {
    const project = this.projectAt(projectRootOf(document.file, this.root))
    const rangeOf = (span: Span) => ({ start: toPosition(document.source, span.start), end: toPosition(document.source, Math.max(span.end, span.start + 1)) })
    // A library component the app never imports is the library's to check, as `kay check` leaves it.
    const reached = !project.unreached.has(document.file)
    const compileErrors = (reached ? document.diagnostics : []).map(diagnostic => ({
      range: rangeOf(diagnostic),
      severity: diagnostic.severity === 'warning' ? WARNING : ERROR,
      source: 'kay',
      ...diagnostic.code !== undefined && { code: diagnostic.code },
      message: editorMessage(diagnostic),
      ...diagnostic.related && { relatedInformation: diagnostic.related.map(span => ({ location: { uri: document.uri, range: rangeOf(span) }, message: span.label })) },
      ...diagnostic.code === 'unread-name' && { tags: [UNNECESSARY] },
    }))
    // A compile error leaves the shadow TSX half-written, so its type errors would only be noise; one found by type checking only leaves it whole. The rest of what `kay check` leaves out stays out here too.
    const broken = new Set(document.diagnostics.some(diagnostic => !diagnostic.checkOnly) ? [document.file] : [])
    const reports = reportsTypeErrors(document.file, { root: project.root, broken, unreached: project.unreached, libraries: project.libraries })
    const report = reports ? await this.server.request<DocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: document.shadowUri } }) : undefined

    if (this.documents.get(document.uri) !== document)
      return

    // Related information points into the shadow TSX, a file the user never sees. Each one reads as `kay check` reports it: unused code is the `unread-name` lint, which TypeScript only hints at without `noUnusedLocals`.
    const levelAt = lintLevels(document.source, project.options.lints)
    const typeErrors = (report?.items ?? []).flatMap(({ relatedInformation: _related, ...diagnostic }) => {
      const start = toOffset(document.tsx, diagnostic.range.start)
      const diagnosed = diagnoseShadow(document, { code: typeof diagnostic.code === 'number' ? diagnostic.code : undefined, message: diagnostic.message, start, end: toOffset(document.tsx, diagnostic.range.end) }, levelAt)

      if (!diagnosed || servedByTheApp(document.file, diagnosed.message, project.mounts, project.locales))
        return []

      return [{
        ...diagnostic,
        ...diagnosed.code !== undefined && { code: diagnosed.code },
        ...diagnosed.severity !== undefined && { severity: diagnosed.severity === 'warning' ? WARNING : ERROR },
        ...diagnosed.unread && { tags: [UNNECESSARY] },
        message: editorMessage(diagnosed),
        range: diagnosed.span ? rangeOf(diagnosed.span) : zeroRange(),
      }]
    })

    this.client.notify('textDocument/publishDiagnostics', { uri: document.uri, version: document.version, diagnostics: [...compileErrors, ...typeErrors, ...this.problems.get(document.file) ?? []] })
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

    if (result === null)
      return []

    return Array.isArray(result) ? result : [result]
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
        return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, 'loose') ?? selection, targetSelectionRange: selection }]

      const key = positionKey(link.targetUri, link.targetSelectionRange.start)

      if (!asked.has(key) && asked.size <= MAX_HOPS) {
        asked.add(key)

        const followed = await this.sourceLinks(origin, await this.definitionsAt({ textDocument: { uri: link.targetUri }, position: link.targetSelectionRange.start }), asked)

        if (followed.length > 0)
          return followed.map(found => ({ ...found, originSelectionRange }))
      }

      return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, 'loose') ?? zeroRange(), targetSelectionRange: toSourceRange(shadow, link.targetSelectionRange, 'loose') ?? zeroRange() }]
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

    const file = shadowSource(project.root, path)
    const source = Bun.file(file)

    return await source.exists() ? compileShadow(project.root, file, await source.text(), { routesDir: project.routesDir, mounts: project.mounts, insideIsland: project.islandOnly.has(file), lints: project.options.lints }).shadow : undefined
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
    stopProbes()
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
  const span = generatedSpan(document, toOffset(document.source, range.start), toOffset(document.source, range.end))

  return span && { start: toPosition(document.tsx, span.start), end: toPosition(document.tsx, span.end) }
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

// A generated range back in the .kay source.
function toSourceRange(document: ShadowFile, range: Range, mode: SpanMode = 'exact'): Range | undefined {
  const span = sourceSpan(document, toOffset(document.tsx, range.start), toOffset(document.tsx, range.end), mode)

  return span && { start: toPosition(document.source, span.start), end: toPosition(document.source, span.end) }
}

// A problem of the project, at the start of the line and column it names.
function problemDiagnostic(problem: CheckDiagnostic): Diagnostic {
  const position = { line: problem.line - 1, character: problem.column - 1 }

  return { range: { start: position, end: position }, severity: problem.severity === 'warning' ? WARNING : ERROR, source: 'kay', ...problem.code !== undefined && { code: problem.code }, message: editorMessage(problem) }
}

// A diagnostic as an editor shows it, its label, note and help on their own lines.
function editorMessage({ message, label, note, help }: Pick<KayDiagnostic, 'message' | 'label' | 'note' | 'help'>): string {
  return [label !== undefined && label !== '' ? `${message} (${label})` : message, ...[['note', note], ['help', help]].flatMap(([kind, text]) => text === undefined ? [] : [`${kind}: ${text}`])].join('\n')
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
