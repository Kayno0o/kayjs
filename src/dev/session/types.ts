import type { KayConfig } from '../../config'
import type { DevOptions } from '../index'
import type { TypeProblem } from '../refuse'
import type { DevPorts, Phase, TypesWorker } from './ports'
import type { Reporter } from './report'
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ASSET_EXTENSIONS } from '../../build/assets'
import { loadConfig } from '../../config-loader'
import { projectPaths, savedPublicDir } from '../../project'
import { CHECK, CHECK_SKIPPED, CONFIG_REFUSED, LOAD, REFUSE } from '../refuse'
import { PAGES_ENTRY } from '../sources'

// How long stopping waits for the types being written before it kills the process writing them.
const TYPES_GRACE_MS = 2000
// How long the first tree waits for the first server to listen before it is written anyway, as for a server that never does.
const FIRST_TREE_WAIT_MS = 3000
// How long the type check waits for the last change before it starts, so a burst of saves is checked once.
const CHECK_DEBOUNCE_MS = 300
// How long the process checking waits for the next edit before it exits: longer than the tree writer's, as a boot costs it the config and the collections it read.
const CHECK_IDLE_MS = 120_000
// The type errors the pages and the server carry, as `errors.json` does.
const MAX_SENT_ERRORS = 50
// The code files, which the process writing the types keeps running through an edit it did not load.
const CODE_FILE = /\.[cm]?[jt]sx?$/
// The files no type reads the contents of: a stylesheet, a markdown entry of a collection, an image, a font or any media an import takes the URL of.
const TYPE_FREE = new RegExp(`\\.(?:css|mdx?|${ASSET_EXTENSIONS.join('|')})$`, 'i')

// The generated types and the type check beside the servers: the tree is written one run at a time and one more once it ends when changes came meanwhile, and checked once it is, the errors told to the running server and said in the terminal.
export class TypesController {
  // The process writing them is kept between writes; only a change to something but `.kay` sources boots a new one, as the config or a module it imports may be what changed.
  readonly process: TypesWorker
  // kay.config.ts does not load, as the process writing the types found out.
  refused = false
  // The type check runs in a process of its own beside the server, once the tree it types is written: a reload never waits for it, and its errors reach the open pages, errors.json and the terminal when it ends.
  private readonly checks: boolean
  checking: Promise<void> | undefined
  private readonly checker: TypesWorker
  // The config the types are written from, read again once kay.config.ts changes.
  private config: KayConfig | undefined
  private writing: Promise<void> | undefined
  private again = false
  // The code files edited while a write ran, whose module the process may have loaded by then.
  private editedWhileWriting: string[] = []
  private fresh = true
  private started = false
  // Writes the first tree, which waits for the first server to listen so the page comes first; the editors need it, the page does not.
  private firstTree: (() => void) | undefined
  private treeTimer: Timer | undefined
  // A write of the tree started since the check began, which makes its answer old.
  private checkStale = false
  private checkFresh = true
  private checkTimer: Timer | undefined
  private checkAgain = false
  // The errors the last check ended with, and them as JSON (`undefined` before the first check) to tell a changed set from the same one.
  private problems: TypeProblem[] = []
  private key: string | undefined
  // Whether the server is told the type errors on listening: once a check ended, or skipped, so it never waits on one that will not come.
  private known = false

  constructor(private root: string, private options: DevOptions, env: Record<string, string | undefined>, ports: DevPorts, private reporter: Reporter, private phase: () => Phase, private tellServer: (problems: TypeProblem[]) => void) {
    this.process = ports.typesProcess(root, options.entry, env)
    this.config = options.config
    this.checks = options.types !== false && options.config === undefined && existsSync(join(root, 'tsconfig.json'))
    this.checker = ports.typesProcess(root, options.entry, env, CHECK_IDLE_MS)
  }

  // The shadow tree and the declarations read the project's sources, config and the names of its public files, so an edit of the contents of a stylesheet, a markdown entry or a media file leaves them as they are.
  read(files: string[]): boolean {
    if (files.length === 0 || files.some(file => !TYPE_FREE.test(file)))
      return true

    const publicDir = savedPublicDir(this.root) + sep

    return files.some(file => join(this.root, file).startsWith(publicDir))
  }

  // Chosen again for each process, so a `src/server.ts` written or deleted while running takes over at the next restart.
  // The config's `entry` comes from the process writing the types, which loads the config; `--entry` wins.
  entry(): string {
    const entry = projectPaths(this.root, { ...this.config, entry: this.options.entry ?? this.config?.entry }).entry
    const file = this.options.entry === undefined ? this.process.configuredEntry ?? entry : entry

    return this.options.entry === undefined && !existsSync(file) ? PAGES_ENTRY : file
  }

  async write(): Promise<void> {
    this.checkStale = true
    // Any write of the tree is the first one, so none is left waiting for a server.
    this.firstTree = undefined
    clearTimeout(this.treeTimer)
    this.again = true
    this.writing ??= (async () => {
      while (this.again) {
        this.again = false
        const fresh = this.fresh

        this.fresh = false
        this.refused ||= await regenerateTypes(this.root, { ...this.options, config: this.config }, this.options.refuseConfig === true && !this.started, this.process, fresh)
        this.started = true

        if (this.editedWhileWriting.splice(0).some(file => this.process.loaded(file))) {
          this.fresh = true
          this.again = true
        }
      }

      this.scheduleCheck()
      this.writing = undefined
    })()

    return this.writing
  }

  // Given no config, the process writing the types reads it first, which is all the first server waits for.
  async load(): Promise<void> {
    this.refused = await this.process.write(false, this.options.refuseConfig === true ? REFUSE : '', LOAD) === CONFIG_REFUSED
    this.fresh = false
    this.started = true
  }

  // The first tree is written once the first server listens, or exits, or after FIRST_TREE_WAIT_MS.
  armFirstTree() {
    this.firstTree = () => {
      this.firstTree = undefined
      clearTimeout(this.treeTimer)

      if (this.phase() !== 'stopping')
        void this.write()
    }
    this.treeTimer = setTimeout(() => this.firstTree?.(), FIRST_TREE_WAIT_MS)
    this.treeTimer.unref()
  }

  writeFirstTree() {
    this.firstTree?.()
  }

  // A check needs a new process as the tree writer does, for a change to the config or to something the process loaded.
  checkFor(files: string[], configEdited: boolean) {
    if (configEdited || (this.read(files) && (files.length === 0 || files.some(file => !file.endsWith('.kay') && (!CODE_FILE.test(file) || this.checker.loaded(file))))))
      this.checkFresh = true
  }

  async readConfig() {
    if (this.config !== undefined)
      this.config = await reloadConfig(this.root, this.config)
  }

  async writeFresh(): Promise<void> {
    this.fresh = true

    return this.write()
  }

  // An edit the types read, other than the config's.
  followEdit(files: string[]) {
    // A code file the process did not load is read from disk by the write, so only the others need a new process.
    this.fresh ||= files.length === 0 || files.some(file => !file.endsWith('.kay') && (!CODE_FILE.test(file) || this.process.loaded(file)))

    // A write in flight may load a module this edit touched, which its answer reports: checked once it ends.
    if (this.writing !== undefined)
      this.editedWhileWriting.push(...files.filter(file => CODE_FILE.test(file)))

    void this.write()
  }

  // The errors a server is told as it listens. A new process starts without the errors the last check found; with no check running it clears those a previous run left in `errors.json`.
  toldOnListen(): TypeProblem[] | undefined {
    return !this.checks || this.known || this.refused ? this.problems.slice(0, MAX_SENT_ERRORS) : undefined
  }

  cancelFirstTree() {
    clearTimeout(this.treeTimer)
  }

  // A write in flight runs no other after it.
  cancelReruns() {
    this.again = false
  }

  // A types process stuck importing the config is killed rather than waited for.
  async settle() {
    if (this.writing === undefined)
      return

    const grace = setTimeout(() => this.process.close(), TYPES_GRACE_MS)

    try {
      await this.writing
    }
    finally {
      clearTimeout(grace)
    }
  }

  close() {
    clearTimeout(this.checkTimer)
    this.checkAgain = false
    this.checker.close()
    this.process.close()
  }

  private scheduleCheck() {
    if (!this.checks || this.phase() === 'stopping' || this.refused)
      return

    clearTimeout(this.checkTimer)
    this.checkTimer = setTimeout(() => {
      this.checkAgain = true
      this.checking ??= (async () => {
        try {
          while (this.checkAgain) {
            this.checkAgain = false
            await this.writing
            this.checkStale = false

            const fresh = this.checkFresh

            this.checkFresh = false

            const code = await this.checker.write(fresh, '', CHECK)

            if (this.phase() === 'stopping')
              break

            // A change came meanwhile, whose check follows and says what holds.
            if (!this.checkStale && !this.checkAgain) {
              if (code !== CHECK_SKIPPED) {
                this.publish(this.checker.problems)
              }
              // A first check skipped leaves nothing to show: the errors a previous run listed are stale.
              else if (!this.known) {
                this.known = true
                this.tellServer([])
              }
            }
          }
        }
        catch (error) {
          console.error(error)
        }
        finally {
          this.checking = undefined
        }
      })()
    }, CHECK_DEBOUNCE_MS)
    this.checkTimer.unref()
  }

  // A check that ended with another set of type errors than the one before is told to the server and said in the terminal.
  private publish(problems: TypeProblem[]) {
    const key = JSON.stringify(problems)

    if (key === this.key)
      return

    this.key = key
    this.known = true
    this.problems = problems
    this.tellServer(problems.slice(0, MAX_SENT_ERRORS))
    this.reporter.typeErrors(problems)
  }
}

// A config that fails to load, halfway through an edit say, leaves the last one in place; the server reports why.
async function reloadConfig(root: string, last: KayConfig): Promise<KayConfig> {
  try {
    return await loadConfig(root, true)
  }
  catch {
    return last
  }
}

// Keeps editors and `tsgo` in step with the `.kay` sources; the type errors are the check beside the server's.
// Without a `config` it is written by a process of its own from kay.config.ts as it is now, which keeps the checker out of this one and reads again every module the config imports.
// Whether, asked to `refuse`, the process found kay.config.ts does not load.
async function regenerateTypes(root: string, { entry, config }: DevOptions, refuse: boolean, types: TypesWorker, fresh: boolean): Promise<boolean> {
  try {
    if (config === undefined)
      return await types.write(fresh, refuse ? REFUSE : '') === CONFIG_REFUSED

    const { configCheckOptions, writeShadowTypes } = await import('../../check')

    await writeShadowTypes(root, { ...configCheckOptions(config), entry: entry ?? config.entry, typesOnly: true })
  }
  catch (error) {
    console.error(error)
  }

  return false
}
