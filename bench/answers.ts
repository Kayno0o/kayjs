import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { files, memoryFiles, pages } from '../src/server'
import { scratchDir } from '../tests/scratch'

// Requests per second of each kind of answer through `app.handle`, no socket: `bun bench/answers.ts [rounds]`.
const root = await scratchDir('answers-bench-')

await cp(join(import.meta.dir, '../tests/fixtures/answers'), root, { recursive: true })

const app = await pages({ root, api: join(root, 'src/api'), prebuilt: false, log: false, compress: true, storage: memoryFiles() })
const key = await files.put(new File([new Uint8Array(2000)], 'a.png', { type: 'image/png' }))
const html = await (await app.handle(new Request('http://localhost/'))).text()
const asset = (/\/_kay\/assets\/[^"')\s]+\.png/).exec(html)?.[0]
const form = (/<form[^>]*action="([^"]+)"/).exec(html)?.[1]?.replaceAll('&amp;', '&')

const origin = 'http://localhost'
const cases: Record<string, () => Request> = {
  page: () => new Request(`${origin}/`, { headers: { 'accept-encoding': 'br' } }),
  api: () => new Request(`${origin}/api/items`),
  apiHeaded: () => new Request(`${origin}/api/items/headed`),
  asset: () => new Request(`${origin}${asset}`),
  file: () => new Request(`${origin}${files.url(key)}`),
  action: () => new Request(`${origin}${form}`, { method: 'POST', body: new URLSearchParams({ title: 'x' }), headers: { origin, referer: `${origin}/` } }),
}
const rounds = Number(Bun.argv[2] ?? 5000)

for (const [name, make] of Object.entries(cases)) {
  const probe = await app.handle(make())

  console.log(name, probe.status, [...probe.headers.keys()].join(','))

  for (let i = 0; i < 300; i++)
    await (await app.handle(make())).arrayBuffer()

  const start = Bun.nanoseconds()

  for (let i = 0; i < rounds; i++)
    await (await app.handle(make())).arrayBuffer()

  console.log(name.padEnd(10), Math.round(rounds / ((Bun.nanoseconds() - start) / 1e9)), 'req/s')
}

await rm(root, { recursive: true, force: true })
process.exit(0)
