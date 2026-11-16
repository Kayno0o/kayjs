import type { Diagnostic, Hover } from '../src/lsp/protocol'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Connection } from '../src/lsp/rpc'
import { kayTypes } from './kay-types'
import { spawnSuiteServer } from './listening'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, paths: kayTypes() },
  include: ['src', '.kay/types'],
})
const guard = 'import { guard } from \'kay\'\n\nexport default guard(() => ({ org: \'acme\' }))\n'
const endpoint = 'import type { EndpointContext } from \'kay\'\n\nexport function GET(ctx: EndpointContext) {\n  return Response.json([ctx.params.slug, ctx.guard.org, ctx.guard.nobody])\n}\n'
const module = 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', ({ guard }) => [guard.org, guard.nobody])\n'

// A project whose plain `.ts` route files the editor opens, which no `.kay` document stands for.
const root = await scratchDir('lsp-routes-')

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('kay lsp on a plain .ts route handler', () => {
  const child = spawnSuiteServer([process.execPath, cli, 'lsp', '--stdio'], { stdin: 'pipe', stderr: 'ignore' })
  const connection = new Connection(child.stdout, (data) => {
    void child.stdin.write(data)
    void child.stdin.flush()
  })
  const waiting = new Map<string, (diagnostics: Diagnostic[]) => void>()
  const uri = (path: string) => pathToFileURL(join(root, path)).href

  async function open(path: string): Promise<Diagnostic[]> {
    const published = new Promise<Diagnostic[]>(resolve => waiting.set(uri(path), resolve))

    connection.notify('textDocument/didOpen', { textDocument: { uri: uri(path), languageId: 'typescript', version: 1, text: await Bun.file(join(root, path)).text() } })

    return published
  }

  async function hover(path: string, line: number, character: number): Promise<string> {
    const result = await connection.request<Hover | null>('textDocument/hover', { textDocument: { uri: uri(path) }, position: { line, character } })
    const contents = result?.contents

    return typeof contents === 'string' ? contents : JSON.stringify(contents)
  }

  beforeAll(async () => {
    await Promise.all(Object.entries({
      'tsconfig.json': tsconfig,
      'src/routes/index.kay': 'p hi\n',
      'src/routes/orgs/_guard.ts': guard,
      'src/routes/orgs/[slug].json.ts': endpoint,
      'src/api/_guard.ts': guard,
      'src/api/orgs.ts': module,
    }).map(async ([path, content]) => Bun.write(join(root, path), content)))
    connection.onNotification<{ uri: string, diagnostics: Diagnostic[] }>('textDocument/publishDiagnostics', ({ uri, diagnostics }) => waiting.get(uri)?.(diagnostics))
    await connection.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} })
    connection.notify('initialized', {})
  })

  afterAll(async () => {
    await connection.request('shutdown')
    connection.notify('exit')
    await child.exited
  })

  it('types an endpoint\'s params and guard from the file tree, and reports what they lack', async () => {
    const diagnostics = await open('src/routes/orgs/[slug].json.ts')

    expect(diagnostics.map(({ message, range }) => [range.start.line, message])).toEqual([[3, expect.stringContaining('Property \'nobody\' does not exist')]])
    expect(await hover('src/routes/orgs/[slug].json.ts', 3, 37)).toContain('slug: string')
    expect(await hover('src/routes/orgs/[slug].json.ts', 3, 52)).toContain('org: \\"acme\\"')
  })

  it('types an api() module\'s guard from the file tree, and reports what it lacks', async () => {
    const diagnostics = await open('src/api/orgs.ts')

    expect(diagnostics.map(({ message, range }) => [range.start.line, message])).toEqual([[2, expect.stringContaining('Property \'nobody\' does not exist')]])
    expect(await hover('src/api/orgs.ts', 2, 53)).toContain('org: \\"acme\\"')
  })
})
