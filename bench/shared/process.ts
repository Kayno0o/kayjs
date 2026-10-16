import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const READY = /ready (\d+)/
const ANON = /RssAnon:\s+(\d+)/
const PID = /^\d+$/

// `checkout`'s bench/apps/kay compiled to `out`, its server entry `entry` written beside the app as `.kay/<name>.ts`.
export async function compiled(checkout: string, entry: string, name: string, out: string): Promise<string> {
  const app = join(checkout, 'bench/apps/kay')

  await mkdir(join(app, '.kay'), { recursive: true })
  await Bun.write(join(app, `.kay/${name}.ts`), entry)

  const build = Bun.spawn(['bun', join(checkout, 'src/cli.ts'), 'build', '--compile', out, '--entry', `.kay/${name}.ts`, '--no-check'], { cwd: app, stdout: 'ignore', stderr: 'pipe' })

  if (await build.exited !== 0)
    throw new Error(`${checkout} did not compile: ${await new Response(build.stderr).text()}`)

  return out
}

// The fields of /proc/<pid>/stat past the command's name, which may hold spaces: the state first, the parent's pid second.
async function statOf(pid: number): Promise<string[] | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')

    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  }
  catch {
    return undefined
  }
}

// The process's own CPU, user and system, in ms.
export async function cpuOf(pid: number): Promise<number> {
  const fields = (await statOf(pid))!

  return (Number(fields[11]) + Number(fields[12])) * 10
}

// The process and every descendant still running.
export async function treeOf(root: number): Promise<number[]> {
  const pids = (await readdir('/proc')).filter(name => PID.test(name)).map(Number)
  const children = new Map<number, number[]>()

  for (const pid of pids) {
    const fields = await statOf(pid)

    if (fields !== undefined)
      children.set(Number(fields[1]), [...children.get(Number(fields[1])) ?? [], pid])
  }

  const tree = [root]

  // The loop reaches the children pushed as it goes.
  for (const pid of tree)
    tree.push(...children.get(pid) ?? [])

  return tree
}

// The CPU of a process and its descendants in ms, those it already reaped included.
export async function treeCpuOf(root: number): Promise<number> {
  let total = 0

  for (const pid of await treeOf(root)) {
    const fields = await statOf(pid)

    if (fields !== undefined)
      total += (Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14])) * 10
  }

  return total
}

// Anonymous resident memory in MiB: the heap and what native code allocated, without the mapped executable.
export async function anonOf(pid: number): Promise<number> {
  return Number(ANON.exec(await readFile(`/proc/${pid}/status`, 'utf8'))![1]) / 1024
}

// The 1-minute load average.
export async function loadNow(): Promise<number> {
  const loads = await readFile('/proc/loadavg', 'utf8')

  return Number(loads.slice(0, loads.indexOf(' ')))
}

// A compiled bench server started, once it printed the port it listens on.
export async function started(executable: string): Promise<{ server: Bun.Subprocess<'ignore', 'pipe', 'ignore'>, origin: string }> {
  const server = Bun.spawn([executable], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, NODE_ENV: 'production' } })
  let output = ''

  for await (const chunk of server.stdout) {
    output += new TextDecoder().decode(chunk)

    if (READY.test(output))
      break
  }

  return { server, origin: `http://127.0.0.1:${READY.exec(output)![1]}` }
}

// `total` requests to `url`, `atOnce` in flight.
export async function hammer(url: string, encoding: string, total: number, atOnce: number): Promise<void> {
  let left = total

  await Promise.all(Array.from({ length: atOnce }, async () => {
    while (left-- > 0)
      await (await fetch(url, { headers: { 'accept-encoding': encoding } })).arrayBuffer()
  }))
}
