import type { Subprocess } from 'bun'
import type { BuildOutcome } from '../builder'
import type { ClientBuilder } from '../client'
import type { DevPorts, Phase } from './ports'
import type { Reporter } from './report'
import { CONFIG_FILE } from '../../config'
import { MAX_CHANGED_FILES, tell } from './ports'

// The client build beside the servers, by a process kept from one change to the next: started once a server asks for the client, and again once a file it loaded changes or it is gone.
export class ClientController {
  // A server asked for the client, so the next ones will: each restart starts building it at once.
  private wants = false
  // The build the running server reads.
  building: Promise<BuildOutcome | undefined> | undefined
  private builder: ClientBuilder | undefined
  private stale = true
  // One build at a time, so a restart never starts a second process while the last build still waits on the first.
  private lastBuild: Promise<unknown> = Promise.resolve()
  // Said once until a build succeeds again, as the process's own error already shows.
  private exitSaid = false
  // The builder exited before the types settled, so its notice waits for them.
  private exitHeld = false
  // `pages()` was given other options than kay.config.ts holds, so the servers bundle their own until the config changes.
  private own = false
  // The files changed since the last build began, null for all of them.
  private unbuilt: Set<string> | null = null
  // The server swapping in the stylesheets of a stylesheet edit, once it said it reads the build.
  private follower: Subprocess | undefined

  constructor(private root: string, private env: Record<string, string | undefined>, private ports: DevPorts, private reporter: Reporter, private phase: () => Phase) {}

  // `startup` is a file Bun reads as a process starts: the process building the client resolves modules the way Bun cached package.json for it, so an edit of what package.json resolves with starts a new one, as it does for the process writing the types.
  changed(file: string, startup: boolean) {
    if (startup || file === CONFIG_FILE || this.builder?.loaded(file) === true) {
      this.stale = true
      this.own = false
    }

    this.unbuilt?.add(file)
  }

  // A project with pages, or one an earlier run left a client build of, starts its builder beside the first types and server instead of once the server asks, and keeps it quiet until the types settle.
  startEarly() {
    this.wants = true

    const early = this.build()

    this.building = early
    // A failure shows where a server awaits it.
    void (async () => {
      try {
        await early
      }
      catch {}
    })()
  }

  // Once a server asked for the client, each restart starts building it at once.
  rebuild() {
    this.building = this.wants ? this.build() : undefined
  }

  asked(server: Subprocess) {
    this.wants = true
    void this.answer(server)
  }

  ownAsked() {
    this.own = true
    void this.builder?.stop()
    this.builder = undefined
  }

  follows(server: Subprocess) {
    this.follower = server
  }

  // Whether the running server reads the build, so it takes the stylesheets of an edit to stylesheets alone.
  swappable(server: Subprocess): boolean {
    return this.follower === server && this.builder !== undefined && !this.stale
  }

  async buildStyles(): Promise<BuildOutcome | undefined> {
    return (this.building = this.build())
  }

  // The first types settled: a config that does not load is the types' to report, once; any other crash of the builder shows its error and the notice.
  settled(refused: boolean) {
    this.builder?.release(!refused)

    if (this.exitHeld && !refused && this.phase() !== 'stopping')
      this.sayExit()
  }

  stop(): Promise<void> | undefined {
    return this.builder?.stop()
  }

  private sayExit() {
    if (!this.exitSaid)
      this.reporter.builderExit()

    this.exitSaid = true
  }

  private async build(): Promise<BuildOutcome | undefined> {
    const previous = this.lastBuild
    const build = (async () => {
      try {
        await previous
      }
      catch {}

      return this.buildNow()
    })()

    this.lastBuild = build

    return build
  }

  private async buildNow(): Promise<BuildOutcome | undefined> {
    if (this.own || this.phase() === 'stopping')
      return undefined

    if (this.stale || this.builder?.gone() === true) {
      await this.builder?.stop()

      // The start may have been refused while the old process stopped: a new one would print the config's error again.
      if (this.phase() === 'stopping')
        return undefined

      this.builder = this.ports.startClientBuilder(this.root, this.env, this.reporter.output, this.phase() === 'starting')
      this.stale = false
      this.unbuilt = null
    }

    const files = this.unbuilt === null || this.unbuilt.size > MAX_CHANGED_FILES ? null : [...this.unbuilt]
    const current = this.builder

    this.unbuilt = new Set()

    const outcome = await current?.build(files)

    if (outcome) {
      this.exitSaid = false

      return outcome
    }

    // Gone on its own while building, as when the config failed to load: the next build starts it again.
    if (current !== undefined && current === this.builder && this.phase() !== 'stopping' && !this.own) {
      if (this.phase() === 'starting')
        this.exitHeld = true
      else
        this.sayExit()
    }

    return undefined
  }

  private async answer(server: Subprocess) {
    const outcome = await (this.building ??= this.build())

    let state: 'none' | 'failed' | 'built' = 'none'

    if (outcome !== undefined)
      state = outcome.failed ? 'failed' : 'built'

    // Killed for a restart meanwhile.
    tell(server, { client: state })
  }
}
