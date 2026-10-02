import type { CompletionList, Diagnostic, Hover, LocationLink, TextEdit } from '../src/lsp/protocol'
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
  private readonly process = Bun.spawn([process.execPath, cli, 'lsp', '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
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

  it('reports compile errors from the .kay compiler itself', async () => {
    const diagnostics = await broken.change('src/routes/[id].kay', 'ul\n  for item of [1, 2]\n    li {item}\n', 3)

    expect(diagnostics).toEqual([expect.objectContaining({ source: 'kay', range: expect.objectContaining({ start: { line: 1, character: 2 } }) })])
  })

  it('shows hover types for template expressions and server data', async () => {
    await site.open('src/routes/index.kay')

    const hover = await site.request<Hover>('textDocument/hover', 'src/routes/index.kay', 15, 6)

    expect(JSON.stringify(hover.contents)).toContain('open: number')
    expect(hover.range).toEqual({ start: { line: 15, character: 5 }, end: { line: 15, character: 9 } })
  })

  it('completes members inside template expressions, without the generated helpers', async () => {
    const list = await site.request<CompletionList>('textDocument/completion', 'src/routes/index.kay', 18, 46)
    const labels = list.items.map(item => item.label)

    expect(labels).toContain('title')
    expect(labels).toContain('done')

    await site.open('src/components/quick-add.kay')

    const scope = await site.request<CompletionList>('textDocument/completion', 'src/components/quick-add.kay', 16, 22)
    const names = scope.items.map(item => item.label)

    expect(names).toEqual(expect.arrayContaining(['id', 'saved', 'submit', 'title']))
    expect(names.filter(name => name.startsWith('__') || name.startsWith('Kay'))).toEqual([])
  })

  it('goes to definitions across .kay files', async () => {
    const [action] = await site.request<LocationLink[]>('textDocument/definition', 'src/components/quick-add.kay', 9, 19)

    expect(action).toMatchObject({ targetUri: site.uri('src/routes/index.kay'), targetSelectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 16 } } })

    const [component] = await site.request<LocationLink[]>('textDocument/definition', 'src/routes/index.kay', 22, 2)

    expect(component?.targetUri).toBe(site.uri('src/components/counter.kay'))
  })

  it('formats a .kay document as one whole-document edit', async () => {
    await site.open('src/routes/about.kay')
    await site.change('src/routes/about.kay', 'div\n    p( class = \'x\' ) Hi   \n', 2)

    const edits = await site.connection.request<TextEdit[]>('textDocument/formatting', { textDocument: { uri: site.uri('src/routes/about.kay') }, options: { tabSize: 2, insertSpaces: true } })

    expect(edits).toEqual([{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'div\n  p(class="x") Hi\n' }])
  })
})
