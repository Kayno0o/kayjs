import type { Subprocess } from 'bun'
import type { DevPorts, TypesWorker } from '../src/dev'
import type { BuildOutcome } from '../src/dev/builder'
import type { ClientBuilder } from '../src/dev/client'
import type { TypeProblem } from '../src/dev/refuse'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'bun:test'
import { ConfigRefusedError, dev } from '../src/dev'
import { CONFIG_REFUSED } from '../src/dev/refuse'
import { eventually, turn } from './helpers/eventually'
import { scratchDir } from './scratch'

// The model of kay dev's session: every process it drives and its watcher are fakes the test answers when it chooses, so each race the fix log names is played in the order it needs.

class FakeServer {
  readonly sent: Record<string, unknown>[] = []
  readonly exited: Promise<number>
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  // A reload asked while it is set waits for it before the server answers.
  reloadHeld: PromiseWithResolvers<void> | undefined
  // A kill while it is set ends the process only once it settles.
  exitHeld: PromiseWithResolvers<void> | undefined
  private ended: (code: number) => void
  readonly stdin = {
    write: (line: string) => {
      this.trace.push(`start ${this.id}`)
      this.started = line
      // The preload reports its address over IPC once the entry listens, a turn later.
      queueMicrotask(() => this.say({ listening: 'http://localhost:4000/', asked: 4000, port: 4000 }))
    },
    flush: () => undefined,
  }

  started: string | undefined

  constructor(readonly id: number, readonly entry: string, private trace: string[], private ipc: (message: unknown, server: Subprocess) => void) {
    const { promise, resolve } = Promise.withResolvers<number>()

    this.exited = promise
    this.ended = resolve
  }

  get reloads(): Record<string, unknown>[] {
    return this.sent.filter(message => 'reload' in message)
  }

  say(message: object) {
    if (this.exitCode === null && this.signalCode === null)
      this.ipc(message, this as unknown as Subprocess)
  }

  send(message: Record<string, unknown>) {
    if (this.exitCode !== null || this.signalCode !== null)
      throw new Error('the channel is closed')

    this.sent.push(message)

    if ('reload' in message) {
      this.trace.push(`reload ${this.id}`)
      void this.answerReload()
    }
  }

  kill() {
    if (this.exitCode !== null || this.signalCode !== null)
      return

    this.trace.push(`kill ${this.id}`)
    this.signalCode = 'SIGTERM'
    void this.end()
  }

  private async end() {
    await this.exitHeld?.promise
    this.trace.push(`exit ${this.id}`)
    this.ended(143)
  }

  private async answerReload() {
    await this.reloadHeld?.promise
    this.say({ reloaded: true })
  }
}

class FakeTypes implements TypesWorker {
  configuredEntry: string | undefined
  problems: TypeProblem[] = []
  // The errors each next answer reports, in turn.
  readonly answers: TypeProblem[][] = []
  readonly writes: { command: string, fresh: boolean }[] = []
  // The files the process reports it loaded, which `loaded` answers for.
  readonly loadedFiles = new Set<string>()
  closed = false
  private held = new Map<string, PromiseWithResolvers<number>>()
  private inFlight = new Set<PromiseWithResolvers<number>>()

  constructor(private trace: string[], readonly name: string) {}

  // The next write of `command` waits for the deferred returned, until `close` answers it.
  hold(command = 'write'): PromiseWithResolvers<number> {
    const deferred = Promise.withResolvers<number>()

    this.held.set(command, deferred)

    return deferred
  }

  loadedModules() {
    return undefined
  }

  loaded(file: string) {
    return this.loadedFiles.has(file)
  }

  async write(fresh: boolean, _refuse: string, command = 'write') {
    this.writes.push({ command, fresh })
    this.trace.push(`${this.name} ${command}`)

    const held = this.held.get(command)

    this.held.delete(command)

    let code = 0

    if (held !== undefined) {
      this.inFlight.add(held)
      code = await held.promise
      this.inFlight.delete(held)
    }

    this.trace.push(`${this.name} ${command} answered`)
    this.problems = this.answers.shift() ?? this.problems

    return code
  }

  close() {
    this.closed = true
    this.trace.push(`${this.name} close`)

    for (const held of [...this.held.values(), ...this.inFlight])
      held.resolve(1)
  }
}

class FakeBuilder implements ClientBuilder {
  readonly builds: (string[] | null)[] = []
  stopped = false
  // A stop while it is set ends the process only once it settles.
  stopHeld: PromiseWithResolvers<void> | undefined
  private held: PromiseWithResolvers<BuildOutcome | undefined>[] = []
  private holdNext = false

  constructor(readonly id: number, private trace: string[]) {}

  // The next build waits until `answer` or `stop`.
  hold() {
    this.holdNext = true
  }

  answer(outcome: BuildOutcome = { failed: false }) {
    this.held.shift()?.resolve(outcome)
  }

  async build(changed: string[] | null) {
    if (this.stopped)
      return undefined

    this.builds.push(changed)
    this.trace.push(`build ${this.id}`)

    if (!this.holdNext)
      return { failed: false }

    this.holdNext = false

    const deferred = Promise.withResolvers<BuildOutcome | undefined>()

    this.held.push(deferred)

    return deferred.promise
  }

  gone() {
    return this.stopped
  }

  loaded() {
    return false
  }

  release() {
    this.trace.push(`builder release ${this.id}`)
  }

  async stop() {
    this.stopped = true
    this.trace.push(`builder stop ${this.id}`)
    await this.stopHeld?.promise

    for (const held of this.held.splice(0))
      held.resolve(undefined)
  }
}

// The scans of the sources for a mention of package.json, each answered when the test chooses.
class FakeScan {
  readonly asked: PromiseWithResolvers<boolean>[] = []

  constructor(private trace: string[]) {}

  async scan(): Promise<boolean> {
    const deferred = Promise.withResolvers<boolean>()

    this.trace.push(`scan ${this.asked.length + 1}`)
    this.asked.push(deferred)

    return deferred.promise
  }
}

interface Fakes {
  root: string
  trace: string[]
  lines: string[]
  servers: FakeServer[]
  builders: FakeBuilder[]
  types: FakeTypes
  check: FakeTypes
  scans: FakeScan
  keys: PassThrough
  ports: DevPorts
  // Holds the first build of the next builder started.
  builderHeld: boolean
  // Reports the file changed, as the watcher would.
  event: (file: string) => void
}

interface Session extends Omit<Fakes, 'ports' | 'builderHeld'> {
  // Writes the file and reports it changed, as the watcher would.
  edit: (file: string, content?: string) => Promise<void>
  // The server the session runs, the last one started.
  running: () => FakeServer
  stop: () => Promise<void>
}

// A project of `files` and the fakes a session of it drives, none started yet.
async function project(files: Record<string, string>): Promise<Fakes> {
  const root = await scratchDir('dev-session-')
  const trace: string[] = []
  const servers: FakeServer[] = []
  const builders: FakeBuilder[] = []
  const types = new FakeTypes(trace, 'types')
  const check = new FakeTypes(trace, 'check')
  const scans = new FakeScan(trace)
  let onChange: ((file: string) => void) | undefined

  await Promise.all(Object.entries(files).map(async ([path, content]) => path.endsWith('/') ? mkdir(join(root, path), { recursive: true }) : Bun.write(join(root, path), content)))

  const fakes: Omit<Fakes, 'ports'> = { root, trace, lines: [], servers, builders, types, check, scans, keys: new PassThrough(), builderHeld: false, event: file => onChange?.(file) }
  let typesMade = 0
  const ports: DevPorts = {
    spawnServer: (_root, entry, _env, _stdout, ipc) => {
      const server = new FakeServer(servers.length + 1, entry, trace, ipc)

      servers.push(server)
      trace.push(`spawn ${server.id}`)

      return server as unknown as Subprocess<'pipe'>
    },
    // The first is the process writing the tree, the second the one checking the project.
    typesProcess: () => typesMade++ === 0 ? types : check,
    startClientBuilder: () => {
      const builder = new FakeBuilder(builders.length + 1, trace)

      if (fakes.builderHeld)
        builder.hold()

      fakes.builderHeld = false
      builders.push(builder)
      trace.push(`builder ${builder.id}`)

      return builder
    },
    watchProject: (_root, change) => {
      onChange = change

      return () => {
        onChange = undefined
      }
    },
    mentionsPackage: async () => scans.scan(),
  }

  return Object.assign(fakes, { ports })
}

// A session of fakes over a project of `files`, once its first server is ready; `prepare` holds what the start should meet held, before it runs.
async function session(files: Record<string, string>, prepare?: (fakes: Fakes) => void): Promise<Session> {
  const fakes = await project(files)
  const { root, lines, servers } = fakes

  prepare?.(fakes)

  const stop = await dev(root, { log: line => lines.push(line), keys: fakes.keys }, fakes.ports)

  await eventually(() => expect(lines.some(line => line.includes('ready in'))).toBe(true))

  return {
    ...fakes,
    edit: async (file, content = `${file} ${Math.random()}`) => {
      await Bun.write(join(root, file), content)
      fakes.event(file)
    },
    running: () => servers.findLast(server => server.started !== undefined)!,
    stop,
  }
}

// Longer than the debounce of a change and a few turns, so a restart it would start has started: for "nothing happens" where no fake answers first.
const SETTLED_MS = 60
const reloadedLines = (dev: Session) => dev.lines.filter(line => line.includes('reloaded in'))
const writesAnswered = (dev: Session) => dev.trace.filter(entry => entry === 'types write answered')

describe('kay dev\'s session', () => {
  it('starts one server, then writes the first tree once it listens', async () => {
    const dev = await session({ 'src/routes/index.kay': 'p hi' })

    await eventually(() => expect(dev.types.writes).toEqual([{ command: 'load', fresh: false }, { command: 'write', fresh: false }]))
    expect(dev.servers).toHaveLength(1)
    expect(dev.trace.indexOf('spawn 1')).toBeLessThan(dev.trace.indexOf('types load'))
    expect(dev.trace.indexOf('start 1')).toBeGreaterThan(dev.trace.indexOf('types load answered'))
    await dev.stop()
  })

  describe('an event during a restart', () => {
    it('restarts once more after a reload in flight, never twice at once, with what came meanwhile', async () => {
      const dev = await session({ 'src/a.kay': 'p a', 'src/b.kay': 'p b' })
      const server = dev.running()
      const held = Promise.withResolvers<void>()

      server.reloadHeld = held
      await dev.edit('src/a.kay')
      await eventually(() => expect(server.reloads).toHaveLength(1))
      await dev.edit('src/b.kay')
      await dev.edit('src/a.kay')
      await Bun.sleep(SETTLED_MS)
      expect(server.reloads).toHaveLength(1)
      server.reloadHeld = undefined
      held.resolve()
      await eventually(() => expect(reloadedLines(dev)).toHaveLength(2))
      await turn()
      expect(server.reloads).toHaveLength(2)
      expect(dev.servers).toHaveLength(1)
      expect((server.reloads[1]!.reload as { files: string[] }).files).toEqual(['src/b.kay', 'src/a.kay'])
      await dev.stop()
    })

    it('restarts nothing for a second event of a save a restart already took in, and again for a real edit', async () => {
      const dev = await session({ 'src/a.kay': 'p a' })
      const server = dev.running()

      await dev.edit('src/a.kay', 'p one')
      await eventually(() => expect(server.reloads).toHaveLength(1))
      dev.event('src/a.kay')
      await Bun.sleep(SETTLED_MS)
      expect(server.reloads).toHaveLength(1)
      await dev.edit('src/a.kay', 'p two')
      await eventually(() => expect(server.reloads).toHaveLength(2))
      await dev.stop()
    })

    it('starts one new process for r pressed while a change still debounces, and reloads nothing', async () => {
      const dev = await session({ 'src/a.kay': 'p a' })
      const first = dev.running()

      await dev.edit('src/a.kay')
      dev.keys.write('r')
      await eventually(() => expect(dev.lines.filter(line => line.includes('src/a.kay: restarted in'))).toHaveLength(1))
      await turn()
      expect(dev.servers.filter(server => server.started !== undefined)).toHaveLength(2)
      expect(first.reloads).toHaveLength(0)
      expect(dev.running().reloads).toHaveLength(0)
      expect(first.signalCode).toBe('SIGTERM')
      await dev.stop()
    })

    it('restarts once more after a new process, for an edit while the one before was ending', async () => {
      const dev = await session({ 'kay.config.ts': 'export default {}', 'src/a.kay': 'p a' })
      const first = dev.running()
      const exit = Promise.withResolvers<void>()

      first.exitHeld = exit
      await dev.edit('kay.config.ts')
      await eventually(() => expect(dev.trace).toContain('kill 1'))
      await dev.edit('src/a.kay')
      await Bun.sleep(SETTLED_MS)
      expect(dev.servers).toHaveLength(2)
      expect(dev.running()).toBe(first)
      exit.resolve()
      await eventually(() => expect(dev.running().id).toBeGreaterThan(1))
      await Bun.sleep(SETTLED_MS)

      const started = dev.servers.filter(server => server.started !== undefined)

      // The config edit starts a new process; the edit landing during it reloads that one or starts one more, never two side by side.
      expect(started.filter(server => server.signalCode === null)).toHaveLength(1)
      expect(started.length + dev.running().reloads.length).toBe(3)
      await dev.stop()
    })
  })

  describe('an edit during a types write', () => {
    it('writes again on a new process when the write in flight loaded the edited module', async () => {
      let held: PromiseWithResolvers<number> | undefined
      const dev = await session({ 'src/a.kay': 'p a', 'src/helper.ts': 'export const a = 1' }, ({ types }) => {
        held = types.hold()
      })

      await eventually(() => expect(dev.types.writes).toHaveLength(2))
      await dev.edit('src/helper.ts')
      await eventually(() => expect(reloadedLines(dev)).toHaveLength(1))
      await turn()
      expect(dev.types.writes).toHaveLength(2)
      // The write in flight answers that it loaded the module the edit changed.
      dev.types.loadedFiles.add('src/helper.ts')
      held!.resolve(0)
      await eventually(() => expect(writesAnswered(dev)).toHaveLength(2))
      await turn()
      expect(dev.types.writes).toHaveLength(3)
      expect(dev.types.writes[2]).toEqual({ command: 'write', fresh: true })
      await dev.stop()
    })

    it('writes again on the kept process when the write in flight did not load it', async () => {
      let held: PromiseWithResolvers<number> | undefined
      const dev = await session({ 'src/a.kay': 'p a', 'src/helper.ts': 'export const a = 1' }, ({ types }) => {
        held = types.hold()
      })

      await eventually(() => expect(dev.types.writes).toHaveLength(2))
      await dev.edit('src/helper.ts')
      await eventually(() => expect(dev.running().reloads).toHaveLength(1))
      held!.resolve(0)
      await eventually(() => expect(writesAnswered(dev)).toHaveLength(2))
      await turn()
      expect(dev.types.writes).toHaveLength(3)
      expect(dev.types.writes[2]).toEqual({ command: 'write', fresh: false })
      await dev.stop()
    })

    it('runs one more write for a burst of edits during one, not one per edit', async () => {
      let held: PromiseWithResolvers<number> | undefined
      const dev = await session({ 'src/a.kay': 'p a', 'src/b.kay': 'p b' }, ({ types }) => {
        held = types.hold()
      })

      await eventually(() => expect(dev.types.writes).toHaveLength(2))
      await dev.edit('src/a.kay')
      await eventually(() => expect(dev.running().reloads).toHaveLength(1))
      await dev.edit('src/b.kay')
      await eventually(() => expect(dev.running().reloads).toHaveLength(2))
      held!.resolve(0)
      await eventually(() => expect(writesAnswered(dev)).toHaveLength(2))
      await turn()
      expect(dev.types.writes).toHaveLength(3)
      await dev.stop()
    })
  })

  describe('an edit during a type check', () => {
    it('drops the answer of a check a write of the tree made old, and tells the one after it', async () => {
      const stale = { file: 'src/a.kay', line: 1, column: 1, message: 'stale', report: '' }
      const fresh = { ...stale, message: 'fresh' }
      let held: PromiseWithResolvers<number> | undefined
      const dev = await session({ 'tsconfig.json': '{}', 'src/a.kay': 'p a' }, ({ check }) => {
        held = check.hold('check')
        check.answers.push([stale], [fresh])
      })
      const server = dev.running()
      const told = () => server.sent.filter(message => 'typeErrors' in message).map(message => message.typeErrors)

      await eventually(() => expect(dev.check.writes).toHaveLength(1))
      await dev.edit('src/a.kay')
      await eventually(() => expect(dev.types.writes).toHaveLength(3))
      held!.resolve(0)
      await eventually(() => expect(told()).toEqual([[fresh]]))
      expect(dev.check.writes).toHaveLength(2)
      expect(dev.lines.filter(line => line.includes('types: 1 type error'))).toHaveLength(1)
      await dev.stop()
    })
  })

  describe('stop', () => {
    it('kills the server before it waits on a types write in flight, then closes the types', async () => {
      let held: PromiseWithResolvers<number> | undefined
      const dev = await session({ 'src/a.kay': 'p a' }, ({ types }) => {
        held = types.hold()
      })

      await eventually(() => expect(dev.types.writes).toHaveLength(2))

      let stopped = false
      const stopping = (async () => {
        await dev.stop()
        stopped = true
      })()

      await eventually(() => expect(dev.running().signalCode).toBe('SIGTERM'))
      await turn()
      expect(stopped).toBe(false)
      expect(dev.types.closed).toBe(false)
      held!.resolve(0)
      await stopping
      expect(dev.trace.indexOf('kill 1')).toBeLessThan(dev.trace.indexOf('types write answered'))
      expect(dev.types.closed).toBe(true)
      expect(dev.check.closed).toBe(true)
    })

    it('closes a types process whose write never ends once its grace is over', async () => {
      const dev = await session({ 'src/a.kay': 'p a' }, ({ types }) => {
        types.hold()
      })

      await eventually(() => expect(dev.types.writes).toHaveLength(2))

      const began = performance.now()

      await dev.stop()
      expect(performance.now() - began).toBeGreaterThan(1500)
      expect(dev.running().signalCode).toBe('SIGTERM')
      expect(dev.types.closed).toBe(true)
    })

    it('waits for a restart in flight before it kills the server', async () => {
      const dev = await session({ 'src/a.kay': 'p a' })
      const server = dev.running()
      const held = Promise.withResolvers<void>()

      server.reloadHeld = held
      await dev.edit('src/a.kay')
      await eventually(() => expect(server.reloads).toHaveLength(1))

      let stopped = false
      const stopping = (async () => {
        await dev.stop()
        stopped = true
      })()

      await turn()
      expect(stopped).toBe(false)
      expect(server.signalCode).toBe(null)
      held.resolve()
      await stopping
      expect(server.signalCode).toBe('SIGTERM')
      expect(dev.servers).toHaveLength(1)
    })
  })

  describe('stop during a build', () => {
    it('stops the builder of a build in flight and starts no other, saying nothing of its exit', async () => {
      const dev = await session({ 'src/routes/index.kay': 'p hi' }, (fakes) => {
        fakes.builderHeld = true
      })

      expect(dev.builders).toHaveLength(1)
      expect(dev.builders[0]!.builds).toEqual([null])
      await dev.stop()
      expect(dev.builders).toHaveLength(1)
      expect(dev.builders[0]!.stopped).toBe(true)
      expect(dev.lines.some(line => line.includes('building the client exited'))).toBe(false)
    })

    it('starts no builder for a build queued behind one in flight once stopping', async () => {
      const dev = await session({ 'kay.config.ts': 'export default {}', 'src/routes/index.kay': 'p hi' }, (fakes) => {
        fakes.builderHeld = true
      })

      // An edit of the config makes the builder stale, so the build it queues starts another once the one in flight ends.
      await dev.edit('kay.config.ts')
      await eventually(() => expect(dev.running().id).toBe(2))
      await dev.stop()
      await Bun.sleep(SETTLED_MS)
      expect(dev.builders).toHaveLength(1)
      expect(dev.lines.some(line => line.includes('building the client exited'))).toBe(false)
    })

    it('builds nothing for a restart stop waits for', async () => {
      const dev = await session({ 'src/routes/index.kay': 'p hi', 'src/a.kay': 'p a', 'src/b.kay': 'p b' })
      const server = dev.running()
      const held = Promise.withResolvers<void>()

      server.reloadHeld = held
      await dev.edit('src/a.kay')
      await eventually(() => expect(server.reloads).toHaveLength(1))
      expect(dev.builders[0]!.builds).toHaveLength(2)
      // Settled during the reload, so the session restarts once more after it.
      await dev.edit('src/b.kay')
      await Bun.sleep(SETTLED_MS)

      const stopping = dev.stop()

      await turn()
      held.resolve()
      await stopping
      expect(dev.builders).toHaveLength(1)
      expect(dev.builders[0]!.builds).toHaveLength(2)
    })

    it('starts no builder once stopping for a build that waited on the stale one to stop', async () => {
      const dev = await session({ 'kay.config.ts': 'export default {}', 'src/routes/index.kay': 'p hi' })
      const stale = dev.builders[0]!
      const exit = Promise.withResolvers<void>()

      stale.stopHeld = exit
      await dev.edit('kay.config.ts')
      await eventually(() => expect(dev.trace).toContain('builder stop 1'))

      const stopping = dev.stop()

      await turn()
      exit.resolve()
      await stopping
      await Bun.sleep(SETTLED_MS)
      expect(dev.builders).toHaveLength(1)
    })

    it('starts no builder for a server asking for the client as it stops', async () => {
      const dev = await session({ 'src/a.kay': 'p a' })
      const server = dev.running()
      const stopping = dev.stop()

      server.say({ wantsClient: true })
      await stopping
      expect(dev.builders).toHaveLength(0)
    })
  })
  describe('the start', () => {
    it('ends with ConfigRefusedError for a config that does not load, killing the waiting server and starting no other builder', async () => {
      const fakes = await project({ 'kay.config.ts': 'export default {', 'src/routes/index.kay': 'p hi' })

      fakes.types.hold('load').resolve(CONFIG_REFUSED)
      await expect(dev(fakes.root, { log: line => fakes.lines.push(line), refuseConfig: true }, fakes.ports)).rejects.toBeInstanceOf(ConfigRefusedError)
      expect(fakes.servers).toHaveLength(1)
      expect(fakes.servers[0]!.started).toBeUndefined()
      expect(fakes.servers[0]!.signalCode).toBe('SIGTERM')
      // The project has pages, so its builder started beside the types; it is stopped, and none follows it.
      expect(fakes.builders).toHaveLength(1)
      expect(fakes.builders[0]!.stopped).toBe(true)
      expect(fakes.types.closed).toBe(true)
      expect(fakes.lines.some(line => line.includes('building the client exited'))).toBe(false)
    })
  })

  describe('a config edit', () => {
    const files = { 'kay.config.ts': 'export default {}', 'src/a.kay': 'p a', 'src/other.ts': 'export {}' }

    // Edits the config, its types write held, and answers once the new process started that the config now names src/other.ts.
    async function namesAnotherEntry(dev: Session): Promise<PromiseWithResolvers<number>> {
      await eventually(() => expect(dev.types.writes).toHaveLength(2))

      const held = dev.types.hold()

      await dev.edit('kay.config.ts')
      await eventually(() => expect(dev.running().id).toBe(2))
      expect(dev.types.writes).toHaveLength(3)
      dev.types.configuredEntry = join(dev.root, 'src/other.ts')

      return held
    }

    it('starts one more process once its types write names another entry', async () => {
      const dev = await session(files)
      const held = await namesAnotherEntry(dev)

      held.resolve(0)
      await eventually(() => expect(dev.running().id).toBe(3))
      expect(dev.running().entry).toBe(join(dev.root, 'src/other.ts'))
      await eventually(() => expect(dev.lines.filter(line => line.includes('kay.config.ts: restarted in'))).toHaveLength(2))
      await turn()
      expect(dev.servers).toHaveLength(3)
      await dev.stop()
    })

    it('starts none when that write ends once stopping', async () => {
      const dev = await session(files)
      const held = await namesAnotherEntry(dev)
      const stopping = dev.stop()

      await turn()
      held.resolve(0)
      await stopping
      await turn()
      expect(dev.servers).toHaveLength(2)
    })
  })

  describe('a package.json edit', () => {
    const manifest = (version: string) => JSON.stringify({ name: 'app', version, dependencies: {} })

    it('scans once for a burst of edits no module resolves with, and once more for those during the scan', async () => {
      const dev = await session({ 'package.json': manifest('1.0.0'), 'src/a.kay': 'p a' })
      const server = dev.running()

      await dev.edit('package.json', manifest('1.0.1'))
      expect(dev.scans.asked).toHaveLength(1)
      await dev.edit('package.json', manifest('1.0.2'))
      await dev.edit('package.json', manifest('1.0.3'))
      expect(dev.scans.asked).toHaveLength(1)
      dev.scans.asked[0]!.resolve(false)
      await eventually(() => expect(dev.scans.asked).toHaveLength(2))
      // The scan after the burst finds a source naming package.json, which a reload takes in.
      dev.scans.asked[1]!.resolve(true)
      await eventually(() => expect(reloadedLines(dev)).toHaveLength(1))
      await turn()
      expect(dev.scans.asked).toHaveLength(2)
      expect(server.reloads).toHaveLength(1)
      expect((server.reloads[0]!.reload as { files: string[] }).files).toEqual(['package.json'])
      expect(dev.servers).toHaveLength(1)
      await dev.stop()
    })
  })

  describe('a save that leaves its source missing a moment', () => {
    it('waits for the source to come back, its backup beside it, and reloads once', async () => {
      const dev = await session({ 'src/a.kay': 'p a' })
      const server = dev.running()
      const source = join(dev.root, 'src/a.kay')

      await rename(source, `${source}~`)
      dev.event('src/a.kay')
      // Past the debounce, well within the wait for the save to end.
      await Bun.sleep(30)
      expect(server.reloads).toHaveLength(0)
      await dev.edit('src/a.kay', 'p saved')
      await rm(`${source}~`)
      await eventually(() => expect(reloadedLines(dev)).toHaveLength(1))
      await turn()
      expect(server.reloads).toHaveLength(1)
      expect((server.reloads[0]!.reload as { files: string[] }).files).toEqual(['src/a.kay'])
      expect(dev.servers).toHaveLength(1)
      await dev.stop()
    })
  })
})
