import type { CheckDiagnostic } from '../src/check'
import type { CodeAction, CompletionItem, CompletionList, Diagnostic, DocumentHighlight, Hover, Location, LocationLink, Range, TextEdit, WorkspaceEdit } from '../src/lsp/protocol'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { check } from '../src/check'
import * as shadowModule from '../src/check/shadow'
import { Connection } from '../src/lsp/rpc'
import { DIAGNOSTICS_DELAY, KayLanguageServer } from '../src/lsp/server'
import { scratchDir } from './scratch'

const fixtures = join(import.meta.dir, 'fixtures')
const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const SLOW = 300

// Drives `kay lsp` over stdio the way an editor does.
class Editor {
  readonly connection: Connection
  private readonly process = Bun.spawn([process.execPath, cli, 'lsp', '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  // Who waits for the next diagnostics of a file, of a version of it when they changed it.
  private readonly waiting = new Map<string, { resolve: (diagnostics: Diagnostic[]) => void, version: number | undefined }>()

  // Every publish, in the order they came.
  readonly publishes: { uri: string, version: number | undefined, diagnostics: Diagnostic[] }[] = []

  constructor(readonly root: string, private readonly vscode = false, private readonly capabilities: object = {}) {
    this.connection = new Connection(this.process.stdout, (data) => {
      void this.process.stdin.write(data)
      void this.process.stdin.flush()
    })
    this.connection.onNotification<{ uri: string, version?: number, diagnostics: Diagnostic[] }>('textDocument/publishDiagnostics', ({ uri, version, diagnostics }) => {
      const waiting = this.waiting.get(uri)

      this.publishes.push({ uri, version, diagnostics })

      if (waiting && (waiting.version === undefined || waiting.version === version))
        waiting.resolve(diagnostics)
    })
  }

  async start() {
    await this.connection.request('initialize', { processId: process.pid, rootUri: this.fileUri(this.root), capabilities: this.capabilities })
    this.connection.notify('initialized', {})
  }

  uri(path: string): string {
    return this.fileUri(join(this.root, path))
  }

  // VS Code percent-encodes every character of a path but the unreserved ones, more than Node's `pathToFileURL` does.
  private fileUri(path: string): string {
    return this.vscode ? `file://${path.split('/').map(segment => encodeURIComponent(segment).replaceAll(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}` : pathToFileURL(path).href
  }

  async open(path: string): Promise<Diagnostic[]> {
    const uri = this.uri(path)
    const published = this.diagnostics(uri)

    this.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: await Bun.file(join(this.root, path)).text() } })

    return published
  }

  async change(path: string, text: string, version: number): Promise<Diagnostic[]> {
    const uri = this.uri(path)
    const published = this.diagnostics(uri, version)

    this.connection.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })

    return published
  }

  async save(path: string): Promise<Diagnostic[]> {
    const published = this.diagnostics(this.uri(path))

    this.connection.notify('textDocument/didSave', { textDocument: { uri: this.uri(path) } })

    return published
  }

  // The diagnostics `path` gets next, open or not.
  async published(path: string): Promise<Diagnostic[]> {
    return this.diagnostics(this.uri(path))
  }

  // What the editor's file watcher reports: `path` changed on disk; the diagnostics `open` gets next.
  async filesChanged(open: string, events: { path: string, type: 1 | 2 | 3 }[]): Promise<Diagnostic[]> {
    const published = this.diagnostics(this.uri(open))

    this.connection.notify('workspace/didChangeWatchedFiles', { changes: events.map(event => ({ uri: this.uri(event.path), type: event.type })) })

    return published
  }

  async request<Result>(method: string, path: string, line: number, character: number): Promise<Result> {
    return this.connection.request<Result>(method, { textDocument: { uri: this.uri(path) }, position: { line, character } })
  }

  async rename(path: string, line: number, character: number, newName: string): Promise<Record<string, Range[]>> {
    const { changes = {} } = await this.connection.request<WorkspaceEdit>('textDocument/rename', { textDocument: { uri: this.uri(path) }, position: { line, character }, newName })

    return Object.fromEntries(Object.entries(changes).map(([uri, edits]) => [uri.slice(this.fileUri(this.root).length + 1), sortRanges(edits.map(edit => edit.range))]))
  }

  write(data: string) {
    void this.process.stdin.write(data)
    void this.process.stdin.flush()
  }

  async stop() {
    await this.connection.request('shutdown')
    this.connection.notify('exit')
    await this.process.exited
  }

  private async diagnostics(uri: string, version?: number): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      this.waiting.set(uri, { resolve, version })
    })
  }
}

// Waits until no publish came for a while, however slow the machine.
async function settled(editor: Editor) {
  for (let seen = -1; seen !== editor.publishes.length;) {
    seen = editor.publishes.length
    await Bun.sleep(DIAGNOSTICS_DELAY * 3)
  }
}

// `[line, start, end]` for a one-line range, in source order.
function spots(ranges: Range[]): number[][] {
  return sortRanges(ranges).map(range => [range.start.line, range.start.character, range.end.character])
}

function sortRanges(ranges: Range[]): Range[] {
  return ranges.toSorted((a, b) => a.start.line - b.start.line || a.start.character - b.start.character)
}

function brief(diagnostics: Diagnostic[]) {
  return diagnostics.map(diagnostic => ({ ...diagnostic.range, code: diagnostic.code }))
}

// What the editor gets of a diagnostic of kay check: its line from 0, LSP's severity, a TypeScript code as a number, the note and help on lines of their own.
function asPublished({ line, severity, code, message, note, help }: CheckDiagnostic) {
  const lines = [message, ...note === undefined ? [] : [`note: ${note}`], ...help === undefined ? [] : [`help: ${help}`]]

  return [line - 1, severity === 'warning' ? 2 : 1, code?.startsWith('TS') === true ? Number(code.slice(2)) : code, lines.join('\n')]
}

// Copies, as the editor writes its shadow tree into the project while check.test.ts and build.test.ts read the fixtures; side by side in one workspace, each a project of its own, as a monorepo's are.
const workspace = await scratchDir('lsp-fixtures-')

await Promise.all(['broken', 'site'].map(async name => cp(join(fixtures, name), join(workspace, name), { recursive: true, filter: source => !source.endsWith('/.kay') })))

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('kay lsp', () => {
  const editor = new Editor(workspace)

  beforeAll(async () => {
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
  })

  it('publishes type errors at the .kay source position and follows edits', async () => {
    const diagnostics = await editor.open('broken/src/routes/[id].kay')

    expect(brief(diagnostics)).toEqual([
      { start: { line: 1, character: 29 }, end: { line: 1, character: 33 }, code: 2339 },
      { start: { line: 4, character: 8 }, end: { line: 4, character: 11 }, code: 2551 },
    ])

    const fixed = await editor.change('broken/src/routes/[id].kay', '--- server\nconst id = Number(ctx.params.id)\nconst user = { name: \'Ada\', id }\n---\np {user.name}\n', 2)

    expect(fixed).toEqual([])
  })

  it('survives malformed frames and documents it cannot serve', async () => {
    editor.write('Content-Length: 5\r\n\r\n{nope')
    editor.connection.notify('textDocument/didOpen', { textDocument: { uri: 'vscode-vfs://github/x/page.kay', languageId: 'kay', version: 1, text: 'p Hi' } })

    expect(await editor.request('textDocument/hover', 'broken/src/routes/[id].kay', 4, 3)).not.toBeNull()
  })

  it('reports compile errors from the .kay compiler itself', async () => {
    const diagnostics = await editor.change('broken/src/routes/[id].kay', 'ul\n  for of [1, 2]\n    li x\n', 3)

    expect(diagnostics).toEqual([expect.objectContaining({ source: 'kay', range: expect.objectContaining({ start: { line: 1, character: 2 } }) })])
  })

  it('shows hover types for template expressions and server data', async () => {
    await editor.open('site/src/routes/index.kay')

    const hover = await editor.request<Hover>('textDocument/hover', 'site/src/routes/index.kay', 20, 6)

    expect(JSON.stringify(hover.contents)).toContain('open: number')
    expect(hover.range).toEqual({ start: { line: 20, character: 5 }, end: { line: 20, character: 9 } })
  })

  it('completes members inside template expressions, without the generated helpers', async () => {
    const list = await editor.request<CompletionList>('textDocument/completion', 'site/src/routes/index.kay', 23, 46)
    const labels = list.items.map(item => item.label)

    expect(labels).toContain('title')
    expect(labels).toContain('done')

    await editor.open('site/src/components/quick-add.kay')

    const scope = await editor.request<CompletionList>('textDocument/completion', 'site/src/components/quick-add.kay', 16, 22)
    const names = scope.items.map(item => item.label)

    expect(names).toEqual(expect.arrayContaining(['id', 'saved', 'submit', 'title']))
    expect(names).toContain('__dirname')
    expect(names.filter(name => name === '__props' || name.startsWith('Kay'))).toEqual([])
  })

  it('completes the keys of a page\'s settings', async () => {
    const path = 'site/src/routes/search.kay'
    const text = await Bun.file(join(workspace, path)).text()

    await editor.open(path)
    await editor.change(path, '--- server\nexport const page = { noindex: true,  }\n---\np x\n', 2)

    try {
      const list = await editor.request<CompletionList>('textDocument/completion', path, 1, 37)

      expect(list.items.map(item => item.label)).toEqual(expect.arrayContaining(['prerender?', 'revalidate?', 'layouts?', 'query?', 'sitemap?']))
    }
    finally {
      await editor.change(path, text, 3)
    }
  })

  it('goes to definitions across .kay files', async () => {
    const [action] = await editor.request<LocationLink[]>('textDocument/definition', 'site/src/components/quick-add.kay', 9, 19)

    expect(action).toMatchObject({ targetUri: editor.uri('site/src/routes/index.kay'), targetSelectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 16 } } })

    const [component] = await editor.request<LocationLink[]>('textDocument/definition', 'site/src/routes/index.kay', 31, 2)

    expect(component?.targetUri).toBe(editor.uri('site/src/components/counter.kay'))
  })

  it('goes from a server value in the template to its declaration in the server fence, and to nothing else', async () => {
    const open = await editor.request<LocationLink[]>('textDocument/definition', 'site/src/routes/index.kay', 20, 6)

    expect(open.map(link => [link.targetUri, ...spots([link.targetSelectionRange])[0]!])).toEqual([[editor.uri('site/src/routes/index.kay'), 13, 6, 10]])
  })

  it('finds references across .kay files, a server value\'s reads in the template included', async () => {
    await editor.open('site/src/components/quick-add.kay')

    const add = await editor.connection.request<Location[]>('textDocument/references', { textDocument: { uri: editor.uri('site/src/routes/index.kay') }, position: { line: 5, character: 14 }, context: { includeDeclaration: true } })
    const open = await editor.connection.request<Location[]>('textDocument/references', { textDocument: { uri: editor.uri('site/src/routes/index.kay') }, position: { line: 13, character: 7 }, context: { includeDeclaration: true } })

    expect(spots(add.filter(location => location.uri === editor.uri('site/src/routes/index.kay')).map(location => location.range))).toEqual([[5, 13, 16], [14, 27, 30], [24, 19, 22]])
    expect(spots(add.filter(location => location.uri === editor.uri('site/src/components/quick-add.kay')).map(location => location.range))).toEqual([[2, 9, 12], [9, 18, 21]])
    expect(spots(open.map(location => location.range))).toEqual([[13, 6, 10], [20, 5, 9], [31, 15, 19]])
    expect(spots((await editor.request<DocumentHighlight[]>('textDocument/documentHighlight', 'site/src/routes/index.kay', 20, 6)).map(highlight => highlight.range))).toEqual([[13, 6, 10], [20, 5, 9], [31, 15, 19]])
  })

  it('renames a name everywhere the user wrote it, from either end, and nothing generated', async () => {
    const open = [[13, 6, 10], [20, 5, 9], [31, 15, 19]]

    const fromDeclaration = await editor.rename('site/src/routes/index.kay', 13, 7, 'pending')

    expect(Object.keys(fromDeclaration)).toEqual(['site/src/routes/index.kay'])
    expect(spots(fromDeclaration['site/src/routes/index.kay']!)).toEqual(open)
    expect(spots((await editor.rename('site/src/routes/index.kay', 20, 6, 'pending'))['site/src/routes/index.kay']!)).toEqual(open)
    // A loop's item is generated into both its key function and its row.
    expect(spots((await editor.rename('site/src/routes/index.kay', 22, 9, 'item'))['site/src/routes/index.kay']!)).toEqual([[22, 8, 12], [22, 27, 31], [23, 28, 32], [23, 41, 45]])

    await editor.open('site/src/components/card.kay')

    const title = await editor.rename('site/src/components/card.kay', 3, 9, 'heading')

    expect(spots(title['site/src/components/card.kay']!)).toEqual([[3, 8, 13], [3, 26, 31], [6, 6, 11]])
    expect(spots(title['site/src/routes/index.kay']!)).toEqual([[19, 5, 10]])
    expect(await editor.request('textDocument/prepareRename', 'site/src/routes/index.kay', 22, 5)).toBeNull()
  })

  it('renames a generic component\'s type parameter from its fence line and from its uses', async () => {
    await editor.open('site/src/components/list.kay')

    const uses = [[0, 5, 6], [1, 39, 40], [1, 57, 58]]

    expect(spots((await editor.rename('site/src/components/list.kay', 0, 5, 'Item'))['site/src/components/list.kay']!)).toEqual(uses)
    expect(spots((await editor.rename('site/src/components/list.kay', 1, 57, 'Item'))['site/src/components/list.kay']!)).toEqual(uses)
    expect(JSON.stringify((await editor.request<Hover>('textDocument/hover', 'site/src/components/list.kay', 0, 5)).contents)).toContain('T')
  })

  it('shows the signature of the call under the cursor', async () => {
    const help = await editor.request<{ signatures: { label: string }[] }>('textDocument/signatureHelp', 'site/src/components/quick-add.kay', 9, 28)

    expect(help.signatures[0]!.label).toBe('add(input: { title: string; }, options?: CallOptions): Promise<number>')
  })

  it('formats a .kay document as one whole-document edit', async () => {
    await editor.open('site/src/routes/about.kay')
    await editor.change('site/src/routes/about.kay', 'div\n    p( class = \'x\' ) Hi\n', 2)

    const edits = await editor.connection.request<TextEdit[]>('textDocument/formatting', { textDocument: { uri: editor.uri('site/src/routes/about.kay') }, options: { tabSize: 2, insertSpaces: true } })

    expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'div\n  p(class="x") Hi\n' }])
  })

  it('reports what kay check does, at its level and worded as it words it, and nothing a `// kay-allow` comment allows', async () => {
    const page = 'site/src/routes/lints.kay'
    const source = [
      '---',
      'const { todos } = props<{ todos: { id: number }[] }>()',
      '// kay-allow unread-name',
      'const idle = 1',
      'const posts = signal([{ slug: \'a\' }])',
      'const open = () => true',
      '---',
      'for todo, i of todos key={i}',
      '  p {i}. {todo.id}',
      'for todo, i of todos key={i}',
      '  p {todo.id}',
      'for post of posts()',
      '  button(onClick={() => posts.set([])}) {post.slug}',
      'if open',
      '  span on',
      '',
    ].join('\n')

    await Bun.write(join(workspace, page), source)

    const published = (await editor.open(page)).map(({ range, severity, code, message }) => [range.start.line, severity, code, message])
    const checked = (await check(join(workspace, 'site'))).filter(diagnostic => diagnostic.file === join(workspace, page)).map(asPublished)

    // The index of a positionally keyed for whose rows do not read it is no unread name.
    expect(published.map(([line, severity, code]) => [line, severity, code])).toEqual([[7, 2, 'positional-key'], [9, 2, 'positional-key'], [11, 2, 'identity-key'], [13, 1, 2774]])
    expect(published).toEqual(checked)
    // That index renames with its key.
    expect(spots((await editor.rename(page, 9, 10, 'index'))[page]!)).toEqual([[9, 10, 11], [9, 26, 27]])
  })
})

// Applies an editor's edits to a text, last first so earlier offsets stay valid.
function applyEdits(text: string, edits: TextEdit[]): string {
  const offsetOf = ({ line, character }: { line: number, character: number }) => text.split('\n').slice(0, line).reduce((sum, lineText) => sum + lineText.length + 1, 0) + character

  return edits.map(edit => ({ ...edit, start: offsetOf(edit.range.start), end: offsetOf(edit.range.end) })).sort((a, b) => b.start - a.start).reduce((result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end), text)
}

// Outside this checkout, whose `node_modules/kay` links back to it: tsgo would take a fixture's modules for the `kay` package's own and offer no import of them.
describe('kay lsp imports', () => {
  let editor: Editor
  let dir: string
  const page = 'src/routes/index.kay'

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kay-imports-'))
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'imports', type: 'module', dependencies: { 'kay': '*', 'kay-lib': '*', '@iconify-json/tabler': '*' } })),
      // A kay library, its components given specifiers by its exports map.
      Bun.write(join(dir, 'node_modules/kay-lib/package.json'), JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' } })),
      Bun.write(join(dir, 'node_modules/kay-lib/src/tag-pill.kay'), '---\nconst { label } = props<{ label: string }>()\n---\nspan.pill {label}\n'),
      Bun.write(join(dir, 'node_modules/kay-lib/src/unused-pill.kay'), '---\nconst count: number = \'one\'\n---\nspan.pill {count}\n'),
      Bun.write(join(dir, 'node_modules/kay-lib/src/broken-pill.kay'), 'div(\n  p {a\n'),
      Bun.write(join(dir, 'src/actions.ts'), 'import { action } from \'kay\'\n\nexport const add = action(() => 1)\n'),
      Bun.write(join(dir, 'src/data.ts'), 'export function listTodos(): string[] {\n  return []\n}\n'),
      Bun.write(join(dir, 'src/badge.kay'), 'span.badge New\n'),
      Bun.write(join(dir, page), 'p Home\n'),
      // A config that fails to load leaves the defaults; every test below runs against it.
      Bun.write(join(dir, 'kay.config.ts'), 'throw new Error(\'Broken config\')\n'),
    ])
    // Every package of this checkout, and kay as a copy installed there: tsgo offers no import from a package whose files sit outside node_modules.
    await Promise.all((await readdir(join(import.meta.dir, '../node_modules'))).filter(name => name !== 'kay' && name !== '.bin').map(async name => symlink(join(import.meta.dir, '../node_modules', name), join(dir, 'node_modules', name))))
    await cp(join(import.meta.dir, '../src'), join(dir, 'node_modules/kay/src'), { recursive: true })
    // Without the `types` build a packed kay carries, each export resolves to its source.
    const manifest = await Bun.file(join(import.meta.dir, '../package.json')).json() as { exports: Record<string, Record<string, string>> }

    await Bun.write(join(dir, 'node_modules/kay/package.json'), JSON.stringify({ ...manifest, exports: Object.fromEntries(Object.entries(manifest.exports).map(([path, { types: _types, ...conditions }]) => [path, conditions])) }))
    editor = new Editor(dir)
    await editor.start()
    await editor.open(page)
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('adds the import a completion brings to the fence the name is used from', async () => {
    const source = '--- server\nconst todos = listTo\n---\np {todos.length}\n'

    await editor.change(page, source, 2)

    const list = await editor.request<CompletionList>('textDocument/completion', page, 1, 20)
    const item = await editor.connection.request<CompletionItem>('completionItem/resolve', list.items.find(entry => entry.label === 'listTodos'))

    expect(applyEdits(source, item.additionalTextEdits ?? [])).toBe('--- server\nimport { listTodos } from \'../data\'\nconst todos = listTo\n---\np {todos.length}\n')
  })

  it('adds a new import after the fence\'s own and in their style, wherever tsgo puts it', async () => {
    const source = '---\nimport { add } from \'../actions\'\nconst count = signa\n---\nform(action={add})\n  button Add\n'

    await editor.change(page, source, 5)

    const list = await editor.request<CompletionList>('textDocument/completion', page, 2, 19)
    const item = await editor.connection.request<CompletionItem>('completionItem/resolve', list.items.find(entry => entry.label === 'signal'))

    expect(applyEdits(source, item.additionalTextEdits ?? [])).toBe('---\nimport { add } from \'../actions\'\nimport { signal } from \'kay\'\nconst count = signa\n---\nform(action={add})\n  button Add\n')
  })

  it('completes an import specifier while its quote is still open, an icon\'s included', async () => {
    const source = '---\nimport BrandGithub from \'~icons/tabler/brand\n---\np x\n'

    await editor.change(page, source, 9)

    const list = await editor.request<CompletionList>('textDocument/completion', page, 1, 44)

    expect(list.items.map(item => item.label)).toContain('brand-github')

    const typing = '---\nimport BrandGithub from \'~icons/tabler/brand\nconst todos = listTo\n---\np {todos.length}\n'

    await editor.change(page, typing, 10)

    const names = await editor.request<CompletionList>('textDocument/completion', page, 2, 20)
    const item = await editor.connection.request<CompletionItem>('completionItem/resolve', names.items.find(entry => entry.label === 'listTodos'))

    expect(applyEdits(typing, item.additionalTextEdits ?? [])).toBe('---\nimport { listTodos } from \'../data\'\nimport BrandGithub from \'~icons/tabler/brand\nconst todos = listTo\n---\np {todos.length}\n')
  })

  it('types a template read of a signal as with a fence that parses, while a statement of the fence is being typed', async () => {
    const hoverOf = async (source: string) => {
      await editor.change(page, source, 20)

      return JSON.stringify((await editor.request<Hover>('textDocument/hover', page, 5, 5)).contents)
    }

    const parsed = await hoverOf('---\nconst items = signal([1, 2])\nconst total = items.length\n---\nfor row of items\n  p {row}\n')
    const typing = await hoverOf('---\nconst items = signal([1, 2])\nconst total = items.\n---\nfor row of items\n  p {row}\n')

    expect(parsed).toContain('number')
    expect(typing).toBe(parsed)
  })

  it('types a library component, goes to its .kay source and imports it as a quick fix', async () => {
    const source = '---\nimport TagPill from \'kay-lib/tag-pill.kay\'\n---\nTagPill(label={1})\n'
    const diagnostics = await editor.change(page, source, 7)
    const definition = await editor.request<LocationLink[]>('textDocument/definition', page, 3, 2)

    expect(brief(diagnostics)).toEqual([{ start: { line: 3, character: 8 }, end: { line: 3, character: 13 }, code: 2322 }])
    expect(definition.map(link => [link.targetUri.slice(editor.uri('').length), link.targetSelectionRange.start.line])).toEqual([['/node_modules/kay-lib/src/tag-pill.kay', 0]])

    const missing = 'TagPill(label="x")\n'
    const found = await editor.change(page, missing, 8)
    const actions = await editor.connection.request<CodeAction[]>('textDocument/codeAction', { textDocument: { uri: editor.uri(page) }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, context: { diagnostics: found } })

    expect(actions.map(action => applyEdits(missing, action.edit!.changes![editor.uri(page)]!))).toContain('---\nimport TagPill from \'kay-lib/tag-pill.kay\'\n---\nTagPill(label="x")\n')
  })

  it('adds a missing import as a quick fix, opening a script fence when there is none', async () => {
    const fixes = async (source: string, version: number) => {
      const diagnostics = await editor.change(page, source, version)
      const actions = await editor.connection.request<CodeAction[]>('textDocument/codeAction', { textDocument: { uri: editor.uri(page) }, range: { start: { line: source.split('\n').indexOf('Badge'), character: 0 }, end: { line: source.split('\n').indexOf('Badge'), character: 5 } }, context: { diagnostics } })

      return actions.map(action => ({ title: action.title, text: applyEdits(source, action.edit!.changes![editor.uri(page)]!) }))
    }

    expect(await fixes('Badge\n', 3)).toEqual([{ title: 'Add import from "../badge.kay"', text: '---\nimport Badge from \'../badge.kay\'\n---\nBadge\n' }])
    expect(await fixes('---\nimport { signal } from \'kay\'\n---\nBadge\n', 4)).toEqual([{ title: 'Add import from "../badge.kay"', text: '---\nimport { signal } from \'kay\'\nimport Badge from \'../badge.kay\'\n---\nBadge\n' }])
  })

  it('reports a browser-only global read while rendering next to the type errors, fixed with an effect or `--- client`', async () => {
    const source = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nlocalStorage.clear()\n---\np {count().missing}\nbutton(onClick={() => count.set(1)}) +\n'
    const diagnostics = await editor.change(page, source, 6)
    const line = { start: { line: 4, character: 0 }, end: { line: 4, character: 12 } }
    const actions = await editor.connection.request<CodeAction[]>('textDocument/codeAction', { textDocument: { uri: editor.uri(page) }, range: line, context: { diagnostics } })

    expect(diagnostics.map(diagnostic => diagnostic.source === 'kay' ? diagnostic.message : diagnostic.code)).toEqual(['`localStorage` exists only in the browser\nnote: this reads it while the component renders on the server too\nhelp: read it in `effect` or `onMount`, or render the component in the browser only with `--- client`', 2339])
    expect(actions.map(action => ({ title: action.title, text: applyEdits(source, action.edit!.changes![editor.uri(page)]!) }))).toEqual([
      { title: 'Read `localStorage` in an effect, once the component renders in the browser', text: source.replace('localStorage.clear()', 'effect(() => localStorage.clear())') },
      { title: 'Render the component in the browser only with `--- client`', text: source.replace('---', '--- client') },
    ])
  })

  it('reports unused imports, declarations, props and server values as errors, a prop with its fix', async () => {
    const source = '---\nimport { effect, signal } from \'kay\'\n\nconst { title, subtitle } = props<{ title: string, subtitle?: string }>()\nconst count = signal(0)\nconst idle = 1\n---\np {title} {count()}\nbutton(onClick={() => count.set(1)}) +\n'
    const diagnostics = await editor.change(page, source, 7)

    const actions = await editor.connection.request<CodeAction[]>('textDocument/codeAction', { textDocument: { uri: editor.uri(page) }, range: diagnostics[0]!.range, context: { diagnostics } })

    expect(diagnostics.map(diagnostic => [diagnostic.range.start.line, diagnostic.severity, diagnostic.message])).toEqual([
      [3, 1, 'The prop `subtitle` is never read'],
      [1, 1, '\'effect\' is declared but its value is never read.'],
      [5, 1, '\'idle\' is declared but its value is never read.'],
    ])
    expect(actions.map(action => ({ title: action.title, text: applyEdits(source, action.edit!.changes![editor.uri(page)]!) }))).toContainEqual({ title: 'Remove `subtitle`', text: source.replace('title, subtitle }', 'title }') })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.tags])).toEqual([['unread-name', [1]], ['unread-name', [1]], ['unread-name', [1]]])
  })

  // Last, as opening another file publishes the page's diagnostics again, which a later change would take for its own.
  it('leaves the errors of a library component the app never imports to the library, as kay check does', async () => {
    expect(await editor.open('node_modules/kay-lib/src/unused-pill.kay')).toEqual([])
    expect(await editor.open('node_modules/kay-lib/src/broken-pill.kay')).toEqual([])
  })
})

describe('kay lsp following the project on disk', () => {
  let editor: Editor
  let dir: string
  let real: string
  const entry = 'src/content/notes/a.md'
  const page = 'src/routes/home.kay'
  const codes = (diagnostics: Diagnostic[]) => diagnostics.map(diagnostic => diagnostic.code)
  let first: Record<string, Promise<Diagnostic[]>>

  beforeAll(async () => {
    real = await mkdtemp(join(tmpdir(), 'kay-project-'))

    // Opened through a symlink, while Bun keys the modules a config read again must import afresh by real path, and from under a `.kay` directory, which only the project's own is.
    dir = join(await scratchDir('lsp-'), 'project')
    await symlink(real, dir)
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ lints: { \'no-such-lint\': \'deny\' }, i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\' } })\n'),
      Bun.write(join(dir, 'src/messages/fr.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Bonjour\' })\n'),
      Bun.write(join(dir, 'src/messages/en.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n'),
      Bun.write(join(dir, 'src/content.config.ts'), 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: t.Object({ title: t.String() }) })\n'),
      Bun.write(join(dir, entry), '---\ndate: today\n---\nText\n'),
      Bun.write(join(dir, 'src/routes/_guard.ts'), 'export default 42\n'),
      Bun.write(join(dir, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'src/data.ts'), 'export const n: number = 1\n'),
      Bun.write(join(dir, page), '---\nimport { n } from \'../data\'\nimport Badge from \'../badge.kay\'\n\nconst s: string = n\n---\nBadge\np {s}\n'),
    ])
    await mkdir(join(dir, 'node_modules'))
    await Promise.all((await readdir(join(import.meta.dir, '../node_modules'))).filter(name => name !== '.bin').map(async name => symlink(join(import.meta.dir, '../node_modules', name), join(dir, 'node_modules', name))))
    editor = new Editor(dir)
    first = Object.fromEntries(['kay.config.ts', 'src/messages/en.ts', entry, 'src/routes/_guard.ts'].map(path => [path, editor.published(path)]))
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
    await Promise.all([rm(dirname(dir), { recursive: true, force: true }), rm(real, { recursive: true, force: true })])
  })

  it('reports the config, the messages, the collections and the exports kay check reads, at their files, once it started and after a change on disk', async () => {
    const [config, messages, entries, guard] = await Promise.all(Object.values(first))

    expect(config!.map(diagnostic => diagnostic.message)).toEqual(['`lints` names `no-such-lint`, which is no lint or group\nhelp: `kay explain` lists them'])
    expect(messages!.map(diagnostic => diagnostic.message)).toEqual([expect.stringContaining('hello')])
    expect(entries!.map(diagnostic => diagnostic.range.start.line)).toEqual([0])
    expect(guard!.map(diagnostic => diagnostic.message)).toEqual([expect.stringMatching(/^It must export a guard by default: /)])

    await Bun.write(join(dir, entry), '---\ntitle: A\n---\nText\n')
    expect(await editor.filesChanged(entry, [{ path: entry, type: 2 }])).toEqual([])
  })

  it('reads the config again, and what guards export, once either changes on disk', async () => {
    const config = 'kay.config.ts'
    const messages = (diagnostics: Diagnostic[]) => diagnostics.map(diagnostic => diagnostic.message)
    const written = async (lints: string) => Bun.write(join(dir, config), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ lints: { ${lints} }, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' } })\n`)

    await written('')
    expect(await editor.filesChanged(config, [{ path: config, type: 2 }])).toEqual([])

    await written('\'other-lint\': \'warn\'')
    expect(messages(await editor.filesChanged(config, [{ path: config, type: 2 }]))).toEqual(['`lints` names `other-lint`, which is no lint or group\nhelp: `kay explain` lists them'])

    await rm(join(dir, 'src/routes/_guard.ts'))
    expect(await editor.filesChanged('src/routes/_guard.ts', [{ path: 'src/routes/_guard.ts', type: 3 }])).toEqual([])

    await Promise.all([Bun.write(join(dir, 'src/routes/sub/_guard.ts'), 'export default 1\n'), Bun.write(join(dir, 'src/routes/sub/index.kay'), 'h1 Sub\n')])
    expect(messages(await editor.filesChanged('src/routes/sub/_guard.ts', [{ path: 'src/routes/sub/_guard.ts', type: 1 }, { path: 'src/routes/sub/index.kay', type: 1 }]))).toEqual([expect.stringMatching(/^It must export a guard by default: /)])
  })

  it('sees a component created or deleted on disk, on save or from the file watcher', async () => {
    expect(codes(await editor.open(page))).toEqual([2307, 2322])

    await Bun.write(join(dir, 'src/badge.kay'), 'span.badge New\n')
    expect(codes(await editor.save(page))).toEqual([2322])

    await rm(join(dir, 'src/badge.kay'))
    expect(codes(await editor.filesChanged(page, [{ path: 'src/badge.kay', type: 3 }]))).toEqual([2307, 2322])

    await Bun.write(join(dir, 'src/badge.kay'), 'span.badge New\n')
    expect(codes(await editor.filesChanged(page, [{ path: 'src/badge.kay', type: 1 }]))).toEqual([2322])
  })

  it('sees a module a component imports change on disk', async () => {
    await Bun.write(join(dir, 'src/data.ts'), 'export const n: string = \'1\'\n')

    expect(await editor.filesChanged(page, [{ path: 'src/data.ts', type: 2 }])).toEqual([])
  })

  it('lets a static component only islands render pass functions to interactive children, until a page renders it too', async () => {
    const wrapper = 'src/components/wrapper.kay'

    await Promise.all([
      Bun.write(join(dir, 'src/components/controls.ts'), 'export interface Controls {\n  pick: (value: string) => void\n}\n'),
      Bun.write(join(dir, 'src/components/panel.kay'), '---\nimport type { Controls } from \'./controls\'\n\nconst { controls } = props<{ controls: Controls }>()\n---\nbutton(type="button" onClick={() => controls.pick("a")}) a\n'),
      Bun.write(join(dir, wrapper), '---\nimport type { Controls } from \'./controls\'\nimport Panel from \'./panel.kay\'\n\nconst { controls } = props<{ controls: Controls }>()\n---\nPanel(controls={controls})\n'),
      Bun.write(join(dir, 'src/components/board.kay'), '---\nimport { signal } from \'kay\'\nimport Wrapper from \'./wrapper.kay\'\n\nconst picked = signal(\'none\')\n---\np {picked()}\nWrapper(controls={{ pick: value => picked.set(value) }})\n'),
      Bun.write(join(dir, 'src/routes/board.kay'), '---\nimport Board from \'../components/board.kay\'\n---\nBoard\n'),
    ])
    // Opened before the server hears of the files, it compiles as a static component would, until they reach it.
    await editor.open(wrapper)
    expect(await editor.filesChanged(wrapper, [{ path: 'src/components/wrapper.kay', type: 1 }])).toEqual([])

    await Bun.write(join(dir, 'src/routes/plain.kay'), '---\nimport Wrapper from \'../components/wrapper.kay\'\n---\nWrapper(controls={{ pick: () => {} }})\n')
    expect(codes(await editor.filesChanged(wrapper, [{ path: 'src/routes/plain.kay', type: 1 }]))).toEqual([2345])
  })

  // Last, as a module changing publishes the open files again once tsgo asks, which a later wait would take for its own.
  it('compiles an open component again once a module it imports exports a signal, and publishes it', async () => {
    const component = 'src/components/cart-count.kay'

    await Promise.all([Bun.write(join(dir, 'src/cart.ts'), 'export const cart = [1]\n'), Bun.write(join(dir, component), '---\nimport { cart } from \'../cart\'\n---\np {cart.length}\n')])
    expect(await editor.open(component)).toEqual([])

    await Bun.write(join(dir, 'src/cart.ts'), 'import { signal } from \'kay\'\n\nexport const cart = signal([1])\n')
    expect(codes(await editor.filesChanged(component, [{ path: 'src/cart.ts', type: 2 }]))).toEqual(['uncalled-signal'])
  })
})

describe('kay lsp for a client that supports diagnostic refreshes', () => {
  let editor: Editor
  let dir: string
  const page = 'src/routes/a.kay'

  beforeAll(async () => {
    dir = await scratchDir('lsp-refresh-')
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, page), 'p x\n'),
    ])
    editor = new Editor(dir, false, { workspace: { diagnostics: { refreshSupport: true } } })
    await editor.start()
    await editor.open(page)
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('publishes each edit once, with no second publish from tsgo', async () => {
    const uri = editor.uri(page)

    // A save or a file changing on disk makes tsgo ask for a refresh, which edits do not.
    editor.connection.notify('textDocument/didSave', { textDocument: { uri } })
    await settled(editor)
    for (const version of [2, 3]) {
      await Bun.sleep(DIAGNOSTICS_DELAY * 2)
      await editor.change(page, `--- server\nconst n: string = ${version}\n---\np {n}\n`, version)
      await settled(editor)
      expect(editor.publishes.filter(entry => entry.uri === uri && entry.version === version)).toHaveLength(1)
    }
  })
})

// In process, holding the debounce's timer, so the test ends each quiet spell itself and no publish has a clock to beat.
describe('kay lsp framing', () => {
  it('reads a message that comes in many small chunks, and several in one, whole', async () => {
    const encoder = new TextEncoder()
    const big = JSON.stringify({ jsonrpc: '2.0', method: 'big', params: { text: 'é'.repeat(4_000_000) } })
    const small = JSON.stringify({ jsonrpc: '2.0', method: 'small', params: { n: 1 } })
    const frame = (body: string) => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    const bytes = encoder.encode(frame(big) + frame(small) + frame(small))
    const received: string[] = []
    const { promise, resolve } = Promise.withResolvers<void>()
    const connection = new Connection(new ReadableStream<Uint8Array>({
      start(controller) {
        // Cut anywhere, inside a character and a header too.
        for (let at = 0; at < bytes.length; at += 997)
          controller.enqueue(bytes.slice(at, at + 997))
        controller.close()
      },
    }), () => undefined)

    connection.onNotification<{ text?: string }>('big', ({ text }) => received.push(`big ${text?.length}`))
    connection.onNotification('small', () => {
      received.push('small')

      if (received.length === 3)
        resolve()
    })

    const started = performance.now()

    await promise
    expect(received).toEqual(['big 4000000', 'small', 'small'])
    // Joining the chunks again with each one took seconds at this size.
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('kay lsp debouncing its diagnostics', () => {
  it('publishes the first change after a quiet spell at once, and a burst once its spell ends, without the versions between', async () => {
    const dir = await scratchDir('lsp-debounce-')
    const page = 'src/routes/a.kay'
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))
    const realSetTimeout = globalThis.setTimeout
    // The timer of each change, the last one the spell running; a change in it only moves it.
    const spells: (() => void)[] = []
    let held: { count: number, resolve: () => void } | undefined
    const changesHeld = async (count: number) => new Promise<void>((resolve) => {
      held = { count, resolve }

      if (spells.length >= count)
        resolve()
    })
    const endSpell = () => spells.at(-1)!()
    const published: (number | undefined)[] = []
    const waiting = new Map<number, () => void>()
    const publishOf = async (version: number) => new Promise<void>((resolve) => {
      waiting.set(version, resolve)
    })

    await Promise.all([Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()), Bun.write(join(dir, page), 'p x\n')])

    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay !== DIAGNOSTICS_DELAY)
        return realSetTimeout(callback, delay, ...rest)

      spells.push(callback)

      if (held && spells.length >= held.count)
        held.resolve()

      return realSetTimeout(() => undefined, 0)
    }) as typeof setTimeout)

    try {
      const uri = pathToFileURL(join(dir, page)).href
      const change = (version: number) => client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: `p {missing${version}}\n` }] })

      client.onNotification<{ version?: number }>('textDocument/publishDiagnostics', ({ version }) => {
        published.push(version)

        if (version !== undefined)
          waiting.get(version)?.()
      })
      await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} })
      client.notify('initialized', {})

      const opened = publishOf(1)

      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: 'p x\n' } })
      await opened
      endSpell()

      // Its spell never ends, so only skipping the wait publishes it.
      const quiet = publishOf(2)

      change(2)
      await quiet

      const burst = publishOf(4)

      change(3)
      change(4)
      await changesHeld(4)
      // However long it waits, a held spell publishes nothing.
      await Bun.sleep(DIAGNOSTICS_DELAY * 2)
      expect(published).toEqual([1, 2])
      endSpell()
      await burst
      expect(published).toEqual([1, 2, 4])
    }
    finally {
      timers.mockRestore()
      // `exit` would end the test run too.
      const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

      tsgo?.process.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('kay lsp on a save', () => {
  it('writes the shadow tree once for the save notice and the watcher event, and tells tsgo of the shadow files that changed alone', async () => {
    const dir = await scratchDir('lsp-save-')
    const page = 'src/routes/a.kay'
    const other = 'src/routes/b.kay'
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))
    const writes = spyOn(server as unknown as { writeShadows: () => Promise<unknown[]> }, 'writeShadows')

    await Promise.all([Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()), Bun.write(join(dir, page), 'p x\n'), Bun.write(join(dir, other), 'p y\n')])

    try {
      const uri = pathToFileURL(join(dir, page)).href

      await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} })
      client.notify('initialized', {})
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: 'p x\n' } })
      await Bun.sleep(300)
      writes.mockClear()

      const tsgo = (server as unknown as { tsgo: { connection: Connection } }).tsgo.connection
      const told: string[][] = []
      const notify = spyOn(tsgo, 'notify').mockImplementation((method: string, params?: unknown) => {
        if (method === 'workspace/didChangeWatchedFiles')
          told.push((params as { changes: { uri: string }[] }).changes.map(change => change.uri))
      })

      await Bun.write(join(dir, page), 'p changed\n')
      client.notify('textDocument/didSave', { textDocument: { uri } })
      client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 2 }] })
      await Bun.sleep(500)
      notify.mockRestore()

      expect(writes).toHaveBeenCalledTimes(1)
      expect(told).toHaveLength(1)
      expect(told[0]!.filter(changed => changed.endsWith('.kay.tsx'))).toEqual([pathToFileURL(join(dir, '.kay/types', `${page}.tsx`)).href])
    }
    finally {
      // `exit` would end the test run too.
      const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

      tsgo?.process.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tells tsgo of a shadow file rewritten at the same size, and of nothing when a save changed none', async () => {
    const dir = await scratchDir('lsp-stamp-')
    const page = 'src/routes/a.kay'
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))

    await Promise.all([Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()), Bun.write(join(dir, page), 'p x\n')])

    try {
      const uri = pathToFileURL(join(dir, page)).href
      const shadow = pathToFileURL(join(dir, '.kay/types', `${page}.tsx`)).href

      await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} })
      client.notify('initialized', {})
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: 'p x\n' } })
      await Bun.sleep(300)

      const tsgo = (server as unknown as { tsgo: { connection: Connection } }).tsgo.connection
      const told: string[][] = []
      const notify = spyOn(tsgo, 'notify').mockImplementation((method: string, params?: unknown) => {
        if (method === 'workspace/didChangeWatchedFiles')
          told.push((params as { changes: { uri: string }[] }).changes.map(change => change.uri).filter(changed => changed.endsWith('.kay.tsx')))
      })
      const save = async () => {
        client.notify('textDocument/didSave', { textDocument: { uri } })
        await Bun.sleep(300)
      }

      await Bun.write(join(dir, page), 'p y\n')
      await save()
      await save()
      await Bun.write(join(dir, page), 'p x\n')
      await save()
      notify.mockRestore()

      expect(told).toEqual([[shadow], [], [shadow]])
    }
    finally {
      const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

      tsgo?.process.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // The texts of the open page the server hands tsgo again as `saves` are made one after another, each as a change of `layout` on disk, a save of `sibling` first when it names one.
  async function compiledAfter(dir: string, { page, layout, saves, files = {}, project = dir, sibling }: { page: string, layout: string, saves: string[], files?: Record<string, string>, project?: string, sibling?: string }): Promise<{ compiled: string[], layoutReads: number }> {
    const source = '--- server\nconst query = ctx.query\n---\np {String(query)}\n'
    // The disk holds another text than the editor, so a read of the open page's text is the server's own.
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))

    await Promise.all([Bun.write(join(project, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()), Bun.write(join(project, page), `${source}p disk\n`), Bun.write(layout, 'slot\n'), ...Object.entries(files).map(async ([path, text]) => Bun.write(path, text))])

    try {
      const uri = pathToFileURL(join(project, page)).href

      await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(project).href, capabilities: {} })
      client.notify('initialized', {})
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: source } })
      await Bun.sleep(300)

      const tsgo = (server as unknown as { tsgo: { connection: Connection } }).tsgo.connection
      const compiled: string[] = []
      const queries = spyOn(shadowModule, 'layoutQueries')
      const notify = spyOn(tsgo, 'notify').mockImplementation((method: string, params?: unknown) => {
        if (method === 'textDocument/didChange')
          compiled.push((params as { contentChanges: { text: string }[] }).contentChanges[0]!.text)
      })
      const save = async (file: string, text: string) => {
        await Bun.write(file, text)
        client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(file).href, type: 2 }] })
        await Bun.sleep(400)
      }

      if (sibling !== undefined)
        await save(join(project, sibling), 'p changed\n')

      for (const text of saves)
        await save(layout, text)

      const layoutReads = queries.mock.calls.filter(([file, text]) => file === join(project, page) && !text.includes('p disk')).length

      notify.mockRestore()
      queries.mockRestore()

      return { compiled, layoutReads }
    }
    finally {
      const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

      tsgo?.process.kill()
    }
  }

  const withQuery = '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ q: s.String() }) }\n---\nslot\n'

  it('compiles an open page again when a layout above it gains or drops a query', async () => {
    const dir = await scratchDir('lsp-layout-query-')

    try {
      const { compiled } = await compiledAfter(dir, { page: 'src/routes/a.kay', layout: join(dir, 'src/routes/_layout.kay'), saves: [withQuery, withQuery.replace('q: s.String()', 'q: s.Integer()'), 'slot\n'] })

      expect(compiled).toHaveLength(2)
      expect(compiled[0]).toContain('_layout.kay')
      expect(compiled[1]).not.toContain('_layout.kay')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('compiles an open page again when a layout an extension mounts above it gains or drops a query', async () => {
    const dir = await scratchDir('lsp-layout-mounted-')
    const app = join(dir, 'app')

    try {
      const { compiled } = await compiledAfter(dir, {
        project: app,
        page: 'src/routes/lib/a.kay',
        layout: join(dir, 'lib/routes/_layout.kay'),
        files: { [join(app, 'kay.config.ts')]: 'export default { extensions: [{ name: \'lib\', routes: { dir: \'../lib/routes\', prefix: \'/lib\' } }] }\n', [join(dir, 'lib/routes/index.kay')]: 'p lib\n', [join(dir, 'lib/package.json')]: '{ "name": "lib" }\n' },
        saves: [withQuery, 'slot\n'],
      })

      expect(compiled).toHaveLength(2)
      expect(compiled[0]).toContain('_layout.kay')
      expect(compiled[1]).not.toContain('_layout.kay')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads no layout for the save of a file that is not one', async () => {
    const dir = await scratchDir('lsp-layout-sibling-')

    try {
      await Bun.write(join(dir, 'src/routes/b.kay'), 'p b\n')

      const layout = join(dir, 'src/routes/_layout.kay')

      expect((await compiledAfter(dir, { page: 'src/routes/a.kay', layout, saves: [], sibling: 'src/routes/b.kay' })).layoutReads).toBe(0)
      expect((await compiledAfter(dir, { page: 'src/routes/a.kay', layout, saves: [withQuery] })).layoutReads).toBeGreaterThan(0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('kay lsp with a slow tsgo', () => {
  const page = 'src/routes/a.kay'

  // A server whose tsgo takes SLOW * 2 to answer for the page, counting how many of those questions run at once.
  async function slowServer(dir: string) {
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))
    // eslint-disable-next-line ts/unbound-method -- called back with the connection it was taken from
    const request = Connection.prototype.request as (this: Connection, method: string, params?: unknown) => Promise<unknown>
    const counts = { running: 0, started: 0, most: 0, last: undefined as number | undefined }

    await Promise.all([Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()), Bun.write(join(dir, page), 'p x\n')])

    const slow = spyOn(Connection.prototype, 'request').mockImplementation((async function (this: Connection, method: string, params?: unknown) {
      // The project checks ask for other files, and a server an earlier test left may still ask for its own page of the same name.
      if (this !== (server as unknown as { tsgo?: { connection: Connection } }).tsgo?.connection || method !== 'textDocument/diagnostic' || !(params as { textDocument: { uri: string } }).textDocument.uri.endsWith(`${page}.tsx`))
        return request.call(this, method, params)

      counts.started++
      counts.most = Math.max(counts.most, ++counts.running)
      await Bun.sleep(SLOW * 2)
      counts.running--

      return request.call(this, method, params)
    }) as Connection['request'])
    const uri = pathToFileURL(join(dir, page)).href

    client.onNotification<{ version?: number }>('textDocument/publishDiagnostics', ({ version }) => {
      counts.last = version
    })

    return {
      client,
      server,
      uri,
      counts,
      async start() {
        await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} })
        client.notify('initialized', {})
        client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'kay', version: 1, text: 'p x\n' } })
      },
      // Until the given version is published, as a real tsgo starting under load takes longer than any fixed wait.
      async published(version: number) {
        for (const limit = Date.now() + 15_000; counts.last !== version && Date.now() < limit;)
          await Bun.sleep(20)
      },
      stop() {
        slow.mockRestore()
        // `exit` would end the test run too.
        const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

        tsgo?.process.kill()
      },
    }
  }

  it('keeps one publish running at a time, and one more once it ends, however many changes come meanwhile', async () => {
    const dir = await scratchDir('lsp-slow-')
    const slow = await slowServer(dir)

    try {
      await slow.start()

      for (let version = 2; version <= 5; version++) {
        await Bun.sleep(DIAGNOSTICS_DELAY + 50)
        slow.client.notify('textDocument/didChange', { textDocument: { uri: slow.uri, version }, contentChanges: [{ text: `p {${version}}\n` }] })
      }
      await slow.published(5)

      expect(slow.counts.last).toBe(5)
      expect(slow.counts.most).toBe(1)
      expect(slow.counts.started).toBeGreaterThan(0)
      expect(slow.counts.started).toBeLessThanOrEqual(3)
    }
    finally {
      slow.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('publishes an open file whose project problems changed after the publish running, not beside it', async () => {
    const dir = await scratchDir('lsp-slow-problems-')
    const slow = await slowServer(dir)
    const internals = slow.server as unknown as { problems: Map<string, Diagnostic[]>, publishProblems: () => Promise<void> }

    try {
      await slow.start()
      await slow.published(1)
      slow.client.notify('textDocument/didChange', { textDocument: { uri: slow.uri, version: 2 }, contentChanges: [{ text: 'p {2}\n' }] })

      for (const limit = Date.now() + 15_000; slow.counts.running === 0 && Date.now() < limit;)
        await Bun.sleep(5)

      // A problem the last project check found in the page, which the next one no longer finds.
      internals.problems = new Map([[join(dir, page), [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'gone' }]]])
      await internals.publishProblems()
      await slow.published(2)

      expect(slow.counts.last).toBe(2)
      expect(slow.counts.most).toBe(1)
      expect(slow.counts.started).toBeGreaterThan(0)
    }
    finally {
      slow.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// An app's folder opened in VS Code, which writes its path with more percent-escapes than Node does, while tsgo echoes URIs the VS Code way. It holds another project with its own tsconfig.json, as a monorepo does, and lists an extension by a path beside it, as a library's own fixture app does.
describe('kay lsp on an app holding a nested project and listing an extension beside it, in a path VS Code percent-encodes', () => {
  let editor: Editor
  let dir: string
  const page = 'src/routes/a.kay'
  const nested = 'apps/web/src/pages/[id].kay'
  const source = '--- server\nconst s = 1\nfunction helper() { return s }\n---\np {s} {helper()}\n'

  beforeAll(async () => {
    dir = join(await scratchDir('lsp-workspace-'), 'app (v1)@x+y')
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'kay.config.ts'), 'export default { i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' }, extensions: [{ name: \'lib\', routes: { dir: \'../lib/routes\', prefix: \'/lib\' } }] }\n'),
      Bun.write(join(dir, 'src/routes/index.kay'), 'p Home\n'),
      Bun.write(join(dir, page), source),
      Bun.write(join(dir, 'src/params/code.ts'), 'export default (value: string): number | undefined => (/^\\d+$/).test(value) ? Number(value) : undefined\n'),
      Bun.write(join(dir, 'shared/data.ts'), 'export const label: string = \'Item \'\n'),
      Bun.write(join(dir, 'apps/web/tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'apps/web/kay.config.ts'), 'export default { routes: \'src/pages\', content: \'site-content.ts\', lints: { \'unread-name\': \'warn\', \'css-import-without-text\': \'allow\' } }\n'),
      Bun.write(join(dir, 'apps/web/site-content.ts'), 'export {}\n'),
      Bun.write(join(dir, 'apps/web/src/theme.css'), 'p { color: red }\n'),
      Bun.write(join(dir, 'apps/web/src/styled.kay'), '---\nimport theme from \'./theme.css\'\n---\np {theme}\n'),
      Bun.write(join(dir, 'apps/web/src/card.kay'), '---\nconst { title, subtitle } = props<{ title: string, subtitle?: string }>()\n---\np {title}\n'),
      Bun.write(join(dir, 'apps/web/src/counter.kay'), '---\nconst { start } = props<{ start: number }>()\n---\np {start}\n'),
      Bun.write(join(dir, nested), '--- server\nimport { label } from \'../../../../shared/data\'\n\nconst id: string = ctx.params.id\nconst title = label + id\n---\n---\nimport Counter from \'../counter.kay\'\n---\nh1 {title}\nCounter(start={0})\n'),
      Bun.write(join(dir, '../lib/package.json'), JSON.stringify({ name: 'lib' })),
      Bun.write(join(dir, '../lib/routes/codes/[id=code]/label.kay'), '--- server\nconst label: string = ctx.params.id\n---\np {label}\n'),
      Bun.write(join(dir, '../lib/routes/out.kay'), 'a(href="/welcome") Back\na(href="/libx/page") Beside\na(href="/lib/no/such") Nope\na(href="/fr/welcome") Retour\na(href="/fr/lib/no/such") Non\n'),
    ])
    editor = new Editor(dir, true)
    await editor.start()
    await editor.open(page)
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dirname(dir), { recursive: true, force: true })
  })

  it('goes to definitions in the .kay file', async () => {
    const links = await editor.request<LocationLink[]>('textDocument/definition', page, 4, 3)

    expect(links.map(link => [link.targetUri, ...spots([link.targetSelectionRange])[0]!])).toEqual([[editor.uri(page), 1, 6, 7]])

    const helper = await editor.request<LocationLink[]>('textDocument/definition', page, 4, 9)

    expect(helper.map(link => [link.targetUri, ...spots([link.targetSelectionRange])[0]!])).toEqual([[editor.uri(page), 2, 9, 15]])
  })

  it('finds references in the .kay file', async () => {
    const found = await editor.connection.request<Location[]>('textDocument/references', { textDocument: { uri: editor.uri(page) }, position: { line: 4, character: 3 }, context: { includeDeclaration: true } })

    expect(found.map(location => location.uri)).toEqual(found.map(() => editor.uri(page)))
    expect(spots(found.map(location => location.range))).toEqual([[1, 6, 7], [2, 27, 28], [4, 3, 4]])
  })

  it('renames a name in the .kay file', async () => {
    expect(spots((await editor.rename(page, 4, 3, 'value'))[page]!)).toEqual([[1, 6, 7], [2, 27, 28], [4, 3, 4]])
  })

  it('checks a nested project\'s .kay file against its own tsconfig, routes and kay environment', async () => {
    expect(await editor.open(nested)).toEqual([])
  })

  it('reports a lint at the level the nested project\'s kay.config.ts gives it', async () => {
    expect((await editor.open('apps/web/src/card.kay')).map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([['unread-name', 2]])
  })

  it('compiles a file of the nested project with its lints, and types it with its content config', async () => {
    expect(await editor.open('apps/web/src/styled.kay')).toEqual([])
    expect(await Bun.file(join(dir, 'apps/web/.kay/types/kay-env.d.ts')).text()).toContain('FeedPathsOf<typeof import("../../site-content")>')
  })

  it('keeps a nested project\'s shadow files out of the app\'s', async () => {
    expect(await Bun.file(join(dir, 'apps/web/.kay/types/src/pages/[id].kay.tsx')).exists()).toBe(true)
    expect(await Bun.file(join(dir, `.kay/types/${page}.tsx`)).exists()).toBe(true)
    expect(await Bun.file(join(dir, `.kay/types/${nested}.tsx`)).exists()).toBe(false)
  })

  it('types a page\'s params from its path in the extension\'s routes, by the app\'s matchers, as kay check does', async () => {
    expect((await editor.open('../lib/routes/codes/[id=code]/label.kay')).map(diagnostic => [diagnostic.range.start.line, diagnostic.message])).toEqual([[1, 'Type \'number\' is not assignable to type \'string\'.']])
  })

  it('checks a path the extension\'s routes name only under its own prefix, a locale\'s before it or not, as kay check does', async () => {
    expect((await editor.open('../lib/routes/out.kay')).map(diagnostic => [diagnostic.range.start.line, diagnostic.message.match(/serves (\S+?)"/)?.[1]])).toEqual([[2, '/lib/no/such'], [4, '/fr/lib/no/such']])
  })
})

// Two extensions written for other options than the app's, each beside it.
describe('kay lsp on an app listing extensions with a tsconfig of their own', () => {
  let editor: Editor
  let dir: string

  beforeAll(async () => {
    const base = await scratchDir('lsp-options-')
    const tsconfig = JSON.parse(await Bun.file(join(fixtures, 'site/tsconfig.json')).text()) as { compilerOptions: Record<string, unknown> }

    delete tsconfig.compilerOptions.noUncheckedIndexedAccess

    dir = join(base, 'app')
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig)),
      Bun.write(join(dir, 'kay.config.ts'), 'export default { extensions: [{ name: \'loose\', routes: { dir: \'../loose/routes\', prefix: \'/loose\' } }, { name: \'tight\', routes: { dir: \'node_modules/tight/routes\', prefix: \'/tight\' } }] }\n'),
      Bun.write(join(dir, 'src/routes/index.kay'), 'p Home\n'),
      Bun.write(join(base, 'loose/package.json'), JSON.stringify({ name: 'loose' })),
      Bun.write(join(base, 'loose/tsconfig.json'), JSON.stringify({ compilerOptions: { ...tsconfig.compilerOptions, strict: false } })),
      Bun.write(join(base, 'loose/routes/page.kay'), '---\nconst fine: number = null\nconst wrong: number = \'loose\'\n---\np {fine} {wrong}\na(href="/loose/nope") Nope\n'),
      Bun.write(join(base, 'tight/package.json'), JSON.stringify({ name: 'tight' })),
      Bun.write(join(base, 'tight/tsconfig.json'), JSON.stringify({ compilerOptions: { ...tsconfig.compilerOptions, noUncheckedIndexedAccess: true } })),
      Bun.write(join(base, 'tight/routes/page.kay'), '---\nconst list: string[] = []\nconst first: string = list[0]\n---\np {first}\n'),
      // Imports beside the package and a matcher of the app's, which a shadow written elsewhere must still reach.
      Bun.write(join(base, 'tight/lib/util.ts'), 'export const answer = 42\n'),
      Bun.write(join(base, 'tight/routes/part.kay'), 'p part\n'),
      Bun.write(join(base, 'tight/routes/deep/page.kay'), '---\nimport { answer } from \'../../lib/util\'\nimport Part from \'../part.kay\'\nconst list: string[] = []\nconst first: string = list[0]\n---\np {answer} {first}\nPart\n'),
      Bun.write(join(base, 'tight/routes/[n=int]/page.kay'), '--- server\nconst s: string = ctx.params.n\n---\np {s}\n'),
      Bun.write(join(dir, 'src/params/int.ts'), 'export default (value: string) => /^\\d+$/.test(value) ? Number(value) : undefined\n'),
    ])
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink('../../tight', join(dir, 'node_modules/tight'))
    editor = new Editor(dir)
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dirname(dir), { recursive: true, force: true })
  })

  it('types an extension\'s pages under its own options with the app\'s types in scope, as kay check does', async () => {
    expect((await editor.open('../loose/routes/page.kay')).map(diagnostic => [diagnostic.range.start.line, diagnostic.message.slice(0, 40)])).toEqual([[2, 'Type \'string\' is not assignable to type '], [5, 'Argument of type \'"/loose/nope"\' is not ']])
    expect((await editor.open('../tight/routes/page.kay')).map(diagnostic => diagnostic.range.start.line)).toEqual([2])
  })

  it('resolves the imports and the matchers of a linked extension\'s pages as kay check does', async () => {
    expect((await editor.open('../tight/routes/deep/page.kay')).map(diagnostic => diagnostic.range.start.line)).toEqual([4])
    expect((await editor.open('../tight/routes/[n=int]/page.kay')).map(diagnostic => [diagnostic.range.start.line, diagnostic.message.slice(0, 40)])).toEqual([[1, 'Type \'number\' is not assignable to type ']])
  })
})

describe('kay lsp project checks after a save', () => {
  it('runs a checking script again only when something it read changed', async () => {
    const dir = await scratchDir('lsp-probes-')
    const encoder = new TextEncoder()
    const toServer = new TransformStream<Uint8Array>()
    const toClient = new TransformStream<Uint8Array>()
    const writeToServer = toServer.writable.getWriter()
    const writeToClient = toClient.writable.getWriter()
    const client = new Connection(toClient.readable, (data) => {
      void writeToServer.write(encoder.encode(data))
    })
    const server = new KayLanguageServer(new Connection(toServer.readable, (data) => {
      void writeToClient.write(encoder.encode(data))
    }))
    const page = 'src/routes/index.kay'
    const unrelated = 'src/unrelated.kay'
    const files = {
      'tsconfig.json': await Bun.file(join(fixtures, 'site/tsconfig.json')).text(),
      'kay.config.ts': 'export default { i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\' } }\n',
      'src/messages/fr.ts': 'export default { hello: \'Bonjour\' }\n',
      'src/messages/en.ts': 'export default { hello: \'Hello\' }\n',
      'src/helper.ts': 'export const shape = 1\n',
      'src/callout.kay': 'aside\n  slot\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\nimport Callout from \'./callout.kay\'\nimport { shape } from \'./helper\'\n\nexport const notes = collection(\'content/notes\', { schema: t.Object({}), components: { Callout }, ...shape ? {} : {} })\n',
      'src/content/notes/a.md': 'Text\n',
      [page]: 'h1 Home\n',
      [unrelated]: 'p one\n',
    }
    const ran = { content: 0, messages: 0 }
    const spawn = Bun.spawn
    const counting = spyOn(Bun, 'spawn').mockImplementation(((command: string[], ...rest: unknown[]) => {
      if (command[1]?.endsWith('content/problems.ts'))
        ran.content++
      else if (command[1]?.endsWith('check/messages.ts'))
        ran.messages++

      return (spawn as (...args: unknown[]) => unknown)(command, ...rest)
    }) as typeof Bun.spawn)

    await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(dir, path), text)))

    // Waits until the counts stay as they are for a while, however slow the machine.
    const quiet = async (atLeast = 1000) => {
      await Bun.sleep(atLeast)

      for (let seen = ''; seen !== JSON.stringify(ran);) {
        seen = JSON.stringify(ran)
        await Bun.sleep(700)
      }

      return { ...ran }
    }
    // Writes a file, tells the server and waits for the project checks it makes.
    const save = async (path: string, text: string) => {
      await Bun.write(join(dir, path), text)
      client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(join(dir, path)).href, type: 2 }] })

      return quiet()
    }
    const removed = async (path: string) => {
      await rm(join(dir, path))
      client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(join(dir, path)).href, type: 3 }] })

      return quiet()
    }

    try {
      await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} })
      client.notify('initialized', {})

      while (ran.content === 0 || ran.messages === 0)
        await Bun.sleep(100)

      expect(await quiet()).toEqual({ content: 1, messages: 1 })

      // A component neither the collections nor the messages use.
      expect(await save(unrelated, 'p two\n')).toEqual({ content: 1, messages: 1 })
      expect(await save(page, 'h1 Other\n')).toEqual({ content: 1, messages: 1 })

      // The content config itself, a module it imports, a component its entries use, and an entry written, added and removed.
      expect(await save('src/content.config.ts', `${files['src/content.config.ts']}\n`)).toEqual({ content: 2, messages: 1 })
      expect(await save('src/helper.ts', 'export const shape = 2\n')).toEqual({ content: 3, messages: 1 })
      expect(await save('src/callout.kay', 'aside.note\n  slot\n')).toEqual({ content: 4, messages: 1 })
      expect(await save('src/content/notes/a.md', 'Other text\n')).toEqual({ content: 5, messages: 1 })
      expect(await save('src/content/notes/b.md', 'New\n')).toEqual({ content: 6, messages: 1 })
      expect(await removed('src/content/notes/b.md')).toEqual({ content: 7, messages: 1 })
      // The result of a run stands for the next save.
      expect(await save(unrelated, 'p three\n')).toEqual({ content: 7, messages: 1 })

      // A messages file, written and deleted.
      expect(await save('src/messages/en.ts', 'export default { hello: \'Hi\' }\n')).toEqual({ content: 7, messages: 2 })
      expect(await removed('src/messages/en.ts')).toEqual({ content: 7, messages: 3 })
      expect(await save('src/messages/en.ts', 'export default { hello: \'Hello\' }\n')).toEqual({ content: 7, messages: 4 })

      // The config both scripts run under, which also names a catalog the messages newly read.
      expect(await save('kay.config.ts', 'export default { i18n: { locales: [\'fr\', \'en\', \'es\'], defaultLocale: \'fr\' } }\n')).toEqual({ content: 8, messages: 5 })
      expect(await save('src/messages/es.ts', 'export default { hello: \'Hola\' }\n')).toEqual({ content: 8, messages: 6 })
      expect(await save('src/messages/es.ts', 'export default { hello: \'Hola!\' }\n')).toEqual({ content: 8, messages: 7 })

      // A module the content config starts importing is tracked from then on.
      await Bun.write(join(dir, 'src/extra.ts'), 'export const extra = 1\n')
      expect(await save('src/content.config.ts', files['src/content.config.ts'].replace('\n\nexport', '\nimport \'./extra\'\n\nexport'))).toEqual({ content: 9, messages: 7 })
      expect(await save('src/extra.ts', 'export const extra = 2\n')).toEqual({ content: 10, messages: 7 })

      // A folder an `import.meta.glob` of the content config searches.
      await Bun.write(join(dir, 'src/cards/a.ts'), 'export default 1\n')
      expect(await save('src/content.config.ts', files['src/content.config.ts'].replace('\n\nexport', '\nexport const cards = import.meta.glob(\'./cards/*.ts\')\n\nexport'))).toEqual({ content: 11, messages: 7 })
      expect(await save('src/cards/b.ts', 'export default 2\n')).toEqual({ content: 12, messages: 7 })
    }
    finally {
      counting.mockRestore()

      const { tsgo } = server as unknown as { tsgo?: { process: { kill: () => void } } }

      tsgo?.process.kill()
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
