import type { Subprocess } from 'bun'
import { join } from 'node:path'
import process from 'node:process'

const TYPES = join(import.meta.dir, 'types.ts')
// How long the process writing the types waits for the next edit before it exits, so a project left alone holds no memory for it.
const IDLE_MS = 10_000

// The process writing the shadow tree of `kay dev`, kept between writes so an edit costs a write rather than a boot and the config's imports read again.
export class TypesProcess {
  child: Subprocess<'pipe', 'pipe', 'inherit'> | undefined
  private lines: AsyncIterator<string> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(private root: string, private entry: string | undefined) {}

  // Writes the tree and answers the exit code of the write. `fresh` boots a new process first, as the config or a module it imports may have changed.
  async write(fresh: boolean, refuse: string): Promise<number> {
    clearTimeout(this.idle)

    if (fresh)
      this.stop()

    const child = this.child ?? this.spawn(refuse)

    try {
      await child.stdin.write('write\n')
      await child.stdin.flush()

      const answer = await this.lines!.next()

      if (answer.done !== true) {
        this.idle = setTimeout(() => this.stop(), IDLE_MS)
        this.idle.unref()

        return Number(answer.value)
      }
    }
    catch {}

    // The process went before it answered: its own exit code says why.
    this.child = undefined

    return await child.exited || 1
  }

  stop() {
    clearTimeout(this.idle)
    this.child?.kill()
    this.child = undefined
  }

  private spawn(refuse: string) {
    const child = Bun.spawn([process.execPath, TYPES, this.root, this.entry ?? '', refuse], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })

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
