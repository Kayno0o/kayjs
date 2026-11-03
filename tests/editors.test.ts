import { chmod, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { version } from '../package.json'
import { findEditors, helixBlock, installHelix, installZed, serverCommand } from '../src/editors'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const dir = await scratchDir(prefix)

  dirs.push(dir)

  return dir
}

// A PATH holding only the named programs, each a script appending its arguments to `calls` (and failing when `failing` names it), so the real config of the machine and its editors are never touched.
async function fakePath(programs: string[], failing: string[] = []): Promise<{ path: string, calls: string }> {
  const bin = await scratch('editor-bin-')
  const calls = join(bin, 'calls')

  for (const name of programs) {
    await Bun.write(join(bin, name), `#!/bin/sh\necho "${name} $@" >> ${calls}\n${failing.includes(name) ? 'echo broken >&2; exit 3\n' : ''}`)
    await chmod(join(bin, name), 0o755)
  }

  return { path: bin, calls }
}

async function callsOf(file: string): Promise<string[]> {
  return await Bun.file(file).exists() ? (await Bun.file(file).text()).trim().split('\n') : []
}

async function kay(args: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { ...cwd === undefined ? {} : { cwd }, env: { HOME: env.XDG_CONFIG_HOME, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('the editors on the PATH', () => {
  it('finds the ones whose program is there, under any of their names', async () => {
    expect(findEditors((await fakePath([])).path)).toEqual([])
    expect(findEditors((await fakePath(['hx'])).path)).toEqual(['helix'])
    expect(findEditors((await fakePath(['zeditor', 'helix'])).path)).toEqual(['helix', 'zed'])
  })

  it('starts the language server with the kay on the PATH, else the one the project installed, else bunx', async () => {
    const root = await scratch('editor-root-')
    const installed = await scratch('editor-root-')

    await Bun.write(join(installed, 'node_modules/kay/src/cli.ts'), '')

    expect(serverCommand({ root, path: (await fakePath(['kay'])).path })).toEqual({ command: 'kay', args: [] })
    expect(serverCommand({ root: installed, path: (await fakePath([])).path })).toEqual({ command: 'bun', args: ['node_modules/kay/src/cli.ts'] })
    expect(serverCommand({ root, installing: true, path: (await fakePath([])).path })).toEqual({ command: 'bun', args: ['node_modules/kay/src/cli.ts'] })
    expect(serverCommand({ root, path: (await fakePath([])).path })).toEqual({ command: 'bunx', args: ['kay'] })
  })
})

describe('helix', () => {
  it('declares the language, the server and the kay grammar, copies the queries and builds the grammar', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path, calls } = await fakePath(['hx'])

    await Bun.write(join(root, 'node_modules/kay/src/cli.ts'), '')

    const setup = await installHelix({ root, configHome: home, path })
    const config = Bun.TOML.parse(await Bun.file(join(home, 'helix/languages.toml')).text()) as { 'language-server': Record<string, { command: string, args: string[] }>, 'language': { 'name': string, 'roots': string[], 'grammar': string, 'language-servers': string[] }[], 'grammar': { name: string, source: { rev: string, subpath: string } }[] }

    expect(config['language-server'].kay).toEqual({ command: 'bun', args: ['node_modules/kay/src/cli.ts', 'lsp', '--stdio'] })
    expect(config.language).toMatchObject([{ 'name': 'kay', 'roots': ['kay.config.ts'], 'grammar': 'kay', 'language-servers': ['kay'] }])
    expect(config.grammar).toMatchObject([{ name: 'kay', source: { rev: `v${version}`, subpath: 'editors/tree-sitter-kay' } }])

    for (const name of ['highlights', 'indents', 'injections'])
      expect(await Bun.file(join(home, `helix/runtime/queries/kay/${name}.scm`)).text()).toBe(await Bun.file(join(import.meta.dir, `../editors/tree-sitter-kay/queries/${name}.scm`)).text())

    expect(await callsOf(calls)).toEqual(['hx --grammar fetch', 'hx --grammar build'])
    expect(setup.notes).toEqual([])
    expect(setup.summary).toContain('built')
  })

  it('lists what it would write under dryRun, and writes nothing', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path, calls } = await fakePath(['hx'])
    const helix = await installHelix({ root, configHome: home, path, dryRun: true })
    const zed = await installZed({ root, configHome: home, path, dryRun: true })

    expect(helix.files.length).toBeGreaterThan(0)
    expect(zed.files.length).toBeGreaterThan(0)
    expect(helix.summary).toContain('would write')
    expect(zed.summary).toContain('would be written')
    expect(await Bun.file(join(home, 'helix/languages.toml')).exists()).toBe(false)
    expect(await Bun.file(join(home, 'zed/kay-extension/extension.toml')).exists()).toBe(false)
    expect(await Bun.file(join(root, '.zed/settings.json')).exists()).toBe(false)
    expect(await callsOf(calls)).toEqual([])
  })

  it('rewrites its own section on a second run and keeps the rest of the file', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path } = await fakePath(['hx'])
    const file = join(home, 'helix/languages.toml')

    await Bun.write(file, '[[language]]\nname = "zig"\nauto-format = true\n')
    await installHelix({ root, configHome: home, path })
    await installHelix({ root, configHome: home, path })

    const text = await Bun.file(file).text()

    expect(text.startsWith('[[language]]\nname = "zig"\nauto-format = true\n\n# kay:begin')).toBe(true)
    expect(text.split('# kay:begin').length).toBe(2)
    expect((Bun.TOML.parse(text) as { language: unknown[] }).language).toHaveLength(2)
  })

  it('refuses a kay language the user declared themselves', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path, calls } = await fakePath(['hx'])

    await Bun.write(join(home, 'helix/languages.toml'), '[[language]]\nname = "kay"\ngrammar = "typescript"\n')

    await expect(installHelix({ root, configHome: home, path })).rejects.toThrow('already declares a language named kay')
    expect(await callsOf(calls)).toEqual([])
    expect(await Bun.file(join(home, 'helix/languages.toml')).text()).toBe('[[language]]\nname = "kay"\ngrammar = "typescript"\n')
  })

  it('says how to build the grammar when hx is missing or fails, files written all the same', async () => {
    const root = await scratch('editor-root-')
    const missing = await installHelix({ root, configHome: await scratch('editor-home-'), path: (await fakePath([])).path })
    const failed = await installHelix({ root, configHome: await scratch('editor-home-'), path: (await fakePath(['hx'], ['hx'])).path })

    expect(missing.notes[0]).toContain('hx --grammar fetch')
    expect(failed.notes[0]).toContain('hx --grammar fetch')
    expect(failed.notes[0]).toContain('broken')
    expect(failed.files.length).toBe(4)
  })

  it('writes a section helix reads as TOML', () => {
    expect(() => Bun.TOML.parse(helixBlock({ command: 'kay', args: [] }))).not.toThrow()
  })
})

describe('zed', () => {
  it('writes the extension with the grammar named kay and the project\'s server command', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path } = await fakePath(['rustup'])
    const setup = await installZed({ root, configHome: home, path })
    const extension = join(home, 'zed/kay-extension')
    const manifest = Bun.TOML.parse(await Bun.file(join(extension, 'extension.toml')).text()) as { version: string, grammars: Record<string, { rev: string, path: string }> }

    expect(Object.keys(manifest.grammars)).toEqual(['kay'])
    expect(manifest.version).toBe(version)
    expect(manifest.grammars.kay?.rev).toBe(`v${version}`)

    for (const file of ['Cargo.toml', 'src/lib.rs', 'languages/kay/config.toml', 'languages/kay/highlights.scm', 'languages/kay/indents.scm', 'languages/kay/injections.scm'])
      expect(await Bun.file(join(extension, file)).exists()).toBe(true)

    expect(await Bun.file(join(extension, 'src/lib.rs')).text()).toContain('node_modules/kay/src/cli.ts')
    expect(await Bun.file(join(root, '.zed/settings.json')).json()).toEqual({ languages: { Kay: { semantic_tokens: 'combined' } } })
    expect(setup.notes).toHaveLength(1)
    expect(setup.notes[0]).toContain('install dev extension')
  })

  it('merges the setting into settings.json, keeps what is there, and leaves a file with comments alone', async () => {
    const home = await scratch('editor-home-')
    const merged = await scratch('editor-root-')
    const commented = await scratch('editor-root-')
    const { path } = await fakePath([])

    await Bun.write(join(merged, '.zed/settings.json'), JSON.stringify({ theme: 'One', languages: { Kay: { tab_size: 4 }, Rust: { tab_size: 2 } } }))
    await Bun.write(join(commented, '.zed/settings.json'), '{\n  // mine\n  "theme": "One"\n}\n')
    await installZed({ root: merged, configHome: home, path })

    const setup = await installZed({ root: commented, configHome: home, path })

    expect(await Bun.file(join(merged, '.zed/settings.json')).json()).toEqual({ theme: 'One', languages: { Kay: { tab_size: 4, semantic_tokens: 'combined' }, Rust: { tab_size: 2 } } })
    expect(await Bun.file(join(commented, '.zed/settings.json')).text()).toBe('{\n  // mine\n  "theme": "One"\n}\n')
    expect(setup.notes.some(note => note.includes('is not plain JSON'))).toBe(true)
    expect(setup.notes.some(note => note.includes('rustup is not installed'))).toBe(true)
  })

  it('replaces the extension of an earlier run', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')

    await Bun.write(join(home, 'zed/kay-extension/stale.txt'), 'old')
    await installZed({ root, configHome: home, path: (await fakePath([])).path })

    expect(await Bun.file(join(home, 'zed/kay-extension/stale.txt')).exists()).toBe(false)
  })
})

describe('kay editor install', () => {
  it('installs for the editors on the PATH into XDG_CONFIG_HOME, one line each', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const { path, calls } = await fakePath(['hx', 'zed', 'rustup'])
    const bun = dirname(process.execPath)
    const { stdout, stderr, code } = await kay(['editor', 'install'], { PATH: `${path}:${bun}`, XDG_CONFIG_HOME: home }, root)

    expect({ code, stderr: stderr.includes('install dev extension') }).toEqual({ code: 0, stderr: true })
    expect(stdout.trim().split('\n').map(line => line.slice(0, line.indexOf(':')))).toEqual(['Helix', 'Zed'])
    expect(await Bun.file(join(home, 'helix/languages.toml')).exists()).toBe(true)
    expect(await Bun.file(join(home, 'zed/kay-extension/extension.toml')).exists()).toBe(true)
    expect(await callsOf(calls)).toEqual(['hx --grammar fetch', 'hx --grammar build'])
  })

  it('names the editor asked for, fails with none on the PATH, and refuses an unknown one', async () => {
    const home = await scratch('editor-home-')
    const root = await scratch('editor-root-')
    const env = { PATH: `${(await fakePath([])).path}:${dirname(process.execPath)}`, XDG_CONFIG_HOME: home }
    const none = await kay(['editor', 'install'], env, root)
    const named = await kay(['editor', 'install', 'helix', '--format', 'json'], env, root)
    const unknown = await kay(['editor', 'install', 'vim'], env, root)

    expect(none.code).toBe(1)
    expect(none.stderr).toContain('name the editor')
    expect(named.code).toBe(0)
    expect((JSON.parse(named.stdout) as { editors: { editor: string }[] }).editors.map(setup => setup.editor)).toEqual(['helix'])
    expect(unknown.code).toBe(2)
  })
})

describe('kay new', () => {
  it('sets the named editors up, with the project\'s kay as the server since it is installed next', async () => {
    const home = await scratch('editor-home-')
    const parent = await scratch('editor-new-')
    const { path } = await fakePath(['hx'])
    const { code, stdout } = await kay(['new', 'app', '--template', 'blank', '--editor', 'helix'], { PATH: `${path}:${dirname(process.execPath)}`, XDG_CONFIG_HOME: home }, parent)

    expect(code).toBe(0)
    expect(stdout).toContain('Helix:')
    expect(await Bun.file(join(home, 'helix/languages.toml')).text()).toContain('"node_modules/kay/src/cli.ts"')
  })

  it('sets nothing up with no flag outside a terminal, and refuses an unknown editor before writing', async () => {
    const home = await scratch('editor-home-')
    const parent = await scratch('editor-new-')
    const env = { PATH: `${(await fakePath(['hx'])).path}:${dirname(process.execPath)}`, XDG_CONFIG_HOME: home }
    const plain = await kay(['new', 'plain', '--template', 'blank'], env, parent)
    const bad = await kay(['new', 'bad', '--template', 'blank', '--editor', 'vim'], env, parent)

    expect(plain.code).toBe(0)
    expect(await Bun.file(join(home, 'helix/languages.toml')).exists()).toBe(false)
    expect(bad.code).toBe(1)
    expect(await Bun.file(join(parent, 'bad/package.json')).exists()).toBe(false)
  })
})
