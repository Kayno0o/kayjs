import type { CodeAction, CompletionItem, CompletionList, Diagnostic, DocumentHighlight, Hover, Location, LocationLink, Range, TextEdit, WorkspaceEdit } from '../src/lsp/protocol'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Connection } from '../src/lsp/rpc'

const fixtures = join(import.meta.dir, 'fixtures')
const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

// Drives `kay lsp` over stdio the way an editor does.
class Editor {
  readonly connection: Connection
  private readonly process = Bun.spawn([process.execPath, cli, 'lsp', '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  private readonly waiting = new Map<string, (diagnostics: Diagnostic[]) => void>()

  constructor(readonly root: string, private readonly vscode = false) {
    this.connection = new Connection(this.process.stdout, (data) => {
      void this.process.stdin.write(data)
      void this.process.stdin.flush()
    })
    this.connection.onNotification<{ uri: string, diagnostics: Diagnostic[] }>('textDocument/publishDiagnostics', ({ uri, diagnostics }) => this.waiting.get(uri)?.(diagnostics))
  }

  async start() {
    await this.connection.request('initialize', { processId: process.pid, rootUri: this.fileUri(this.root), capabilities: {} })
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
    const published = this.diagnostics(uri)

    this.connection.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })

    return published
  }

  async save(path: string): Promise<Diagnostic[]> {
    const published = this.diagnostics(this.uri(path))

    this.connection.notify('textDocument/didSave', { textDocument: { uri: this.uri(path) } })

    return published
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

  private async diagnostics(uri: string): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      this.waiting.set(uri, resolve)
    })
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

describe('kay lsp', () => {
  const broken = new Editor(join(fixtures, 'broken'))
  const site = new Editor(join(fixtures, 'site'))

  beforeAll(async () => {
    await Promise.all([broken.start(), site.start()])
  })

  afterAll(async () => {
    await Promise.all([broken.stop(), site.stop()])
  })

  it('publishes type errors at the .kay source position and follows edits', async () => {
    const diagnostics = await broken.open('src/routes/[id].kay')

    expect(brief(diagnostics)).toEqual([
      { start: { line: 1, character: 29 }, end: { line: 1, character: 33 }, code: 2339 },
      { start: { line: 4, character: 8 }, end: { line: 4, character: 11 }, code: 2551 },
    ])

    const fixed = await broken.change('src/routes/[id].kay', '--- server\nconst id = Number(ctx.params.id)\nconst user = { name: \'Ada\', id }\n---\np {user.name}\n', 2)

    expect(fixed).toEqual([])
  })

  it('survives malformed frames and documents it cannot serve', async () => {
    broken.write('Content-Length: 5\r\n\r\n{nope')
    broken.connection.notify('textDocument/didOpen', { textDocument: { uri: 'vscode-vfs://github/x/page.kay', languageId: 'kay', version: 1, text: 'p Hi' } })

    expect(await broken.request('textDocument/hover', 'src/routes/[id].kay', 4, 3)).not.toBeNull()
  })

  it('reports compile errors from the .kay compiler itself', async () => {
    const diagnostics = await broken.change('src/routes/[id].kay', 'ul\n  for of [1, 2]\n    li x\n', 3)

    expect(diagnostics).toEqual([expect.objectContaining({ source: 'kay', range: expect.objectContaining({ start: { line: 1, character: 2 } }) })])
  })

  it('shows hover types for template expressions and server data', async () => {
    await site.open('src/routes/index.kay')

    const hover = await site.request<Hover>('textDocument/hover', 'src/routes/index.kay', 20, 6)

    expect(JSON.stringify(hover.contents)).toContain('open: number')
    expect(hover.range).toEqual({ start: { line: 20, character: 5 }, end: { line: 20, character: 9 } })
  })

  it('completes members inside template expressions, without the generated helpers', async () => {
    const list = await site.request<CompletionList>('textDocument/completion', 'src/routes/index.kay', 23, 46)
    const labels = list.items.map(item => item.label)

    expect(labels).toContain('title')
    expect(labels).toContain('done')

    await site.open('src/components/quick-add.kay')

    const scope = await site.request<CompletionList>('textDocument/completion', 'src/components/quick-add.kay', 16, 22)
    const names = scope.items.map(item => item.label)

    expect(names).toEqual(expect.arrayContaining(['id', 'saved', 'submit', 'title']))
    expect(names).toContain('__dirname')
    expect(names.filter(name => name === '__props' || name.startsWith('Kay'))).toEqual([])
  })

  it('goes to definitions across .kay files', async () => {
    const [action] = await site.request<LocationLink[]>('textDocument/definition', 'src/components/quick-add.kay', 9, 19)

    expect(action).toMatchObject({ targetUri: site.uri('src/routes/index.kay'), targetSelectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 16 } } })

    const [component] = await site.request<LocationLink[]>('textDocument/definition', 'src/routes/index.kay', 31, 2)

    expect(component?.targetUri).toBe(site.uri('src/components/counter.kay'))
  })

  it('goes from a server value in the template to its declaration in the server fence, and to nothing else', async () => {
    const open = await site.request<LocationLink[]>('textDocument/definition', 'src/routes/index.kay', 20, 6)

    expect(open.map(link => [link.targetUri, ...spots([link.targetSelectionRange])[0]!])).toEqual([[site.uri('src/routes/index.kay'), 13, 6, 10]])
  })

  it('finds references across .kay files, a server value\'s reads in the template included', async () => {
    await site.open('src/components/quick-add.kay')

    const add = await site.connection.request<Location[]>('textDocument/references', { textDocument: { uri: site.uri('src/routes/index.kay') }, position: { line: 5, character: 14 }, context: { includeDeclaration: true } })
    const open = await site.connection.request<Location[]>('textDocument/references', { textDocument: { uri: site.uri('src/routes/index.kay') }, position: { line: 13, character: 7 }, context: { includeDeclaration: true } })

    expect(spots(add.filter(location => location.uri === site.uri('src/routes/index.kay')).map(location => location.range))).toEqual([[5, 13, 16], [14, 27, 30], [24, 19, 22]])
    expect(spots(add.filter(location => location.uri === site.uri('src/components/quick-add.kay')).map(location => location.range))).toEqual([[2, 9, 12], [9, 18, 21]])
    expect(spots(open.map(location => location.range))).toEqual([[13, 6, 10], [20, 5, 9], [31, 15, 19]])
    expect(spots((await site.request<DocumentHighlight[]>('textDocument/documentHighlight', 'src/routes/index.kay', 20, 6)).map(highlight => highlight.range))).toEqual([[13, 6, 10], [20, 5, 9], [31, 15, 19]])
  })

  it('renames a name everywhere the user wrote it, from either end, and nothing generated', async () => {
    const open = [[13, 6, 10], [20, 5, 9], [31, 15, 19]]

    const fromDeclaration = await site.rename('src/routes/index.kay', 13, 7, 'pending')

    expect(Object.keys(fromDeclaration)).toEqual(['src/routes/index.kay'])
    expect(spots(fromDeclaration['src/routes/index.kay']!)).toEqual(open)
    expect(spots((await site.rename('src/routes/index.kay', 20, 6, 'pending'))['src/routes/index.kay']!)).toEqual(open)
    // A loop's item is generated into both its key function and its row.
    expect(spots((await site.rename('src/routes/index.kay', 22, 9, 'item'))['src/routes/index.kay']!)).toEqual([[22, 8, 12], [22, 27, 31], [23, 28, 32], [23, 41, 45]])

    await site.open('src/components/card.kay')

    const title = await site.rename('src/components/card.kay', 3, 9, 'heading')

    expect(spots(title['src/components/card.kay']!)).toEqual([[3, 8, 13], [3, 26, 31], [6, 6, 11]])
    expect(spots(title['src/routes/index.kay']!)).toEqual([[19, 5, 10]])
    expect(await site.request('textDocument/prepareRename', 'src/routes/index.kay', 22, 5)).toBeNull()
  })

  it('renames a generic component\'s type parameter from its fence line and from its uses', async () => {
    await site.open('src/components/list.kay')

    const uses = [[0, 5, 6], [1, 39, 40], [1, 57, 58]]

    expect(spots((await site.rename('src/components/list.kay', 0, 5, 'Item'))['src/components/list.kay']!)).toEqual(uses)
    expect(spots((await site.rename('src/components/list.kay', 1, 57, 'Item'))['src/components/list.kay']!)).toEqual(uses)
    expect(JSON.stringify((await site.request<Hover>('textDocument/hover', 'src/components/list.kay', 0, 5)).contents)).toContain('T')
  })

  it('shows the signature of the call under the cursor', async () => {
    const help = await site.request<{ signatures: { label: string }[] }>('textDocument/signatureHelp', 'src/components/quick-add.kay', 9, 28)

    expect(help.signatures[0]!.label).toBe('add(input: { title: string; }, options?: CallOptions): Promise<number>')
  })

  it('formats a .kay document as one whole-document edit', async () => {
    await site.open('src/routes/about.kay')
    await site.change('src/routes/about.kay', 'div\n    p( class = \'x\' ) Hi\n', 2)

    const edits = await site.connection.request<TextEdit[]>('textDocument/formatting', { textDocument: { uri: site.uri('src/routes/about.kay') }, options: { tabSize: 2, insertSpaces: true } })

    expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'div\n  p(class="x") Hi\n' }])
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
      Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'imports', type: 'module', dependencies: { 'kay': '*', 'kay-lib': '*' } })),
      // A kay library, its components given specifiers by its exports map.
      Bun.write(join(dir, 'node_modules/kay-lib/package.json'), JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' } })),
      Bun.write(join(dir, 'node_modules/kay-lib/src/tag-pill.kay'), '---\nconst { label } = props<{ label: string }>()\n---\nspan.pill {label}\n'),
      Bun.write(join(dir, 'src/actions.ts'), 'import { action } from \'kay\'\n\nexport const add = action(() => 1)\n'),
      Bun.write(join(dir, 'src/data.ts'), 'export function listTodos(): string[] {\n  return []\n}\n'),
      Bun.write(join(dir, 'src/badge.kay'), 'span.badge New\n'),
      Bun.write(join(dir, page), 'p Home\n'),
      // A config that fails to load leaves the defaults; every test below runs against it.
      Bun.write(join(dir, 'kay.config.ts'), 'throw new Error(\'Broken config\')\n'),
    ])
    // Every package of this checkout, and kay as a copy installed there: tsgo offers no import from a package whose files sit outside node_modules.
    await mkdir(join(dir, 'node_modules'), { recursive: true })
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

  it('reports a lint that warns as a warning, and none a `// kay-allow` comment allows', async () => {
    const source = '---\nconst { todos } = props<{ todos: { id: number }[] }>()\n// kay-allow unread-name\nconst idle = 1\n---\nfor todo, i of todos key={i}\n  p {i}. {todo.id}\n'
    const diagnostics = await editor.change(page, source, 8)

    expect(diagnostics.map(diagnostic => [diagnostic.range.start.line, diagnostic.severity, diagnostic.code])).toEqual([[5, 2, 'positional-key']])
  })

  it('warns of an island\'s for over objects with no id and no key, as kay check does', async () => {
    const source = '---\nconst posts = signal([{ slug: \'a\' }])\n---\nfor post of posts\n  button(onClick={() => posts.set([])}) {post.slug}\n'
    const diagnostics = await editor.change(page, source, 10)

    expect(diagnostics.map(diagnostic => [diagnostic.range.start.line, diagnostic.severity, diagnostic.code])).toEqual([[3, 2, 'identity-key']])
  })

  it('reports nothing on the index of a positionally keyed for whose rows do not read it, and renames it with its key', async () => {
    const source = '---\nconst { todos } = props<{ todos: { id: number }[] }>()\n---\nfor todo, i of todos key={i}\n  p {todo.id}\n'
    const diagnostics = await editor.change(page, source, 9)

    expect(diagnostics.map(diagnostic => [diagnostic.range.start.line, diagnostic.code])).toEqual([[3, 'positional-key']])
    expect(spots((await editor.rename(page, 3, 10, 'index'))[page]!)).toEqual([[3, 10, 11], [3, 26, 27]])
  })
})

describe('kay lsp following files on disk', () => {
  let editor: Editor
  let dir: string
  const page = 'src/routes/index.kay'
  const codes = (diagnostics: Diagnostic[]) => diagnostics.map(diagnostic => diagnostic.code)

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kay-disk-'))
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'src/actions.ts'), 'import { action } from \'kay\'\n\nexport const add = action(() => 1)\n'),
      Bun.write(join(dir, 'src/data.ts'), 'export const n: number = 1\n'),
      Bun.write(join(dir, page), '---\nimport { n } from \'../data\'\nimport Badge from \'../badge.kay\'\n\nconst s: string = n\n---\nBadge\np {s}\n'),
    ])
    await mkdir(join(dir, 'node_modules'))
    await Promise.all((await readdir(join(import.meta.dir, '../node_modules'))).filter(name => name !== '.bin').map(async name => symlink(join(import.meta.dir, '../node_modules', name), join(dir, 'node_modules', name))))
    editor = new Editor(dir)
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dir, { recursive: true, force: true })
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
})

// An editor opened on a folder holding several projects, each with its own tsconfig.json, as a monorepo is.
describe('kay lsp in a project nested in the workspace', () => {
  let editor: Editor
  let dir: string
  const page = 'apps/web/src/pages/[id].kay'

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kay-nested-'))
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src'] })),
      Bun.write(join(dir, 'src/home.kay'), 'p Home\n'),
      Bun.write(join(dir, 'shared/data.ts'), 'export const label: string = \'Item \'\n'),
      Bun.write(join(dir, 'apps/web/tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, 'apps/web/kay.config.ts'), 'export default { routes: \'src/pages\', lints: { \'unread-name\': \'warn\' } }\n'),
      Bun.write(join(dir, 'apps/web/src/card.kay'), '---\nconst { title, subtitle } = props<{ title: string, subtitle?: string }>()\n---\np {title}\n'),
      Bun.write(join(dir, 'apps/web/src/counter.kay'), '---\nconst { start } = props<{ start: number }>()\n---\np {start}\n'),
      Bun.write(join(dir, page), '--- server\nimport { label } from \'../../../../shared/data\'\n\nconst id: string = ctx.params.id\nconst title = label + id\n---\n---\nimport Counter from \'../counter.kay\'\n---\nh1 {title}\nCounter(start={0})\n'),
    ])
    await mkdir(join(dir, 'node_modules'))
    await Promise.all((await readdir(join(import.meta.dir, '../node_modules'))).filter(name => name !== '.bin').map(async name => symlink(join(import.meta.dir, '../node_modules', name), join(dir, 'node_modules', name))))
    editor = new Editor(dir)
    await editor.start()
  })

  afterAll(async () => {
    await editor.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('checks a .kay file against its own project\'s tsconfig, routes and kay environment', async () => {
    expect(await editor.open(page)).toEqual([])
  })

  it('reports a lint at the level its project\'s kay.config.ts gives it', async () => {
    expect((await editor.open('apps/web/src/card.kay')).map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([['unread-name', 2]])
  })

  it('keeps a nested project\'s shadow files out of the workspace folder\'s', async () => {
    expect(await Bun.file(join(dir, 'apps/web/.kay/types/src/pages/[id].kay.tsx')).exists()).toBe(true)
    expect(await Bun.file(join(dir, '.kay/types/src/home.kay.tsx')).exists()).toBe(true)
    expect(await Bun.file(join(dir, '.kay/types/apps/web/src/pages/[id].kay.tsx')).exists()).toBe(false)
  })
})

// VS Code writes a project's path with more percent-escapes than Node does, and tsgo echoes URIs the VS Code way.
describe('kay lsp in a path VS Code percent-encodes', () => {
  let editor: Editor
  let dir: string
  const page = 'src/routes/a.kay'
  const source = '--- server\nconst s = 1\nfunction helper() { return s }\n---\np {s} {helper()}\n'

  beforeAll(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'kay-')), 'app (v1)@x+y')
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(fixtures, 'site/tsconfig.json')).text()),
      Bun.write(join(dir, page), source),
      ...(await readdir(join(import.meta.dir, '../node_modules'))).filter(name => name !== '.bin').map(async name => symlink(join(import.meta.dir, '../node_modules', name), join(dir, 'node_modules', name))),
    ])
    editor = new Editor(dir, true)
    await editor.start()
    await editor.open(page)
  })

  afterAll(async () => {
    await editor.stop()
    await rm(join(dir, '..'), { recursive: true, force: true })
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
})
