import type { Part, Readings } from './soak-verdict'
import { openSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { anonOf, compiled, cpuOf, hammer, loadNow, started, treeCpuOf, treeOf } from './shared/process'
import { growth, verdict } from './soak-verdict'

// Whether kay keeps memory it should let go, over thousands of requests to a compiled server and hundreds of edits in `kay dev`, and what each costs in CPU against a baseline checkout, the last release in the nightly run.
// `bun bench/soak.ts [--wait <minutes>] [--requests 50000] [--edits 180] <checkout> [<baseline>]`, each checkout installed; exits 1 when the checkout's memory grows past its limits, or its CPU rises past the margin on a quiet host.
const PROBE = `Bun.gc(true)\n  return Response.json({ heap: process.memoryUsage().heapUsed, pid: process.pid })`
const SERVER_ENTRY = `import { createApp } from '../app'

const app = await createApp()
const server = Bun.serve({ port: 0, fetch: async (request) => {
  if (!request.url.endsWith('/__soak'))
    return app.handle(request)

  ${PROBE}
} })

console.log(\`ready \${server.port}\`)
process.on('SIGTERM', () => process.exit(0))
`
const DEV_ENTRY = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().get('/__soak', () => {
  ${PROBE}
}).use(await pages()).listen(Number(process.env.PORT))
`
const PATHS = ['/', '/table']
const CHROME = 'gzip, deflate, br, zstd'
const AT_ONCE = 8
const SAMPLES = 10
const MIB = 1024 * 1024
const CORES = navigator.hardwareConcurrency
// The wait for a quiet host ends once the load drops under a quarter of the cores; a run is quiet while it stays under half, the soak's own processes taking two or three.
const START_LOAD = CORES / 4
const QUIET_LOAD = CORES / 2
const LIMITS = { server: { heap: 2, anon: 8 }, dev: { heap: 2, anon: 16 } }

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { wait: { type: 'string', default: '0' }, requests: { type: 'string', default: '50000' }, edits: { type: 'string', default: '180' } } })
const checkouts = positionals.map(path => resolve(path))
const [wait, requests, edits] = [values.wait, values.requests, values.edits].map(Number) as [number, number, number]
// A tenth of the edits warms up, the rest split evenly between the samples, so the run stays within the count asked.
const warmEdits = Math.floor(edits / SAMPLES)
const editsBetween = Math.floor((edits - warmEdits) / SAMPLES)
const loads: number[] = []

if (checkouts.length === 0 || checkouts.length > 2)
  throw new Error('Expected a kay checkout, and a baseline checkout to compare its CPU with')

if (![wait, requests, edits].every(value => Number.isFinite(value) && value >= 0) || editsBetween === 0)
  throw new Error(`Expected --wait, --requests and --edits as numbers, --edits ${SAMPLES * 2} or more`)

async function until(condition: () => Promise<boolean>, timeout: number, what: string): Promise<void> {
  for (const start = Date.now(); !await condition(); await Bun.sleep(25)) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for ${what}`)
  }
}

async function text(url: string): Promise<string> {
  try {
    return await (await fetch(url)).text()
  }
  catch {
    return ''
  }
}

// The heap after a forced collection and the anonymous memory of the process answering `/__soak`, the load taken alongside.
async function probe(origin: string): Promise<{ heap: number, anon: number, pid: number }> {
  const { heap, pid } = await (await fetch(`${origin}/__soak`)).json() as { heap: number, pid: number }

  loads.push(await loadNow())

  return { heap: heap / MIB, anon: await anonOf(pid), pid }
}

async function waitQuiet(minutes: number): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < minutes * 60_000; await Bun.sleep(30_000)) {
    if (await loadNow() < START_LOAD)
      return true
  }

  return minutes === 0 || await loadNow() < START_LOAD
}

// A compiled bench app through `requests` requests across its pages after a warm-up, CPU in µs per request.
async function soakServer(checkout: string, index: number): Promise<Readings> {
  const executable = await compiled(checkout, SERVER_ENTRY, 'soak', join(import.meta.dir, '../.kay/soak/server', String(index)))
  const { server, origin } = await started(executable)
  const batch = Math.ceil(requests / SAMPLES / PATHS.length)
  const readings: Readings = { heap: [], anon: [], processes: 0, cpu: 0 }
  const pids = new Set<number>()

  try {
    await Promise.all(PATHS.map(async path => hammer(origin + path, CHROME, batch, AT_ONCE)))

    for (let sample = 0; sample < SAMPLES; sample++) {
      const before = await cpuOf(server.pid)

      await Promise.all(PATHS.map(async path => hammer(origin + path, CHROME, batch, AT_ONCE)))
      readings.cpu += await cpuOf(server.pid) - before

      const { heap, anon, pid } = await probe(origin)

      readings.heap.push(heap)
      readings.anon.push(anon)
      pids.add(pid)
    }

    readings.cpu = readings.cpu * 1000 / (batch * PATHS.length * SAMPLES)
    readings.processes = pids.size

    return readings
  }
  finally {
    server.kill()
    await server.exited
  }
}

// A free port, which `kay dev` is then told to take.
function freePort(): number {
  const listener = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })
  const { port } = listener

  listener.stop(true)

  return port
}

// `kay dev` on a project of its own through `edits` edits, alternating a page and a component it renders, CPU in ms per edit across every process of the session.
// The default stays within one server process's life, as kay dev replaces it after 200 reloads.
async function soakDev(checkout: string): Promise<Readings> {
  // Inside the checkout, so the project imports its kay and Elysia.
  const root = join(checkout, '.kay/soak/dev')
  const port = freePort()
  const origin = `http://localhost:${port}`
  const page = (edit: number) => `---\nimport Note from '../note.kay'\n---\nh1 Edit ${edit}\nNote\np ${'x'.repeat(20_000)} ${edit}\n`
  const readings: Readings = { heap: [], anon: [], processes: 0, cpu: 0 }
  const pids = new Set<number>()

  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'src/routes'), { recursive: true })
  await Bun.write(join(root, 'src/server.ts'), DEV_ENTRY)
  await Bun.write(join(root, 'src/note.kay'), 'p Note 0\n')
  await Bun.write(join(root, 'src/routes/index.kay'), page(0))

  const output = openSync(join(root, 'dev.log'), 'w')
  const session = Bun.spawn(['bun', join(checkout, 'src/cli.ts'), 'dev', root, '--port', String(port)], { cwd: root, stdout: output, stderr: output, stdin: 'ignore' })
  let edit = 0
  const nextEdit = async () => {
    edit++

    const [path, content, shows] = edit % 2 === 0 ? ['src/routes/index.kay', page(edit), `Edit ${edit}`] : ['src/note.kay', `p Note ${edit}\n`, `Note ${edit}`]

    await Bun.write(join(root, path), content)
    await until(async () => (await text(origin)).includes(shows), 60_000, `edit ${edit} in kay dev, see ${root}/dev.log`)
  }

  try {
    await until(async () => (await text(origin)).includes('Edit 0'), 120_000, `kay dev to serve, see ${root}/dev.log`)

    for (let at = 0; at < warmEdits; at++)
      await nextEdit()

    for (let sample = 0; sample < SAMPLES; sample++) {
      const before = await treeCpuOf(session.pid)

      for (let at = 0; at < editsBetween; at++)
        await nextEdit()

      readings.cpu += await treeCpuOf(session.pid) - before

      const { heap, anon, pid } = await probe(origin)

      readings.heap.push(heap)
      readings.anon.push(anon)
      pids.add(pid)
    }

    readings.cpu /= editsBetween * SAMPLES
    readings.processes = pids.size

    return readings
  }
  finally {
    const tree = await treeOf(session.pid)

    session.kill('SIGINT')
    await Promise.race([session.exited, Bun.sleep(10_000)])

    // What outlived the session: a child it could not stop in time.
    for (const pid of tree) {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {}
    }
  }
}

const waited = await waitQuiet(wait)
const startLoad = await loadNow()
const problems: string[] = []

// The checkout's soak failing ends the run; the baseline's only drops the comparison, so memory is still judged.
async function soaked(index: number, what: string, soak: () => Promise<Readings>): Promise<Readings | undefined> {
  if (index === 0)
    return soak()

  try {
    return await soak()
  }
  catch (error) {
    problems.push(`the baseline's ${what} did not run, CPU not compared: ${error instanceof Error ? error.message : String(error)}`)

    return undefined
  }
}

const servers: (Readings | undefined)[] = []
const devs: (Readings | undefined)[] = []

for (const [index, checkout] of checkouts.entries())
  servers.push(await soaked(index, 'compiled server', async () => soakServer(checkout, index)))

for (const [index, checkout] of checkouts.entries())
  devs.push(await soaked(index, 'kay dev', async () => soakDev(checkout)))

const quiet = waited && [startLoad, ...loads].every(load => load < QUIET_LOAD)
const parts: Part[] = [
  { name: 'compiled server', unit: 'request (µs)', limits: LIMITS.server, current: servers[0]!, baseline: servers[1] },
  { name: 'kay dev', unit: 'edit (ms)', limits: LIMITS.dev, current: devs[0]!, baseline: devs[1] },
]
const names = await Promise.all(checkouts.map(async checkout => (await Bun.$`git -C ${checkout} describe --tags --always`.nothrow().quiet().text()).trim() || basename(checkout)))
const { failures, notes } = verdict(parts, quiet)

const waitedOut = waited ? '' : `, the load staying over ${START_LOAD} through the ${wait}-minute wait`

console.log(`${requests} requests to the compiled bench app, ${warmEdits + editsBetween * SAMPLES} edits in kay dev; load ${startLoad} at the start, at most ${Math.max(startLoad, ...loads)} during the run on ${CORES} cores: ${quiet ? 'quiet' : 'busy'}${waitedOut}\n`)
console.log(`| metric | ${names.join(' | ')} |`)
console.log(`|---|${names.map(() => '---').join('|')}|`)

for (const [{ name, unit }, of] of [[parts[0]!, servers], [parts[1]!, devs]] as const) {
  const row = (metric: string, value: (readings: Readings) => number) => console.log(`| ${name}: ${metric} | ${of.map(readings => readings === undefined ? '-' : value(readings).toFixed(1)).join(' | ')} |`)

  row(`CPU per ${unit}`, readings => readings.cpu)
  row('heap growth, second half (MiB)', readings => growth(readings.heap))
  row('anon growth, second half (MiB)', readings => growth(readings.anon))
  row('heap at the end (MiB)', readings => readings.heap.at(-1)!)
  row('anon at the end (MiB)', readings => readings.anon.at(-1)!)
}

for (const line of [...problems, ...notes, ...failures.map(failure => `FAILED ${failure}`)])
  console.log(`\n${line}`)

process.exit(failures.length > 0 ? 1 : 0)
