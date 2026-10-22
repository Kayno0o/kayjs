import type { ExtensionContext, OutputChannel } from 'vscode'
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { commands, env, Uri, window, workspace } from 'vscode'
import { LanguageClient, Trace } from 'vscode-languageclient/node'
import { registerCommands } from './commands'
import { clientRoots, rootOf } from './roots'

const clients = new Map<string, LanguageClient>()
// The kay CLI each running server was started with, which `kay check` runs too.
const clis = new Map<string, string>()
// A project is warned about once, so a kay that stays uninstalled does not toast on every rescan.
const warned = new Set<string>()
const CONFIG_SUFFIX = /[\\/]kay\.config\.ts$/
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

  await Promise.all([...clients].filter(([root]) => !served.has(root)).map(async ([root, client]) => {
    clients.delete(root)
    clis.delete(root)
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

async function start(root: string, cli: string, several: boolean): Promise<void> {
  const config = workspace.getConfiguration('kay')
  const run = { command: config.get<string>('bun.path', 'bun') || 'bun', args: [cli, 'lsp', '--stdio'], options: { cwd: root } }
  const server: ServerOptions = { run, debug: run }
  const options: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'kay', pattern: { baseUri: Uri.file(root).toString(), pattern: '**' } }],
    workspaceFolder: workspace.getWorkspaceFolder(Uri.file(root)),
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
