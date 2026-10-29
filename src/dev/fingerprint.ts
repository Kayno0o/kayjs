import { readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { version } from '../../package.json'
import { clientDir, KAY_DIR } from '../build/assets'
import { directoryStamp, fileStamp, projectTree, treeEntries, TS_FILE, unsettled, writeAtomically } from '../build/files'
import { compilerFingerprint } from '../build/fingerprint'
import { BUILD_FAILURE, MANIFEST } from '../server/client'
import { gitIgnoredNames, gitIgnoreTest, holdsSources, isSource } from './sources'

// Written beside the manifest once a build and the rewriting of its maps are over: what the client build read, to tell a later `kay dev` that the build it left is still the one its sources would give.
export const FINGERPRINT = 'fingerprint.json'
// The stamp of a file that cannot be told unchanged, which no later look at the file equals.
const RACY = 'racy'
// The stamp of a source the build did not read, which `kay/test` holds by its presence only.
const PRESENT = 'present'
// Which files are sources, read for each walk of them.
const GITIGNORE = '.gitignore'
const MAP_FILE = /\.map$/

interface StampRecord {
  identity: string
  options: string
  manifest: string
  // The size of each file the build wrote under `dist`, its maps apart.
  outputs: Record<string, number>
  // The inode, times and size of every file the build read, and of every source the project has; an empty stamp is a file that is not there.
  stamps: Record<string, string>
}

// Where `kay dev` keeps the record, `file` in `output`, and the key of the options it builds with.
interface RecordPlace {
  file: string
  output: string
  options: string
}

// What the code building the client is: kay's version and compiler, Bun's version.
function identity(): string {
  return `${version}\0${compilerFingerprint()}\0${Bun.version}`
}

// The modules of kay that shape the build, which a kay run from a checkout may change under the same version.
function kayModules(): string[] {
  const build = join(import.meta.dir, '../build')

  return [...readdirSync(build).filter(name => TS_FILE.test(name)).map(name => join(build, name)), join(import.meta.dir, 'builder.ts')]
}

// Every file the project's server or build reads, as the walk the build already made finds them.
export async function sourceFiles(root: string): Promise<string[]> {
  return (await sourceTree(root)).files
}

// The sources and, by the stamps the walk took, the directories that may hold one: none when one of them was written within two seconds before the walk, as an entry added next could leave its stamp as it is.
// `globs` also leaves out what the lines of `.gitignore` that `gitIgnoredNames` skips name, a database and its `-wal` as `data/*.sqlite*`.
async function sourceTree(root: string, globs = false): Promise<{ files: string[], directories: Map<string, string> }> {
  const ignored = gitIgnoredNames(root)
  const tree = await projectTree(root, { project: true, ownKayOnly: true })
  const gitIgnored = globs ? gitIgnoreTest(root) : undefined
  const files = tree.files.filter(file => isSource(root, file, ignored, true) && !gitIgnored?.(relative(root, file).split(sep).join('/')))
  const directories = new Map<string, string>()

  for (const [dir, stamp] of tree.directories) {
    if (!holdsSources(root, dir, ignored))
      continue

    if (stamp === '' || unsettled(stamp, tree.at))
      return { files, directories: new Map() }

    directories.set(dir, stamp)
  }

  return { files, directories }
}

// Whether a file no longer has the stamp a build took of it.
function moved(file: string, stamp: string): boolean {
  return stamp === PRESENT ? fileStamp(file) === undefined : (fileStamp(file) ?? '') !== stamp
}

const CODE_OR_KAY = /\.(?:kay|[cm]?[jt]sx?)$/
const PACKAGE_MENTION = /package\.json/

// Whether any source of the project names package.json, as `import { version } from '../package.json'` does: an edit of its scripts or version then changes what that module gives.
// It stops at the first source that does, and a source it cannot read, as one deleted mid-scan, counts as naming it, so the edit is passed on rather than lost.
export async function mentionsPackage(root: string): Promise<boolean> {
  try {
    for (const file of (await sourceFiles(root)).filter(file => CODE_OR_KAY.test(file))) {
      if (PACKAGE_MENTION.test(await Bun.file(file).text()))
        return true
    }

    return false
  }
  catch {
    return true
  }
}

async function outputsOf(root: string): Promise<Record<string, number>> {
  const dir = clientDir(root)
  const sizes: Record<string, number> = {}

  try {
    for (const file of (await treeEntries(dir)).files) {
      if (!MAP_FILE.test(file))
        sizes[file.slice(dir.length + 1)] = Bun.file(file).size
    }
  }
  catch {}

  return sizes
}

// Tells whether a client build is still the one its sources would give: the stamps of what it read, those of the sources taken before it read them, compared again later.
// `kay dev` keeps them in a record beside the manifest, so a start whose sources did not change builds nothing; `kay/test` compares them in the process that built. A file the record cannot trust, written within two seconds before the build began, makes the next start build again once.
export class BuildStamps {
  private known = new Map<string, string>()
  // The files whose stamps the record cannot trust.
  private racy = new Set<string>()
  // The directories that may hold a source, by their stamps when the build's walk listed them: while none moved, no source came or went since, and `current` walks nothing. Empty when they cannot be trusted.
  private directories = new Map<string, string>()
  private startedAt = 0
  private generation = 0
  private readonly realRoot: string
  private readonly record: RecordPlace | undefined
  // What the build writes for itself: the entries it bundles and the lists it hands the stylesheets.
  private readonly generated: string

  // `kay dev` gives the output its record goes beside and the key of its options; `kay/test` keeps the stamps in memory only.
  constructor(private readonly root: string, recorded?: { output: string, options: string }) {
    this.realRoot = realpathSync(root)
    this.record = recorded && { ...recorded, file: join(recorded.output, FINGERPRINT) }
    this.generated = join(this.realRoot, KAY_DIR) + sep
  }

  // `kay dev`'s record holds every source, as a gitignored `.env.local` can feed what a build inlines; `kay/test`, whose process reads its environment once, leaves out what `.gitignore` does.
  private async sources(): Promise<{ files: string[], directories: Map<string, string> }> {
    return sourceTree(this.root, this.record === undefined)
  }

  // By the path the bundler names a file: the real one.
  private canon(path: string): string {
    return path.startsWith(this.root + sep) ? this.realRoot + path.slice(this.root.length) : path
  }

  // Whether the build the last run left is the one these sources and this kay give. The stamps become the ones the next record starts from.
  async fresh(): Promise<boolean> {
    if (this.record === undefined)
      return false

    let saved: StampRecord

    try {
      saved = await Bun.file(this.record.file).json() as StampRecord
    }
    catch {
      return false
    }

    const { output, options } = this.record
    let manifest: string | undefined

    try {
      manifest = await Bun.file(join(output, MANIFEST)).text()
    }
    catch {}

    if (saved.identity !== identity() || saved.options !== options || manifest === undefined || saved.manifest !== Bun.hash(manifest).toString(36) || await Bun.file(join(output, BUILD_FAILURE)).exists())
      return false

    const outputs = Object.entries(saved.outputs)

    if (outputs.some(([name, size]) => Bun.file(join(clientDir(this.root), name)).size !== size))
      return false

    if (Object.entries(saved.stamps).some(([file, stamp]) => stamp === RACY || (fileStamp(file) ?? '') !== stamp))
      return false

    // A source the build never saw, written while `kay dev` was down.
    if ((await sourceFiles(this.root)).some(file => saved.stamps[this.canon(file)] === undefined))
      return false

    this.known = new Map(Object.entries(saved.stamps))
    this.racy.clear()

    return true
  }

  // Whether nothing the last build of this process read has changed since: every file still has the stamp the build took, and no source is new. After a build that failed, the sources it began with.
  // A new source is looked for only once a directory that may hold one moved, and the walk that finds none takes their stamps again.
  async current(): Promise<boolean> {
    if (this.known.size === 0)
      return false

    for (const [file, stamp] of this.known) {
      if (moved(file, stamp))
        return false
    }

    if (this.directories.size > 0 && [...this.directories].every(([dir, stamp]) => directoryStamp(dir) === stamp))
      return true

    const { files, directories } = await this.sources()

    if (files.some(file => !this.known.has(this.canon(file))))
      return false

    this.directories = directories

    return true
  }

  // A build starts: the record of the one before no longer describes the output, and the files it reads again are stamped before it reads them, every source for a build of everything.
  async begin(changed: string[] | null): Promise<void> {
    this.generation++
    this.startedAt = Date.now()

    if (this.record !== undefined)
      rmSync(this.record.file, { force: true })

    if (changed !== null) {
      for (const file of changed) {
        const path = this.canon(join(this.root, file))

        this.known.set(path, fileStamp(path) ?? '')
        this.racy.delete(path)
      }

      return
    }

    this.known.clear()
    this.racy.clear()

    const { files, directories } = await this.sources()

    for (const file of [...files, join(this.root, GITIGNORE)])
      this.stamp(this.canon(file), this.known, this.racy)

    this.directories = directories
  }

  // A build succeeded, having read `inputs`: its record is written once `settled`, the rewriting of the maps it started, is over, unless another build began meanwhile.
  // `kay dev`'s record holds every source by its stamp, for a later start to read; `kay/test` holds the ones the build did not read by their presence only, so a database a test writes under a watched folder builds nothing again.
  async finish(inputs: Iterable<string>, manifest: string, settled?: Promise<unknown>): Promise<void> {
    const generation = this.generation
    const stamps = new Map<string, string>()
    const racy = new Set<string>()
    const take = (file: string, read: boolean) => {
      if (stamps.has(file) || file.startsWith(this.generated))
        return

      if (!read) {
        stamps.set(file, PRESENT)

        return
      }

      const stamp = this.known.get(file)

      if (stamp === undefined) {
        this.stamp(file, stamps, racy)

        return
      }

      stamps.set(file, stamp)

      if (this.racy.has(file))
        racy.add(file)
    }

    for (const path of [...inputs, ...kayModules(), join(this.root, GITIGNORE)])
      take(this.canon(path), true)

    const { files, directories } = await this.sources()

    for (const path of files)
      take(this.canon(path), this.record !== undefined)

    this.known = stamps
    this.racy = racy
    this.directories = directories

    if (this.record !== undefined)
      void this.write(this.record, generation, manifest, settled)
  }

  private stamp(file: string, stamps: Map<string, string>, racy: Set<string>): void {
    const stamp = fileStamp(file) ?? ''

    stamps.set(file, stamp)

    if (unsettled(stamp, this.startedAt))
      racy.add(file)
  }

  private async write(record: RecordPlace, generation: number, manifest: string, settled: Promise<unknown> | undefined): Promise<void> {
    try {
      await settled

      if (generation !== this.generation)
        return

      const stamps = Object.fromEntries([...this.known].map(([file, stamp]) => [file, this.racy.has(file) ? RACY : stamp]))
      const saved: StampRecord = { identity: identity(), options: record.options, manifest: Bun.hash(manifest).toString(36), outputs: await outputsOf(this.root), stamps }

      await writeAtomically(record.file, JSON.stringify(saved))

      if (generation !== this.generation)
        rmSync(record.file, { force: true })
    }
    // Without a record the next start builds, which is what a read-only disk or a build that stopped halfway gets.
    catch {}
  }
}
