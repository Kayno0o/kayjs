import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const SRC = join(import.meta.dir, '..', 'src', 'test')
const NAMES = ['fetch', 'Request', 'Response', 'Headers', 'Blob', 'File', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'WebSocket']

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

it('leaves the web globals as Bun has them and still registers a document when kay/test/dom is preloaded', async () => {
  const dir = await scratchDir('test-dom-preload-')

  dirs.push(dir)

  const file = join(dir, 'serve.test.ts')

  await Bun.write(file, `
import { expect, it } from 'bun:test'

const names = ${JSON.stringify(NAMES)}

it('serves and fetches with Bun', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })

  try {
    const response = await fetch(String(server.url))

    expect(await response.json()).toEqual({ ok: true })
  }
  finally {
    await server.stop(true)
  }
})

it('reads a form into a FormData that Bun can still send', async () => {
  document.body.innerHTML = '<form><input name="a" value="1"><select name="b"><option value="x" selected>x</option></select></form>'

  const data = new FormData(document.querySelector('form')!)
  const server = Bun.serve({ port: 0, fetch: async request => Response.json([...(await request.formData()).entries()]) })

  try {
    expect([...data.entries()]).toEqual([['a', '1'], ['b', 'x']])
    expect(await (await fetch(String(server.url), { method: 'POST', body: data })).json()).toEqual([['a', '1'], ['b', 'x']])
  }
  finally {
    await server.stop(true)
  }
})

it('carries a file input\\'s file into the FormData with its name, type and bytes', async () => {
  const { File: DomFile } = await import('happy-dom')

  document.body.innerHTML = '<form><input type="file" name="doc"><input type="file" name="own"></form>'

  const [doc, own] = [...document.querySelectorAll('input')] as unknown as { files: unknown }[]

  doc!.files = [new DomFile(['hello'], 'a.txt', { type: 'text/plain' })]
  own!.files = [new File(['bun'], 'b.txt', { type: 'text/plain' })]

  const data = new FormData(document.querySelector('form')!)
  const file = data.get('doc') as File
  const bun = data.get('own') as File

  expect(file.name).toBe('a.txt')
  expect(file.type).toStartWith('text/plain')
  expect(await file.text()).toBe('hello')
  expect(bun.name).toBe('b.txt')
  expect(await bun.text()).toBe('bun')
})

it('keeps every web global native, with a document beside them', () => {
  expect(typeof document.createElement).toBe('function')

  for (const name of names)
    expect(String((globalThis as Record<string, unknown>)[name])).toContain('[native code]')
})
`)

  const child = Bun.spawn(['bun', 'test', '--preload', join(SRC, 'preload.ts'), '--preload', join(SRC, 'dom.ts'), file], { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, KAY_TEST_CHILD: '1' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect(`${out}${err}`).toContain('4 pass')
  expect(code).toBe(0)
}, 60_000)
