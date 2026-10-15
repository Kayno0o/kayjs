import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const SRC = join(import.meta.dir, '../src')
// A process of its own, as modules loaded stay loaded: `kay check` and the editor's server run over a project, then list what was loaded.
const SCRIPT = `
import { pathToFileURL } from 'node:url'
import { check } from ${JSON.stringify(join(SRC, 'check/index.ts'))}
import { Connection } from ${JSON.stringify(join(SRC, 'lsp/rpc.ts'))}
import { KayLanguageServer } from ${JSON.stringify(join(SRC, 'lsp/server.ts'))}
import { buildingWithoutEnv } from ${JSON.stringify(join(SRC, 'server/env-state.ts'))}

const root = process.argv[1]
const encoder = new TextEncoder()
const toServer = new TransformStream()
const toClient = new TransformStream()
const writeToServer = toServer.writable.getWriter()
const writeToClient = toClient.writable.getWriter()
const client = new Connection(toClient.readable, data => void writeToServer.write(encoder.encode(data)))
const server = new KayLanguageServer(new Connection(toServer.readable, data => void writeToClient.write(encoder.encode(data))))

buildingWithoutEnv()

const diagnostics = await check(root)
const page = root + '/src/routes/index.kay'
const text = await Bun.file(page).text()

await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} })
client.notify('initialized', {})
client.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(page).href, languageId: 'kay', version: 1, text } })
await Bun.sleep(1500)
await client.request('textDocument/hover', { textDocument: { uri: pathToFileURL(page).href }, position: { line: 0, character: 1 } })

const loaded = Object.keys(require.cache).filter(path => path.includes('/node_modules/elysia/') || path.includes('/node_modules/@sinclair/typebox/'))

server.tsgo?.process.kill()
console.log(JSON.stringify({ problems: diagnostics.length, loaded }))
process.exit(0)
`

describe('the modules kay check and the editor\'s server load', () => {
  it('leave out Elysia and the server stack, for a project with pages, layouts, an API module and endpoints', async () => {
    const dir = await scratchDir('check-load-')

    await Promise.all([
      Bun.write(join(dir, 'tsconfig.json'), await Bun.file(join(import.meta.dir, 'fixtures/site/tsconfig.json')).text()),
      Bun.write(join(dir, 'src/routes/index.kay'), 'p Home\n'),
      Bun.write(join(dir, 'src/routes/_layout.kay'), '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ q: s.String() }) }\n---\nslot\n'),
      Bun.write(join(dir, 'src/routes/data.json.ts'), 'export function GET() {\n  return Response.json({})\n}\n'),
      Bun.write(join(dir, 'src/api/hello.ts'), 'import { api } from \'kay\'\n\nexport default api().get(\'/\', () => \'hi\')\n'),
    ])

    const run = Bun.spawn([process.execPath, '-e', SCRIPT, dir], { stdout: 'pipe', stderr: 'pipe' })
    const [output, errors] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    const { loaded } = JSON.parse(output.trim().split('\n').at(-1)!) as { problems: number, loaded: string[] }

    expect(errors).toBe('')
    expect(loaded).toEqual([])
  }, 60_000)
})
