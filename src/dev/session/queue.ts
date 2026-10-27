import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Long enough to gather the few events one save makes, which come within a millisecond.
const DEBOUNCE_MS = 10
// How long a source an editor's save left missing is waited for, as saving by renaming it away and writing it anew leaves it, on a machine busy enough to stretch the save.
const GONE_WAIT_MS = 200
// The backups Vim, Emacs and JetBrains IDEs move a source to while they write it anew.
const SAVE_BACKUPS = ['~', '___jb_old___', '___jb_tmp___']

// What one restart takes in.
export interface RestartBatch {
  // Every file changed since the last restart began, stylesheets included.
  files: string[]
  // `r` was pressed since the last restart began, which restarts even when only stylesheets changed.
  asked: boolean
  // The file a restart asked for is for, when it is not the user's key: the config naming another entry than the server runs.
  askedFor: string | undefined
}

// The session's one queue of events: the files the watcher reports and the restarts asked for gather into the next restart, and those landing during a restart make one more once it ends, never two restarts at once.
export class ChangeQueue {
  private touched = new Set<string>()
  private asked = false
  private askedFor: string | undefined
  // A restart is due: the changes settled, or one was asked for.
  private due = false
  private draining: Promise<void> | undefined
  private timer: Timer | undefined
  // The content each file had when a restart took it in, so a late second event of the same save, its content unchanged, restarts nothing.
  private contents = new Map<string, number | bigint>()
  private scratchWritten = -Infinity
  private waitingSince: number | undefined
  private waited = false

  constructor(private root: string, private restart: (batch: RestartBatch) => Promise<void>) {}

  // Settled once the restarts running and due are over, none while none is.
  get idle(): Promise<void> | undefined {
    return this.draining
  }

  // Whether the event is a late one of a save whose content a restart took in already.
  tookIn(file: string): boolean {
    return this.contents.has(file) && contentHash(join(this.root, file)) === this.contents.get(file)
  }

  changed(file: string) {
    this.touched.add(file)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), DEBOUNCE_MS)
  }

  // An editor wrote its scratch files beside a source, which a save that left the source missing is waited for by.
  scratch() {
    this.scratchWritten = performance.now()
  }

  // As a change does, but for no file. A change still waiting on the debounce goes with it, its timer cleared so it does not restart again for nothing.
  ask(file?: string) {
    this.askedFor = file
    clearTimeout(this.timer)
    this.waitingSince = undefined
    this.waited = false
    this.asked = true
    this.due = true
    this.draining ??= this.drain()
  }

  close() {
    clearTimeout(this.timer)
  }

  // A deleted source restarts at once, while one a save left missing a moment, its backup beside it or the editor's scratch files just written, is waited for.
  private settle() {
    const now = performance.now()
    const saving = (file: string) => !existsSync(join(this.root, file)) && (now - this.scratchWritten < GONE_WAIT_MS || SAVE_BACKUPS.some(suffix => existsSync(join(this.root, file + suffix))))

    this.waitingSince ??= now
    const wait = now - this.waitingSince < GONE_WAIT_MS && [...this.touched].some(saving)

    // A file seen back on disk has its event still to come, which one more tick gathers instead of restarting again for it.
    if (wait || this.waited) {
      this.waited = wait
      this.timer = setTimeout(() => this.settle(), DEBOUNCE_MS)

      return
    }

    this.waitingSince = undefined
    this.due = true
    this.draining ??= this.drain()
  }

  private async drain() {
    while (this.due) {
      this.due = false
      await this.restart(this.take())
    }

    this.draining = undefined
  }

  // What the next restart takes in, the content of each file as it is now taken with it.
  private take(): RestartBatch {
    const batch = { files: [...this.touched], asked: this.asked, askedFor: this.askedFor }

    this.touched = new Set()
    this.asked = false
    this.askedFor = undefined

    for (const file of batch.files) {
      const hash = contentHash(join(this.root, file))

      if (hash === undefined)
        this.contents.delete(file)
      else
        this.contents.set(file, hash)
    }

    return batch
  }
}

// The hash of a file's content, or none for a file that is missing or a directory.
function contentHash(path: string): number | bigint | undefined {
  try {
    return Bun.hash(readFileSync(path))
  }
  catch {
    return undefined
  }
}
