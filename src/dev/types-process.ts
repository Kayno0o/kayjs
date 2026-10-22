import type { Subprocess } from 'bun'
import type { TypeProblem } from './refuse'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { CONFIG_FILE } from '../config'
import { ANSWER, ENTRY, MODULES, PROBLEMS, WRITE } from './refuse'

const TYPES = join(import.meta.dir, 'types.ts')
// How long the process writing the types waits for the next edit before it exits, so a project left alone holds no memory for it.
const IDLE_MS = 10_000

// The process writing the shadow tree of `kay dev`, or the one checking the project beside it (the `check` line), kept between writes so an edit costs a write rather than a boot and the config's imports read again.
export class TypesProcess {
  private child: Subprocess<'pipe', 'pipe', 'inherit'> | undefined
  private lines: AsyncIterator<string> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private closed = false
  // The writes run one at a time, as the process answers one line before it reads the next.
  private turn: Promise<unknown> = Promise.resolve()
  // The server entry the config named at the last write, when no `--entry` did.
  configuredEntry: string | undefined
  // The type errors the last `check` answered with, none before one did.
  problems: TypeProblem[] = []
  // The project modules the running process loaded, as its last answer reported them.
  private modules: Set<string> | undefined
  // `env` is the environment the process starts with, which leaves out what the `.env` files hold so it reads them itself on every start.
  constructor(private root: string, private entry: string | undefined, private env: Record<string, string | undefined> = process.env, private idleMs = IDLE_MS) {}

  // The project modules the last answer reported, undefined before the first.
  loadedModules(): string[] | undefined {
    return this.modules === undefined ? undefined : [...this.modules]
  }

  // Whether a change to the file, relative to the root, is one the running process loaded, which needs a new one: the config and the project's modules it imported, or any file when it has not reported them.
  loaded(file: string): boolean {
    return this.child === undefined || this.modules === undefined || file === CONFIG_FILE || this.modules.has(join(realpathSync(this.root), file))
  }

  // Writes the tree and answers the exit code of the write. `fresh` boots a new process first, as the config or a module it imports may have changed.
  // A kept process that went since the last write is replaced and the write sent again, so no write is lost.
  async write(fresh: boolean, refuse: string, command = WRITE): Promise<number> {
    const previous = this.turn
    const mine = (async () => {
      try {
        await previous
      }
      catch {}

      return this.run(fresh, refuse, command)
    })()

    this.turn = mine

    return mine
  }

  private async run(fresh: boolean, refuse: string, command: string): Promise<number> {
    clearTimeout(this.idle)

    if (fresh)
      this.kill()

    const kept = this.child !== undefined
    const answer = await this.ask(refuse, command)

    if (answer !== undefined) {
      this.idle = setTimeout(() => this.kill(), this.idleMs)
      this.idle.unref()

      return answer
    }

    return kept && !this.closed ? this.run(true, refuse, command) : 1
  }

  // Ends it for good: a write waiting on it answers at once, and none starts another.
  close() {
    this.closed = true
    this.kill()
  }

  private kill() {
    clearTimeout(this.idle)
    this.killGroup(this.child)
    this.child = undefined
    this.modules = undefined
  }

  // The process leads a group of its own, so the checker it spawned (tsgo) ends with it rather than running on as an orphan.
  private killGroup(child: Subprocess | undefined) {
    if (child === undefined)
      return

    try {
      process.kill(-child.pid, 'SIGTERM')
    }
    catch {
      child.kill()
    }
  }

  // The exit code the process answered, or undefined once it went before it did.
  private async ask(refuse: string, command: string): Promise<number | undefined> {
    if (this.closed)
      return undefined

    const child = this.child ?? this.spawn(refuse)

    try {
      await child.stdin.write(`${command}\n`)
      await child.stdin.flush()

      for (;;) {
        const line = await this.lines!.next()

        if (line.done === true)
          break

        if (line.value.startsWith(MODULES))
          this.modules = new Set(JSON.parse(line.value.slice(MODULES.length)) as string[])

        if (line.value.startsWith(PROBLEMS))
          this.problems = JSON.parse(line.value.slice(PROBLEMS.length)) as TypeProblem[]

        if (line.value.startsWith(ENTRY))
          this.configuredEntry = line.value.slice(ENTRY.length)

        // Whatever else the config or a module it imports prints is not an answer.
        if (line.value.startsWith(ANSWER))
          return Number(line.value.slice(ANSWER.length))
      }
    }
    catch (error) {
      console.error(error)
    }

    this.kill()

    return undefined
  }

  private spawn(refuse: string) {
    const child = Bun.spawn([process.execPath, TYPES, this.root, this.entry ?? '', refuse], { cwd: this.root, env: { ...this.env, NODE_ENV: 'development' }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', detached: true })

    this.child = child
    this.lines = lines(child.stdout)

    return child
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''

  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })

    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      yield pending.slice(0, end)
      pending = pending.slice(end + 1)
    }
  }
}
