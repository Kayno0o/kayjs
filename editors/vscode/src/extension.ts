import type { ExtensionContext } from 'vscode'
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { window, workspace } from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'

let client: LanguageClient | undefined

export async function activate(context: ExtensionContext): Promise<void> {
  const folder = workspace.workspaceFolders?.[0]

  if (!folder)
    return

  const root = folder.uri.fsPath
  const config = workspace.getConfiguration('kay')
  const cli = serverPath(root, config.get<string>('server.path', ''))

  if (!existsSync(cli)) {
    void window.showErrorMessage(`Kay: no language server at ${cli}. Install kay in this workspace or set kay.server.path.`)

    return
  }

  const run = { command: config.get<string>('bun.path', 'bun'), args: [cli, 'lsp', '--stdio'], options: { cwd: root } }
  const server: ServerOptions = { run, debug: run }
  const options: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'kay' }],
    initializationOptions: { routes: config.get<string>('routes') || undefined },
  }

  client = new LanguageClient('kay', 'Kay', server, options)
  context.subscriptions.push(client)
  await client.start()
}

export async function deactivate(): Promise<void> {
  await client?.stop()
}

// The kay CLI the project depends on, so the server always matches the compiler its build uses.
function serverPath(root: string, configured: string): string {
  if (configured !== '')
    return isAbsolute(configured) ? configured : join(root, configured)

  const installed = join(root, 'node_modules', 'kay', 'src', 'cli.ts')

  return existsSync(installed) ? installed : join(root, 'src', 'cli.ts')
}
