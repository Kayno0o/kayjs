import type { Subprocess } from 'bun'
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it, spyOn } from 'bun:test'
import { testWorker } from '../src/build/assets'
import { ConfigRefusedError, dev } from '../src/dev'
import * as fingerprint from '../src/dev/fingerprint'
import { FINGERPRINT } from '../src/dev/fingerprint'
import { freePort } from './free-port'

const PARENT_PID = /\) \S+ (\d+)/

// This process's children running `script` for the project at `real`, its real path.
function childrenRunning(real: string, script: string): string[] {
  return readdirSync('/proc').filter((pid) => {
    try {
      return PARENT_PID.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1] === String(process.pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(script) && readlinkSync(`/proc/${pid}/cwd`) === real
    }
    catch {
      return false
    }
  })
}

async function until(condition: () => boolean, timeout = 20_000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// A project under node_modules/.cache, where it resolves kay as the fixtures do.
async function project(prefix: string, files: Record<string, string>): Promise<string> {
  const scratch = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, prefix))

  await Promise.all(Object.entries(files).map(async ([file, content]) => Bun.write(join(root, file), content)))

  return root
}

// Every source written a minute ago, as by the time a project is started again: a file written just before a build or a load cannot be told apart from one changed while it ran.
function settle(root: string): void {
  const past = new Date(Date.now() - 60_000)

  for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(file.parentPath, file.name)

    if (file.isFile() && !path.includes('/.kay/'))
      utimesSync(path, past, past)
  }
}

const dist = (root: string) => join(root, '.kay', `dev${testWorker()}`)
const manifestTime = (root: string) => statSync(join(dist(root), 'manifest.json')).mtimeMs

const SERVER = (name: string) => `Bun.serve({ port: 0, fetch: () => new Response(${JSON.stringify(name)}) })\n`
const COUNTER = (label: string) => `---\nimport { signal } from 'kay'\nimport { label } from '#label'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(n => n + 1)}) ${label} {label} {count()}\n`
const PAGES = {
  'src/counter.kay': COUNTER('one'),
  'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
  'src/label-a.ts': 'export const label = \'LABEL_A\'\n',
  'src/label-b.ts': 'export const label = \'LABEL_B\'\n',
  'kay.config.ts': 'export default {}\n',
}

it('leaves the server alone for an edit of package.json that resolves nothing, and builds the client again with the new resolution for one that does', async () => {
  const root = await project('dev-package-', { ...PAGES, 'package.json': JSON.stringify({ name: 'package-edits', version: '1.0.0', scripts: { dev: 'kay dev' }, imports: { '#label': './src/label-a.ts' } }) })
  const real = realpathSync(root)
  const lines: string[] = []
  const children: Subprocess[] = []
  const bundle = () => readdirSync(join(dist(root), 'dist'), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => entry.name).map(file => readFileSync(join(dist(root), 'dist', file), 'utf8')).join('\n')
  const restarts = () => lines.filter(line => line.includes('package.json: restarted'))
  const pkg = async (changes: Record<string, unknown>) => Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'package-edits', version: '1.0.0', scripts: { dev: 'kay dev' }, imports: { '#label': './src/label-a.ts' }, ...changes }))
  const stop = await dev(root, { port: freePort(), log: line => lines.push(line), onRestart: child => children.push(child) })

  try {
    await until(() => lines.some(line => line.includes('ready in')))
    await until(() => bundle().includes('LABEL_A'))

    expect(childrenRunning(real, 'builder.ts')).toHaveLength(1)

    // A script, the version, the description and the order of the fields leave everything as it is.
    await pkg({ version: '1.0.1', scripts: { dev: 'kay dev --open', test: 'bun test' }, description: 'edited' })
    await Bun.sleep(1500)
    expect(restarts()).toEqual([])
    expect(children).toHaveLength(1)

    // An import it resolves differently restarts the server and builds the client again, which a process that built it before would do with the old import.
    await pkg({ imports: { '#label': './src/label-b.ts' } })
    await until(() => restarts().length === 1)
    await until(() => bundle().includes('LABEL_B'))
    expect(bundle()).not.toContain('LABEL_A')
    expect(children).toHaveLength(2)
    expect(childrenRunning(real, 'builder.ts')).toHaveLength(1)

    // A dependency added restarts it too, and a file that does not parse, then parses again.
    await pkg({ imports: { '#label': './src/label-b.ts' }, dependencies: { 'left-pad': '*' } })
    await until(() => restarts().length === 2)
    await Bun.write(join(root, 'package.json'), '{ "name": ')
    await until(() => restarts().length === 3)
    await pkg({ imports: { '#label': './src/label-a.ts' } })
    await until(() => restarts().length === 4)
    await until(() => bundle().includes('LABEL_A') && !bundle().includes('LABEL_B'))
    expect(childrenRunning(real, 'builder.ts')).toHaveLength(1)
  }
  finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it('answers a burst of inert package.json edits with one scan, and one more for the edits that came in during it', async () => {
  const root = await project('dev-burst-', { ...PAGES, 'package.json': JSON.stringify({ name: 'burst', version: '1.0.0', imports: { '#label': './src/label-a.ts' } }) })
  const lines: string[] = []
  const edit = async (version: string) => Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'burst', version, imports: { '#label': './src/label-a.ts' } }))
  // The watcher hands events over in order: once an edit of another file is answered, those before it were seen, so a scan they would start has started.
  const sentinel = async (mark: string) => {
    const seen = lines.length

    await Bun.write(join(root, 'src/label-a.ts'), `export const label = 'LABEL_A'\n// ${mark}\n`)
    await until(() => lines.slice(seen).some(line => line.includes('label-a.ts')))
  }
  const { promise: gate, resolve: release } = Promise.withResolvers<void>()
  const scans = spyOn(fingerprint, 'mentionsPackage').mockImplementation(async () => {
    await gate

    return false
  })
  const stop = await dev(root, { port: freePort(), log: line => lines.push(line) })

  try {
    await until(() => lines.some(line => line.includes('ready in')))
    await edit('1.0.1')
    await until(() => scans.mock.calls.length === 1)

    // The first scan is still running: these three are answered by one more.
    await edit('1.0.2')
    await edit('1.0.3')
    await edit('1.0.4')
    await sentinel('one')
    expect(scans).toHaveBeenCalledTimes(1)

    release()
    await until(() => scans.mock.calls.length === 2)
    await sentinel('two')
    expect(scans).toHaveBeenCalledTimes(2)
    expect(lines.filter(line => line.includes('package.json: restarted'))).toEqual([])
  }
  finally {
    release()
    scans.mockRestore()
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it('starts the server on the entry it knows when kay.config.ts changes, without waiting for the types, and follows the entry the types then tell', async () => {
  const marker = join(await mkdtemp(join(process.cwd(), 'node_modules/.cache/dev-config-')), 'typed')
  const slow = (entry: string) => `import { writeFileSync } from 'node:fs'\n\nif (process.argv[1]?.endsWith('types.ts')) {\n  await Bun.sleep(4000)\n  writeFileSync(${JSON.stringify(marker)}, 'x')\n}\n\nexport default { entry: ${JSON.stringify(entry)} }\n`
  const root = await project('dev-config-', { 'src/one.ts': SERVER('one'), 'src/two.ts': SERVER('two'), 'kay.config.ts': 'export default { entry: \'src/one.ts\' }\n' })
  const lines: string[] = []
  const children: Subprocess[] = []
  const stop = await dev(root, { log: line => lines.push(line), onRestart: child => children.push(child) })

  try {
    await until(() => lines.some(line => line.includes('ready in')))

    // The same entry: one new server, started while the types are still being written.
    await Bun.write(join(root, 'kay.config.ts'), slow('src/one.ts'))
    await until(() => lines.some(line => line.includes('kay.config.ts: restarted')))
    expect(existsSync(marker)).toBe(false)
    expect(children).toHaveLength(2)
    await until(() => existsSync(marker), 30_000)
    await Bun.sleep(1000)
    expect(lines.filter(line => line.includes('restarted'))).toHaveLength(1)
    expect(children).toHaveLength(2)

    // Another entry: the server on the old one is followed by one on the new, once the types name it.
    await rm(marker)
    await Bun.write(join(root, 'kay.config.ts'), slow('src/two.ts'))
    await until(() => children.length === 4, 30_000)
    expect(existsSync(marker)).toBe(true)
  }
  finally {
    await stop()
    await rm(join(marker, '..'), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)

it('leaves the client build of an earlier run as it is when nothing the build read changed, and builds it again for a change while kay dev was down', async () => {
  const root = await project('dev-warm-', { ...PAGES, 'package.json': JSON.stringify({ name: 'warm', imports: { '#label': './src/label-a.ts' } }), 'src/app.css': 'h1 { color: red }\n' })
  const run = async (action?: () => Promise<void>) => {
    const lines: string[] = []
    const port = freePort()
    const stop = await dev(root, { port, log: line => lines.push(line) })

    try {
      await until(() => lines.some(line => line.includes('ready in')))
      await action?.()

      return await (await fetch(`http://localhost:${port}/`)).text()
    }
    finally {
      await stop()
    }
  }

  try {
    settle(root)
    await run()
    await until(() => existsSync(join(dist(root), FINGERPRINT)))

    // A start with nothing changed leaves the build as it is, and still serves it.
    const built = manifestTime(root)

    await Bun.sleep(30)
    expect(await run()).toContain('LABEL_A')
    expect(manifestTime(root)).toBe(built)
    expect(existsSync(join(dist(root), FINGERPRINT))).toBe(true)

    // A start after an edit builds again, and the build is the new one.
    await Bun.write(join(root, 'src/counter.kay'), COUNTER('two'))
    await run(async () => {
      await until(() => manifestTime(root) !== built)
    })
    await until(() => existsSync(join(dist(root), FINGERPRINT)))
    expect(readdirSync(join(dist(root), 'dist'), { withFileTypes: true }).some(entry => entry.isFile() && readFileSync(join(dist(root), 'dist', entry.name), 'utf8').includes('two'))).toBe(true)
    expect(childrenRunning(realpathSync(root), 'builder.ts')).toHaveLength(0)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it('starts the first server without waiting for the config to load again once a run left what it named, and ends the start when it no longer loads', async () => {
  const marker = join(await mkdtemp(join(process.cwd(), 'node_modules/.cache/dev-gate-')), 'typed')
  // Flags are files the config looks for, as the environment a test sets does not reach the processes it starts.
  const config = `import { existsSync, writeFileSync } from 'node:fs'\n\nif (existsSync(${JSON.stringify(join(marker, '../refuse.flag'))}))\n  throw new Error('config refused by the environment')\n\nif (process.argv[1]?.endsWith('types.ts') && existsSync(${JSON.stringify(join(marker, '../slow.flag'))})) {\n  await Bun.sleep(5000)\n  writeFileSync(${JSON.stringify(marker)}, 'x')\n}\n\nexport default { entry: 'src/one.ts' }\n`
  const root = await project('dev-gate-', { 'src/one.ts': SERVER('one'), 'kay.config.ts': config })
  const real = realpathSync(root)

  settle(root)

  try {
    // Nothing recorded yet: the server waits for the load, like the types.
    const first = await dev(root, { refuseConfig: true })

    await first()
    await until(() => existsSync(join(dist(root), 'config.json')))

    await Bun.write(join(marker, '../slow.flag'), '')

    let typedAtReady: boolean | undefined
    const second = await dev(root, { refuseConfig: true, log: (line) => {
      if (line.includes('ready in'))
        typedAtReady = existsSync(marker)
    } })

    try {
      await until(() => typedAtReady !== undefined)
      // The types were still loading the config, which the server did not wait for.
      expect(typedAtReady).toBe(false)
    }
    finally {
      await second()
    }

    await rm(join(marker, '../slow.flag'))

    // Files as they were, but a config that refuses to load now: the types say so, the start ends and no server stays.
    await Bun.write(join(marker, '../refuse.flag'), '')
    await expect(dev(root, { refuseConfig: true })).rejects.toBeInstanceOf(ConfigRefusedError)
    expect(childrenRunning(real, 'preload.ts')).toHaveLength(0)
  }
  finally {
    await rm(join(marker, '..'), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it('follows the entry the types name when the config now names another than the one a run recorded', async () => {
  const flags = await mkdtemp(join(process.cwd(), 'node_modules/.cache/dev-entry-'))
  const config = `import { existsSync } from 'node:fs'\n\nexport default { entry: existsSync(${JSON.stringify(join(flags, 'two.flag'))}) ? 'src/two.ts' : 'src/one.ts' }\n`
  const root = await project('dev-entry-', { 'src/one.ts': SERVER('one'), 'src/two.ts': SERVER('two'), 'kay.config.ts': config })

  settle(root)

  try {
    await (await dev(root))()
    await until(() => existsSync(join(dist(root), 'config.json')))

    // The files are as the record has them, so the first server starts on the old entry and the types then tell the new one.
    await Bun.write(join(flags, 'two.flag'), '')

    const lines: string[] = []
    const port = freePort()
    const stop = await dev(root, { port, log: line => lines.push(line) })

    try {
      await until(() => lines.some(line => line.includes('ready in')))

      // Whether the first server was started on the old entry and replaced, or the new one came first, the one serving is on the entry the types named, and no key was pressed.
      const url = () => (/http:\/\/localhost:\d+/).exec(lines.findLast(line => line.includes('ready in') || line.includes('now on')) ?? '')?.[0] ?? `http://localhost:${port}`
      const served = async () => {
        try {
          return await (await fetch(url(), { signal: AbortSignal.timeout(2000) })).text()
        }
        catch {
          return ''
        }
      }

      for (const start = Date.now(); await served() !== 'two'; await Bun.sleep(100)) {
        if (Date.now() - start > 15_000)
          throw new Error(`still not on the new entry: ${JSON.stringify(lines)}`)
      }

      expect(lines.some(line => line.includes('r pressed'))).toBe(false)
    }
    finally {
      await stop()
    }
  }
  finally {
    await rm(flags, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)

it('reloads a module that imports package.json when only its version changed, and builds the client with the new one', async () => {
  const stamp = (version: string) => JSON.stringify({ name: 'package-version', version })
  const root = await project('dev-version-', {
    'package.json': stamp('1.0.0'),
    'kay.config.ts': 'export default {}\n',
    'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport pkg from \'../package.json\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(n => n + 1)}) v{pkg.version} {count()}\n',
    'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
  })
  const lines: string[] = []
  const port = freePort()
  const bundle = () => readdirSync(join(dist(root), 'dist'), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => entry.name).map(file => readFileSync(join(dist(root), 'dist', file), 'utf8')).join('\n')
  const stop = await dev(root, { port, log: line => lines.push(line) })

  try {
    await until(() => lines.some(line => line.includes('ready in')))
    await until(() => bundle().includes('1.0.0'))

    await Bun.write(join(root, 'package.json'), stamp('2.5.7'))
    await until(() => bundle().includes('2.5.7'))
  }
  finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${port}/`)).ok
  }
  catch {
    return false
  }
}

it('stops the whole run, server included, on SIGHUP as on SIGINT', async () => {
  const root = await project('dev-hangup-', { 'src/server.ts': 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nexport const app = new Elysia().use(await pages()).listen(Number(process.env.PORT))\n', 'src/routes/index.kay': 'h1 Home\n', 'kay.config.ts': 'export default {}\n' })
  const port = freePort()
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'dev', '--port', String(port)], { cwd: root, stdout: 'ignore', stderr: 'ignore' })

  try {
    let up = false

    for (const limit = Date.now() + 30_000; !up && Date.now() < limit; await Bun.sleep(100))
      up = await answers(port)

    expect(up).toBe(true)
    child.kill('SIGHUP')
    await Promise.race([child.exited, Bun.sleep(20_000)])
    expect(child.exitCode).toBe(0)
    expect(await answers(port)).toBe(false)
  }
  finally {
    child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
