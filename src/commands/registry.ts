// kay's own commands, each loaded when it is the one run, and how they and an extension's are laid out for the CLI.
import type { Command as CliCommand, Summary } from '@kaynooo/cli-kit'
import type { Command } from './command'
import { runCommand } from './command'

// A command as a name of one word or two (a subcommand), what the help says of it, and how it runs.
export interface Entry {
  name: string
  // Read only where a help or a completion lists the command, when it is a function.
  summary: Summary
  run: (args: string[]) => Promise<number>
  // The heading the command is listed under in `kay --help`.
  group?: string
}

// What the help says of the first word of several commands.
const GROUP_SUMMARIES: Record<string, string> = { i18n: 'find and accept missing translations' }

// Each loaded when it is the one run, so `kay <command>` reads only its own code; a name of two words is a subcommand.
function own(name: string, summary: string, load: () => Promise<Command>): Entry {
  return { name, summary, run: async args => runCommand(await load(), args) }
}

export const COMMANDS: Entry[] = [
  own('new', 'scaffold an app', async () => (await import('./new')).scaffold),
  own('add', 'add features to an app', async () => (await import('./add')).add),
  own('generate', 'generate a page, component, island, action, api, guard or resource', async () => (await import('./generate')).generateCommand),
  own('dev', 'serve the app and rebuild on every change', async () => (await import('./dev')).dev),
  own('build', 'build the app, to a server, an executable or a static site', async () => (await import('./build')).build),
  own('start', 'serve the built app', async () => (await import('./start')).start),
  own('render', 'render one URL of the app and print the response', async () => (await import('./render')).render),
  own('screenshot', 'screenshot a page in Chromium', async () => (await import('./screenshot')).screenshotCommand),
  own('a11y', 'check the accessibility of the pages and write the declaration', async () => (await import('./a11y')).a11y),
  own('check', 'check the types and templates, and the lints', async () => (await import('./check')).check),
  own('upgrade', 'apply the safe fixes of the deprecated lints', async () => (await import('./upgrade')).upgrade),
  own('routes', 'list the routes', async () => (await import('./routes')).routes),
  own('not-found', 'list the paths that answered 404, and redirect them', async () => (await import('./not-found')).notFound),
  own('env', 'check and write the environment variables', async () => (await import('./env')).env),
  own('doctor', 'check the machine and the project', async () => (await import('./doctor')).doctor),
  own('explain', 'explain a lint, an error or a group of lints', async () => (await import('./explain')).explain),
  own('docs', 'search and read the documentation', async () => (await import('./docs')).docs),
  own('types', 'write the types of the project', async () => (await import('./types')).types),
  own('fmt', 'format .kay files', async () => (await import('./fmt')).fmt),
  own('lint', 'lint the project with its keslint', async () => (await import('./lint')).lint),
  own('test', 'run the tests with bun test', async () => (await import('./test')).test),
  own('i18n missing', 'list the translations a locale lacks', async () => (await import('./i18n')).i18nMissing),
  own('i18n accept', 'accept the translations of a locale as they are', async () => (await import('./i18n')).i18nAccept),
  own('migrate', 'migrate an Astro site or its content', async () => (await import('./migrate')).migrate),
  own('lsp', 'serve the language server over stdio', async () => (await import('./lsp')).lsp),
  own('mcp', 'serve the project to an agent as MCP tools', async () => (await import('./mcp')).mcp),
]
export const NAMES = COMMANDS.map(command => command.name)
const SPACES = / /

// The entries as the kit dispatches them: the first word of several a group of subcommands, in the order met.
export function tree(entries: Entry[]): Record<string, CliCommand> {
  // No prototype, so `kay constructor` is an unknown command.
  const commands: Record<string, CliCommand> = Object.create(null)

  for (const { name, summary, run, group } of entries) {
    const words = name.split(SPACES)
    let level = commands

    for (const word of words.slice(0, -1)) {
      const next = level[word]

      if (next && 'commands' in next && typeof next.commands !== 'function') {
        level = next.commands
      }
      else {
        const created: Record<string, CliCommand> = Object.create(null)

        level[word] = { summary: GROUP_SUMMARIES[word] ?? `commands of kay ${word}`, commands: created, ...group !== undefined && level === commands ? { group } : {} }
        level = created
      }
    }

    level[words.at(-1)!] = { summary, run, ...group !== undefined && level === commands ? { group } : {} }
  }

  return commands
}
