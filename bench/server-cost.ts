import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { anonOf, compiled, cpuOf, hammer, started } from './shared/process'

// What the compiled bench app costs to serve, for each kay checkout given, as a markdown table for an issue: a fresh executable per round, interleaved, so the shared host's load weighs on each alike.
// `bun bench/server-cost.ts [--rounds 5] <checkout>...`, each checkout installed (`bun install`), an older one as a detached worktree of its tag: `git worktree add --detach ../kay-1.31 v1.31.0`.
const ENTRY = `import { createApp } from '../app'

const app = await createApp()
const server = Bun.serve({ port: 0, fetch: async request => app.handle(request) })

console.log(\`ready \${server.port}\`)
process.on('SIGTERM', () => process.exit(0))
`
const CHROME = 'gzip, deflate, br, zstd'
const NO_ZSTD = 'gzip, deflate, br'
const LABELS: Record<string, string> = { identity: 'uncompressed', [CHROME]: 'Chrome', [NO_ZSTD]: 'no zstd' }
const LOADS = [['/', 'identity'], ['/', CHROME], ['/', NO_ZSTD], ['/table', 'identity'], ['/table', CHROME], ['/table', NO_ZSTD]] as const
const WARM = 300
const MEASURED = 4000
const AT_ONCE = 16

const args = Bun.argv.slice(2)
const roundsAt = args.indexOf('--rounds')
const rounds = roundsAt === -1 ? 5 : Number(args.splice(roundsAt, 2)[1])
const checkouts = args.map(path => resolve(path))

if (checkouts.length === 0)
  throw new Error('Expected one kay checkout or more')

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

const executables = await Promise.all(checkouts.map(async (checkout, index) => compiled(checkout, ENTRY, 'server-cost', join(import.meta.dir, '../.kay/server-cost', String(index)))))
const results = executables.map(() => new Map<string, number[]>())
const record = (index: number, metric: string, value: number) => results[index]!.set(metric, [...results[index]!.get(metric) ?? [], value])

for (let round = 0; round < rounds; round++) {
  for (const [index, executable] of executables.entries()) {
    const before = performance.now()
    const { server, origin } = await started(executable)

    await (await fetch(`${origin}/`, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer()
    record(index, 'first page (ms)', performance.now() - before)
    record(index, 'CPU to first page (ms)', await cpuOf(server.pid))
    record(index, 'anon after one page (MiB)', await anonOf(server.pid))
    server.kill()
    await server.exited

    for (const [path, encoding] of LOADS) {
      const { server: loaded, origin: at } = await started(executable)
      const label = `${path} ${LABELS[encoding]}`

      await hammer(`${at}${path}`, encoding, WARM, AT_ONCE)

      const cpu = await cpuOf(loaded.pid)
      const start = performance.now()

      await hammer(`${at}${path}`, encoding, MEASURED, AT_ONCE)
      record(index, `${label}: CPU per request (us)`, (await cpuOf(loaded.pid) - cpu) * 1000 / MEASURED)
      record(index, `${label}: requests/s`, MEASURED / (performance.now() - start) * 1000)
      record(index, `${label}: anon after (MiB)`, await anonOf(loaded.pid))
      loaded.kill()
      await loaded.exited
    }
  }
}

const shas = await Promise.all(checkouts.map(async checkout => (await Bun.$`git -C ${checkout} describe --tags --always`.text()).trim()))

console.log(`bench/apps/kay compiled, median (range) of ${rounds} rounds, ${MEASURED} requests at ${AT_ONCE} at once after ${WARM}; load average ${(await readFile('/proc/loadavg', 'utf8')).split(' ').slice(0, 3).join(' ')}\n`)
console.log(`| metric | ${shas.join(' | ')} |`)
console.log(`|---|${shas.map(() => '---').join('|')}|`)

for (const metric of results[0]!.keys()) {
  const cells = results.map((byMetric) => {
    const values = byMetric.get(metric)!

    return `${median(values).toFixed(1)} (${Math.min(...values).toFixed(0)}-${Math.max(...values).toFixed(0)})`
  })

  console.log(`| ${metric} | ${cells.join(' | ')} |`)
}
