// Setting up the editors that read `.kay` through a tree-sitter grammar and the language server: what `kay editor install` and the `kay new` step write.
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { version } from '../package.json'

export const EDITORS = ['helix', 'zed'] as const

export type Editor = typeof EDITORS[number]

export interface EditorSetup {
  editor: Editor
  // The one line printed for the editor.
  summary: string
  // What the user still does or lacks, one line each.
  notes: string[]
  // Every file written, absolute.
  files: string[]
}

export interface EditorOptions {
  // The project the language server runs in.
  root: string
  // Where editors keep their configuration, `~/.config` by default; `XDG_CONFIG_HOME` moves it.
  configHome?: string
  // The project will have kay installed (`kay new` runs before `bun install`).
  installing?: boolean
  // The directories searched for the editors and the tools, `PATH` by default.
  path?: string
}

const BINARIES: Record<Editor, string[]> = { helix: ['hx', 'helix'], zed: ['zed', 'zeditor', 'zed-editor'] }
const PROJECT_CLI = 'node_modules/kay/src/cli.ts'
const REPOSITORY = 'https://github.com/Kayno0o/kayjs'
const BEGIN = '# kay:begin (written by `kay editor install`, rewritten by the next one)'
const END = '# kay:end'
const MANAGED = new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`)
const OWN_LANGUAGE = /^\s*name\s*=\s*["']kay["']/m
const EDITOR_ROOT = join(import.meta.dir, '..', 'editors')
const QUERIES = ['highlights.scm', 'indents.scm', 'injections.scm']
const ZED_EXTENSION = 'kay-extension'
const ZED_COPIED = ['extension.toml', 'Cargo.toml', 'src', 'languages']
const DIRTY_LINE = /\r?\n$/
// Matches a JSON text without comments or trailing commas, which is all that is rewritten.
const PLAIN_JSON = /^\s*\{[\s\S]*\}\s*$/

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export function configHomeOf(env: Record<string, string | undefined> = process.env): string {
  return env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config')
}

function whichOf(names: string[], path: string | undefined): string | undefined {
  for (const name of names) {
    const found = Bun.which(name, { PATH: path ?? process.env.PATH ?? '' })

    if (found !== null)
      return found
  }

  return undefined
}

// The editors whose program is on the PATH.
export function findEditors(path?: string): Editor[] {
  return EDITORS.filter(editor => whichOf(BINARIES[editor], path) !== undefined)
}

// The command an editor starts the language server with, from the project's folder: a `kay` on the PATH, else the kay the project installed run by bun, else bunx.
export function serverCommand({ root, installing = false, path }: Pick<EditorOptions, 'root' | 'installing' | 'path'>): { command: string, args: string[] } {
  if (whichOf(['kay'], path) !== undefined)
    return { command: 'kay', args: [] }

  if (installing || existsSync(join(root, PROJECT_CLI)))
    return { command: 'bun', args: [PROJECT_CLI] }

  return { command: 'bunx', args: ['kay'] }
}

function toml(value: string[]): string {
  return `[${value.map(item => JSON.stringify(item)).join(', ')}]`
}

// The `languages.toml` section for the `kay` language, its server, its formatter and its grammar from this release.
export function helixBlock(server: { command: string, args: string[] }): string {
  return `${BEGIN}
[language-server.kay]
command = ${JSON.stringify(server.command)}
args = ${toml([...server.args, 'lsp', '--stdio'])}

[[language]]
name = "kay"
scope = "source.kay"
file-types = ["kay"]
roots = ["kay.config.ts"]
indent = { tab-width = 2, unit = "  " }
language-servers = ["kay"]
formatter = { command = ${JSON.stringify(server.command)}, args = ${toml([...server.args, 'fmt', '--stdin', '%{buffer_name}'])} }
auto-format = true
grammar = "kay"

[[grammar]]
name = "kay"
source = { git = ${JSON.stringify(REPOSITORY)}, rev = ${JSON.stringify(`v${version}`)}, subpath = "editors/tree-sitter-kay" }
${END}
`
}

async function run(command: string[], cwd: string, path?: string): Promise<string | undefined> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...path === undefined ? {} : { PATH: path } }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return code === 0 ? undefined : `${command.join(' ')} exited ${code}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ')}`
}

export async function installHelix(options: EditorOptions): Promise<EditorSetup> {
  const home = join(options.configHome ?? configHomeOf(), 'helix')
  const languages = join(home, 'languages.toml')
  const existing = existsSync(languages) ? await readFile(languages, 'utf8') : ''
  const outside = existing.replace(MANAGED, '')

  if (OWN_LANGUAGE.test(outside))
    throw new Error(`${languages} already declares a language named kay: remove it, or the kay section it holds, and run the command again`)

  const block = helixBlock(serverCommand(options))
  const text = MANAGED.test(existing) ? existing.replace(MANAGED, () => block) : `${existing === '' ? '' : `${existing.replace(DIRTY_LINE, '')}\n\n`}${block}`
  const queries = join(home, 'runtime', 'queries', 'kay')
  const files = [languages, ...QUERIES.map(name => join(queries, name))]
  const notes: string[] = []

  await mkdir(queries, { recursive: true })
  await writeFile(languages, text)
  await Promise.all(QUERIES.map(async name => cp(join(EDITOR_ROOT, 'tree-sitter-kay', 'queries', name), join(queries, name))))

  const helix = whichOf(BINARIES.helix, options.path)

  if (helix === undefined) {
    notes.push('Helix is not on the PATH: run `hx --grammar fetch` and `hx --grammar build` to get the grammar')

    return { editor: 'helix', summary: `Helix: language, queries and grammar entry written to ${home}`, notes, files }
  }

  const failure = await run([helix, '--grammar', 'fetch'], home, options.path) ?? await run([helix, '--grammar', 'build'], home, options.path)

  if (failure !== undefined)
    notes.push(`the grammar was not built (${failure}); it needs git and a C compiler, run \`hx --grammar fetch\` and \`hx --grammar build\` once fixed`)

  return { editor: 'helix', summary: `Helix: language, queries and grammar ${failure === undefined ? 'built' : 'registered'} in ${home}`, notes, files }
}

// Zed registers a language server only through an extension it compiles, so the extension of this release is copied to the config folder, with the project's Zed settings turning on the server's tokens.
export async function installZed(options: EditorOptions): Promise<EditorSetup> {
  const home = join(options.configHome ?? configHomeOf(), 'zed')
  const target = join(home, ZED_EXTENSION)
  const files: string[] = []
  const notes: string[] = []

  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  for (const name of ZED_COPIED)
    await cp(join(EDITOR_ROOT, 'zed', name), join(target, name), { recursive: true })

  files.push(...['extension.toml', 'Cargo.toml', 'src/lib.rs', 'languages/kay/config.toml', ...QUERIES.map(name => `languages/kay/${name}`)].map(name => join(target, name)))

  const settings = join(options.root, '.zed', 'settings.json')
  const wanted = { languages: { Kay: { semantic_tokens: 'combined' } } }

  if (existsSync(settings)) {
    const text = await readFile(settings, 'utf8')
    let parsed: unknown

    try {
      parsed = PLAIN_JSON.test(text) ? JSON.parse(text) : undefined
    }
    catch {
      parsed = undefined
    }

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const found = parsed as { languages?: Record<string, Record<string, unknown>> }

      found.languages = { ...found.languages, Kay: { semantic_tokens: 'combined', ...found.languages?.Kay } }
      await writeFile(settings, `${JSON.stringify(found, undefined, 2)}\n`)
      files.push(settings)
    }
    else {
      notes.push(`${settings} has comments, so it was left as it is: add ${JSON.stringify(wanted)} to it to colour the server's tokens`)
    }
  }
  else {
    await mkdir(join(options.root, '.zed'), { recursive: true })
    await writeFile(settings, `${JSON.stringify(wanted, undefined, 2)}\n`)
    files.push(settings)
  }

  if (whichOf(['rustup'], options.path) === undefined)
    notes.push('rustup is not installed, and Zed compiles the extension with it: install Rust through rustup (https://rustup.rs)')

  notes.push(`in Zed, run "zed: install dev extension" from the command palette and pick ${target}`)

  return { editor: 'zed', summary: `Zed: extension written to ${target}`, notes, files }
}

export async function installEditor(editor: Editor, options: EditorOptions): Promise<EditorSetup> {
  return editor === 'helix' ? installHelix({ ...options, root: resolve(options.root) }) : installZed({ ...options, root: resolve(options.root) })
}
