import type { CompletionList, Diagnostic, DocumentHighlight, Hover, Location, LocationLink, Range, TextEdit, WorkspaceEdit } from '../src/lsp/protocol'
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

  constructor(readonly root: string) {
    this.connection = new Connection(this.process.stdout, (data) => {
      this.process.stdin.write(data)
      void this.process.stdin.flush()
    })
    this.connection.onNotification<{ uri: string, diagnostics: Diagnostic[] }>('textDocument/publishDiagnostics', ({ uri, diagnostics }) => this.waiting.get(uri)?.(diagnostics))
  }

  async start() {
    await this.connection.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.root).href, capabilities: {} })
    this.connection.notify('initialized', {})
  }

  uri(path: string): string {
    return pathToFileURL(join(this.root, path)).href
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

  async request<Result>(method: string, path: string, line: number, character: number): Promise<Result> {
    return this.connection.request<Result>(method, { textDocument: { uri: this.uri(path) }, position: { line, character } })
  }

  async rename(path: string, line: number, character: number, newName: string): Promise<Record<string, Range[]>> {
    const { changes } = await this.connection.request<WorkspaceEdit>('textDocument/rename', { textDocument: { uri: this.uri(path) }, position: { line, character }, newName })

    return Object.fromEntries(Object.entries(changes).map(([uri, edits]) => [uri.slice(pathToFileURL(this.root).href.length + 1), sortRanges(edits.map(edit => edit.range))]))
  }

  write(data: string) {
    this.process.stdin.write(data)
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
    const diagnostics = await broken.change('src/routes/[id].kay', 'ul\n  for item of [1, 2]\n    li {item}\n', 3)

    expect(diagnostics).toEqual([expect.objectContaining({ source: 'kay', range: expect.objectContaining({ start: { line: 1, character: 2 } }) })])
  })

  it('shows hover types for template expressions and server data', async () => {
    await site.open('src/routes/index.kay')

    const hover = await site.request<Hover>('textDocument/hover', 'src/routes/index.kay', 21, 6)

    expect(JSON.stringify(hover.contents)).toContain('open: number')
    expect(hover.range).toEqual({ start: { line: 21, character: 5 }, end: { line: 21, character: 9 } })
  })

  it('completes members inside template expressions, without the generated helpers', async () => {
    const list = await site.request<CompletionList>('textDocument/completion', 'src/routes/index.kay', 24, 46)
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

    const [component] = await site.request<LocationLink[]>('textDocument/definition', 'src/routes/index.kay', 32, 2)

    expect(component?.targetUri).toBe(site.uri('src/components/counter.kay'))
  })

  it('finds references across .kay files, a server value\'s reads in the template included', async () => {
    await site.open('src/components/quick-add.kay')

    const add = await site.connection.request<Location[]>('textDocument/references', { textDocument: { uri: site.uri('src/routes/index.kay') }, position: { line: 5, character: 14 }, context: { includeDeclaration: true } })
    const open = await site.connection.request<Location[]>('textDocument/references', { textDocument: { uri: site.uri('src/routes/index.kay') }, position: { line: 13, character: 7 }, context: { includeDeclaration: true } })

    expect(spots(add.filter(location => location.uri === site.uri('src/routes/index.kay')).map(location => location.range))).toEqual([[5, 13, 16], [14, 27, 30], [25, 19, 22]])
    expect(spots(add.filter(location => location.uri === site.uri('src/components/quick-add.kay')).map(location => location.range))).toEqual([[2, 9, 12], [9, 18, 21]])
    expect(spots(open.map(location => location.range))).toEqual([[13, 6, 10], [21, 5, 9], [32, 15, 19]])
    expect(spots((await site.request<DocumentHighlight[]>('textDocument/documentHighlight', 'src/routes/index.kay', 21, 6)).map(highlight => highlight.range))).toEqual([[13, 6, 10], [21, 5, 9], [32, 15, 19]])
  })

  it('renames a name everywhere the user wrote it, from either end, and nothing generated', async () => {
    const open = [[13, 6, 10], [21, 5, 9], [32, 15, 19]]

    const fromDeclaration = await site.rename('src/routes/index.kay', 13, 7, 'pending')

    expect(Object.keys(fromDeclaration)).toEqual(['src/routes/index.kay'])
    expect(spots(fromDeclaration['src/routes/index.kay']!)).toEqual(open)
    expect(spots((await site.rename('src/routes/index.kay', 21, 6, 'pending'))['src/routes/index.kay']!)).toEqual(open)
    // A loop's item is generated into both its key function and its row.
    expect(spots((await site.rename('src/routes/index.kay', 23, 9, 'item'))['src/routes/index.kay']!)).toEqual([[23, 8, 12], [23, 27, 31], [24, 28, 32], [24, 41, 45]])

    await site.open('src/components/card.kay')

    const title = await site.rename('src/components/card.kay', 3, 9, 'heading')

    expect(spots(title['src/components/card.kay']!)).toEqual([[3, 8, 13], [3, 26, 31], [6, 6, 11]])
    expect(spots(title['src/routes/index.kay']!)).toEqual([[20, 5, 10]])
    expect(await site.request('textDocument/prepareRename', 'src/routes/index.kay', 23, 5)).toBeNull()
  })

  it('shows the signature of the call under the cursor', async () => {
    const help = await site.request<{ signatures: { label: string }[] }>('textDocument/signatureHelp', 'src/components/quick-add.kay', 9, 28)

    expect(help.signatures[0]!.label).toBe('add(input: { title: string; }): Promise<number>')
  })

  it('formats a .kay document as one whole-document edit', async () => {
    await site.open('src/routes/about.kay')
    await site.change('src/routes/about.kay', 'div\n    p( class = \'x\' ) Hi   \n', 2)

    const edits = await site.connection.request<TextEdit[]>('textDocument/formatting', { textDocument: { uri: site.uri('src/routes/about.kay') }, options: { tabSize: 2, insertSpaces: true } })

    expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'div\n  p(class="x") Hi\n' }])
  })
})
