import type { ExtensionContext, OutputChannel } from 'vscode'
import type { LanguageClientOptions, Middleware, ServerOptions } from 'vscode-languageclient/node'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { commands, env, Uri, window, workspace } from 'vscode'
import { LanguageClient, Trace } from 'vscode-languageclient/node'
import { registerCommands } from './commands'
import { clientRoots, holding, owns, rootOf } from './roots'

const clients = new Map<string, LanguageClient>()
// The kay CLI each running server was started with, which `kay check` runs too.
const clis = new Map<string, string>()
// A project is warned about once, so a kay that stays uninstalled does not toast on every rescan.
const warned = new Set<string>()
const CONFIG_SUFFIX = /[\\/]kay\.config\.ts$/
// The middleware hooks that take a document first.
const FEATURE = /^(?:provide|prepare)/
let channel: OutputChannel | undefined
let syncing: Promise<void> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined

export function activate(context: ExtensionContext): void {
  channel = window.createOutputChannel('Kay')

  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => void sync(), 750)
  }
  // bun.lock and package.json move when kay is installed, which VS Code does not watch inside node_modules.
  const watcher = workspace.createFileSystemWatcher('**/{kay.config.ts,package.json,bun.lock,bun.lockb}')

  context.subscriptions.push(
    channel,
    watcher,
    watcher.onDidCreate(schedule),
    watcher.onDidChange(schedule),
    watcher.onDidDelete(schedule),
    workspace.onDidChangeWorkspaceFolders(schedule),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('kay.lsp.trace'))
        void applyTrace()

      if (event.affectsConfiguration('kay.bun.path') || event.affectsConfiguration('kay.server.path') || event.affectsConfiguration('kay.routes'))
        void restart()
    }),
    { dispose: () => clearTimeout(timer) },
    ...registerCommands((id, run) => commands.registerCommand(id, run), {
      'kay.restartServer': restart,
      'kay.check': runCheck,
      'kay.openDevServer': () => env.openExternal(Uri.parse(workspace.getConfiguration('kay').get<string>('dev.url', 'http://localhost:3000'))),
      'kay.showOutput': showOutput,
    }),
  )

  void sync()
}

export async function deactivate(): Promise<void> {
  await stopAll()
}

// Syncs run one after the other, as two at once would start a server twice.
async function runSync(previous: Promise<void>): Promise<void> {
  await previous

  try {
    await syncRoots()
  }
  catch (error) {
    channel?.appendLine(`Kay: ${String(error)}`)
  }
}

function sync(): Promise<void> {
  syncing = runSync(syncing)

  return syncing
}

async function stop(client: LanguageClient): Promise<void> {
  try {
    await client.stop()
  }
  catch (error) {
    channel?.appendLine(`Kay: a language server did not stop cleanly: ${String(error)}`)
  }
}

async function syncRoots(): Promise<void> {
  const folders = workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []
  const config = workspace.getConfiguration('kay')
  const found = await workspace.findFiles('**/kay.config.ts', '**/node_modules/**', 200)
  const roots = clientRoots(folders, found.map(uri => uri.fsPath.replace(CONFIG_SUFFIX, '')), config.get<string>('server.path', ''), existsSync)
  const served = new Set(roots.filter(root => root.cli !== undefined && existsSync(root.cli)).map(root => root.root))

  const stopped = [...clients.keys()].filter(root => !served.has(root))
  const started = [...served].filter(root => !clients.has(root))
  // A server that gains or loses a nested project restarts, as the files it owns changed hands while they were open.
  const leaving = new Set([...stopped, ...holding([...clients.keys()].filter(root => served.has(root)), [...stopped, ...started])])

  await Promise.all([...leaving].map(async (root) => {
    const client = clients.get(root)

    clients.delete(root)
    clis.delete(root)

    if (client !== undefined)
      await stop(client)
  }))

  for (const { root, cli, config: byConfig } of roots) {
    if (!served.has(root)) {
      if (byConfig && !warned.has(root)) {
        warned.add(root)
        channel?.appendLine(`Kay: no language server for ${root}: kay is not installed there, and the server starts once it is. Set kay.server.path to use another.`)
        void window.showWarningMessage(`Kay: kay is not installed in ${basename(root)}, so the language server waits for it. Run bun install, or set kay.server.path.`)
      }

      continue
    }

    if (!clients.has(root))
      await start(root, cli!, roots.length > 1)
  }
}

// Keeps the documents of a deeper project away from the server of this one: its selector is a folder, which matches the nested project too.
function ownedBy(root: string): Middleware {
  const mine = (target: unknown): boolean => {
    const uri = typeof target === 'object' && target !== null && 'uri' in target ? target.uri : target
    const path = typeof uri === 'object' && uri !== null && 'fsPath' in uri && typeof uri.fsPath === 'string' ? uri.fsPath : undefined

    return path === undefined || owns(root, path, [...clients.keys()])
  }

  type Next = (...args: never[]) => unknown
  const forward = (first: unknown, next: Next): unknown => mine(first) ? next(first as never) : undefined
  const handlers: Record<string, unknown> = {
    ...Object.fromEntries(['didOpen', 'didClose', 'didSave'].map(name => [name, forward])),
    ...Object.fromEntries(['didChange', 'willSave', 'willSaveWaitUntil'].map(name => [name, (event: { document: unknown }, next: Next) => forward(event.document, next)])),
    handleDiagnostics: (uri: unknown, diagnostics: unknown, next: Next) => mine(uri) ? next(uri as never, diagnostics as never) : undefined,
  }

  // The language features ask for a document first: provideHover(document, position, token, next).
  return new Proxy(handlers, {
    get(target, name) {
      if (typeof name !== 'string')
        return undefined

      if (name in target)
        return target[name]

      if (!(FEATURE).test(name))
        return undefined

      return (...args: unknown[]) => {
        const next = args.pop() as (...rest: unknown[]) => unknown

        return mine(args[0]) ? next(...args) : undefined
      }
    },
  }) as Middleware
}

async function start(root: string, cli: string, several: boolean): Promise<void> {
  const config = workspace.getConfiguration('kay')
  const run = { command: config.get<string>('bun.path', 'bun') || 'bun', args: [cli, 'lsp', '--stdio'], options: { cwd: root } }
  const server: ServerOptions = { run, debug: run }
  const options: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'kay', pattern: { baseUri: Uri.file(root).toString(), pattern: '**' } }],
    // The project's own root, which the server takes as its root: the enclosing workspace folder would give two apps of a monorepo the same one.
    workspaceFolder: { uri: Uri.file(root), name: basename(root), index: 0 },
    middleware: ownedBy(root),
    initializationOptions: { routes: config.get<string>('routes') || undefined },
  }
  const client = new LanguageClient('kay', several ? `Kay (${basename(root)})` : 'Kay', server, options)

  clients.set(root, client)
  clis.set(root, cli)

  try {
    await client.start()
    await client.setTrace(Trace.fromString(config.get<string>('lsp.trace', 'off')))
  }
  catch (error) {
    clients.delete(root)
    clis.delete(root)
    await stop(client)
    channel?.appendLine(`Kay: the language server of ${root} did not start: ${String(error)}`)
  }
}

async function stopAll(): Promise<void> {
  const running = [...clients.values()]

  clients.clear()
  clis.clear()
  await Promise.all(running.map(stop))
}

async function restart(): Promise<void> {
  await stopAll()
  warned.clear()
  await sync()
}

async function applyTrace(): Promise<void> {
  const trace = Trace.fromString(workspace.getConfiguration('kay').get<string>('lsp.trace', 'off'))

  await Promise.all([...clients.values()].map(async client => client.setTrace(trace)))
}

// The project a command acts on: the one owning the open file, else the only one, else the one picked.
async function pickRoot(): Promise<string | undefined> {
  const roots = [...clients.keys()]
  const file = window.activeTextEditor?.document.uri.fsPath
  const owner = file === undefined ? undefined : rootOf(file, roots)

  if (owner !== undefined || roots.length === 1)
    return owner ?? roots[0]

  if (roots.length === 0) {
    void window.showWarningMessage('Kay: no project with kay installed is open.')

    return undefined
  }

  return window.showQuickPick(roots, { placeHolder: 'Kay project' })
}

async function runCheck(): Promise<void> {
  const root = await pickRoot()

  if (root === undefined)
    return

  const config = workspace.getConfiguration('kay')
  const cli = clis.get(root)

  if (cli === undefined)
    return

  const terminal = window.createTerminal({ name: `Kay check (${basename(root)})`, cwd: root, shellPath: config.get<string>('bun.path', 'bun') || 'bun', shellArgs: [cli, 'check'] })

  terminal.show()
}

async function showOutput(): Promise<void> {
  const root = await pickRoot()

  if (root === undefined)
    channel?.show()
  else
    clients.get(root)?.outputChannel.show()
}
