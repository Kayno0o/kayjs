import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { files, memoryFiles, pages } from '../src/server'
import { scratchDir } from '../tests/scratch'

// CPU microseconds per request of each kind of answer through `app.handle`, no socket: `bun bench/answers.ts [rounds]`.
const root = await scratchDir('answers-bench-')

await cp(join(import.meta.dir, '../tests/fixtures/answers'), root, { recursive: true })

const app = await pages({ root, api: join(root, 'src/api'), prebuilt: false, log: false, compress: true, storage: memoryFiles() })
const key = await files.put(new File([new Uint8Array(2000)], 'a.png', { type: 'image/png' }))
const html = await (await app.handle(new Request('http://localhost/'))).text()
const asset = (/\/_kay\/entry-[^"]+\.js/).exec(html)?.[0]
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
const only = Bun.argv[3]?.split(',')
const repeats = Number(Bun.argv[4] ?? 5)
// The body is left unread with a fifth argument, to see what an answer costs before its bytes are read.
const read = async (response: Response) => Bun.argv[5] === 'nobody' ? response : response.arrayBuffer()

for (const [name, make] of Object.entries(cases)) {
  if (only && !only.includes(name))
    continue

  await app.handle(make())

  for (let i = 0; i < 300; i++)
    await read(await app.handle(make()))

  // CPU time rather than wall time, which other processes on the machine stretch.
  const best: number[] = []

  for (let round = 0; round < repeats; round++) {
    const start = process.cpuUsage()

    for (let i = 0; i < rounds; i++)
      await read(await app.handle(make()))

    const used = process.cpuUsage(start)

    best.push((used.user + used.system) / rounds)
  }

  console.log(name.padEnd(10), Math.min(...best).toFixed(2), `us/request (best of ${repeats})`)
}

await rm(root, { recursive: true, force: true })
process.exit(0)
