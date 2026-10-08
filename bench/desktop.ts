import type { Subprocess } from 'bun'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { median, table } from './format'

// What a desktop app costs in memory beside the same app as a plain server, on Linux: `bun bench/desktop.ts`, which opens a window for a few seconds; `--headless` leaves that one out.
const REPO = join(import.meta.dir, '..')
const APP = join(REPO, 'examples', 'reading-list')
const OUT = join(import.meta.dir, '.desktop')
const SETTLE_MS = 5000
const SAMPLES = 5
const REQUESTS = 50
const VM_RSS = /^VmRSS:\s+(\d+) kB/m
const PSS = /^Pss:\s+(\d+) kB/m
const LISTENING = /localhost:(\d+)/
const OPEN = /Open (\S+)/
const STAT_PPID = /^\d+ \(.*\) \S (\d+)/
const PID = /^\d+$/

interface Sample {
  processes: number
  rss: number
  pss: number
  // PSS by process name, the webview's own processes apart from the app's.
  byName: Map<string, { count: number, pss: number }>
}

interface Variant {
  name: string
  argv: string[]
  // The URL the app serves its home at, once it says so; none for the window, which no one but it reaches.
  ready?: (output: string) => string | undefined
  // The cookie a request needs, traded for the secret the URL carries.
  cookie?: boolean
  // Set over the environment, to try what GTK and WebKit read from it.
  env?: Record<string, string>
}

// The renderers GTK and WebKitGTK document switching through the environment, each costing GPU driver memory in the process using it.
const WINDOW_ENVS: Record<string, string>[] = [
  {},
  { GSK_RENDERER: 'cairo' },
  { WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1' },
  { WEBKIT_DISABLE_DMABUF_RENDERER: '1' },
  { GSK_RENDERER: 'cairo', WEBKIT_SKIA_ENABLE_CPU_RENDERING: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1' },
]

const headless = process.argv.includes('--headless')

if (process.platform !== 'linux')
  throw new Error('bench/desktop.ts reads /proc, so it runs on Linux')

await mkdir(OUT, { recursive: true })
await build(['--compile', join(OUT, 'server')])
await build(['--desktop', join(OUT, 'app')])

const variants: Variant[] = [
  { name: '`--compile` server', argv: [join(OUT, 'server')], ready: output => LISTENING.test(output) ? `http://localhost:${LISTENING.exec(output)![1]}/` : undefined },
  { name: '`--desktop --no-window`', argv: [join(OUT, 'app'), '--no-window'], ready: output => OPEN.exec(output)?.[1], cookie: true },
  ...headless ? [] : WINDOW_ENVS.map(env => ({ name: `\`--desktop\`, window open${Object.keys(env).length === 0 ? '' : `, ${Object.entries(env).map(([name, value]) => `${name}=${value}`).join(' ')}`}`, argv: [join(OUT, 'app')], env })),
]
const rows: string[][] = []
const breakdowns: string[] = []

for (const variant of variants) {
  const { idle, loaded } = await measure(variant)

  rows.push([variant.name, String(idle.processes), mb(idle.rss), mb(idle.pss), loaded ? mb(loaded.rss) : '-', loaded ? mb(loaded.pss) : '-'])

  if (idle.processes > 1)
    breakdowns.push(`\n${variant.name}, idle PSS by process:\n\n${table(['Process', 'Count', 'PSS'], [...idle.byName].sort(([, a], [, b]) => b.pss - a.pss).map(([name, { count, pss }]) => [name, String(count), mb(pss)]))}`)
}

console.log(`\nreading-list example, ${SAMPLES} samples ${SETTLE_MS / 1000} s after start, medians; loaded is after ${REQUESTS} requests to its home. PSS splits pages shared between processes, so it adds up across them where RSS counts shared libraries once per process.\n`)
console.log(table(['Run', 'Processes', 'RSS idle', 'PSS idle', 'RSS loaded', 'PSS loaded'], rows))
console.log(breakdowns.join('\n'))

async function build(flags: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, join(REPO, 'src/cli.ts'), 'build', APP, '--no-check', ...flags], { stdout: 'ignore', stderr: 'pipe' })

  if (await child.exited !== 0)
    throw new Error(`kay build ${flags.join(' ')} failed: ${await new Response(child.stderr).text()}`)
}

async function measure(variant: Variant): Promise<{ idle: Sample, loaded?: Sample }> {
  const child = Bun.spawn(variant.argv, { cwd: OUT, env: { ...process.env, PORT: '0', NODE_ENV: 'production', ...variant.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })

  try {
    const url = variant.ready ? await readyUrl(child, variant.ready) : undefined

    await Bun.sleep(SETTLE_MS)

    const idle = await sampled(child.pid)

    if (url === undefined)
      return { idle }

    const headers = variant.cookie ? await cookieFor(url) : {}
    const home = new URL('/', url)

    for (let i = 0; i < REQUESTS; i++)
      await (await fetch(home, { headers })).arrayBuffer()

    return { idle, loaded: await sampled(child.pid) }
  }
  finally {
    child.kill('SIGTERM')
    await child.exited
  }
}

async function readyUrl(child: Subprocess<'ignore', 'pipe', 'inherit'>, ready: (output: string) => string | undefined): Promise<string> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let url = ready(output); ; url = ready(output)) {
    if (url !== undefined) {
      reader.releaseLock()

      return url
    }

    const { value, done } = await reader.read()

    if (done)
      throw new Error(`${child.pid} exited before it listened`)

    output += new TextDecoder().decode(value)
  }
}

async function cookieFor(url: string): Promise<Record<string, string>> {
  const cookie = (await fetch(url, { redirect: 'manual' })).headers.get('set-cookie')!

  return { cookie: cookie.slice(0, cookie.indexOf(';')) }
}

async function sampled(pid: number): Promise<Sample> {
  const samples: Sample[] = []

  for (let i = 0; i < SAMPLES; i++) {
    samples.push(treeMemory(pid))
    await Bun.sleep(1000)
  }

  return { processes: Math.max(...samples.map(sample => sample.processes)), rss: median(samples.map(sample => sample.rss)), pss: median(samples.map(sample => sample.pss)), byName: samples.at(-1)!.byName }
}

// The process and every one it started, the webview's own included, which WebKitGTK starts under a sandbox of its own.
function treeMemory(root: number): Sample {
  const children = new Map<number, number[]>()

  for (const name of readdirSync('/proc').filter(entry => PID.test(entry))) {
    const ppid = Number(STAT_PPID.exec(readable(`/proc/${name}/stat`))?.[1])

    children.set(ppid, [...children.get(ppid) ?? [], Number(name)])
  }

  const tree = [root]

  // An array iterator reads the length as it goes, so it reaches the children pushed behind it.
  for (const pid of tree)
    tree.push(...children.get(pid) ?? [])

  const byName = new Map<string, { count: number, pss: number }>()

  for (const pid of tree) {
    const name = readable(`/proc/${pid}/comm`).trim()
    const entry = byName.get(name) ?? { count: 0, pss: 0 }

    byName.set(name, { count: entry.count + 1, pss: entry.pss + kilobytes(PSS, `/proc/${pid}/smaps_rollup`) })
  }

  return {
    processes: tree.length,
    rss: tree.reduce((sum, pid) => sum + kilobytes(VM_RSS, `/proc/${pid}/status`), 0),
    pss: tree.reduce((sum, pid) => sum + kilobytes(PSS, `/proc/${pid}/smaps_rollup`), 0),
    byName,
  }
}

// A process may be gone between listing it and reading it.
function readable(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return ''
  }
}

function kilobytes(field: RegExp, path: string): number {
  return Number(field.exec(readable(path))?.[1] ?? 0) * 1024
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
