import { readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { version } from '../../package.json'
import { clientDir, KAY_DIR } from '../build/assets'
import { fileStamp, findProjectFiles, treeEntries, TS_FILE, unsettled, writeAtomically } from '../build/files'
import { compilerFingerprint } from '../build/transform'
import { BUILD_FAILURE, MANIFEST } from '../server/client'
import { gitIgnoredNames, isSource } from './sources'

// Written beside the manifest once a build and the rewriting of its maps are over: what the client build read, to tell a later `kay dev` that the build it left is still the one its sources would give.
export const FINGERPRINT = 'fingerprint.json'
// The stamp of a file that cannot be told unchanged, which no later look at the file equals.
const RACY = 'racy'
const MAP_FILE = /\.map$/
const ANY_NAME = /^/

interface StampRecord {
  identity: string
  options: string
  manifest: string
  // The size of each file the build wrote under `dist`, its maps apart.
  outputs: Record<string, number>
  // The inode, times and size of every file the build read, and of every source the project has; an empty stamp is a file that is not there.
  stamps: Record<string, string>
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
  const ignored = gitIgnoredNames(root)

  return (await findProjectFiles(root, ANY_NAME, { project: true, ownKayOnly: true })).filter(file => isSource(root, file, ignored, true))
}

const CODE_OR_KAY = /\.(?:kay|[cm]?[jt]sx?)$/
const PACKAGE_MENTION = /package\.json/

// Whether any source of the project names package.json, as `import { version } from '../package.json'` does: an edit of its scripts or version then changes what that module gives.
export async function mentionsPackage(root: string): Promise<boolean> {
  const files = (await sourceFiles(root)).filter(file => CODE_OR_KAY.test(file))

  return (await Promise.all(files.map(async file => PACKAGE_MENTION.test(await Bun.file(file).text())))).includes(true)
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

// Tells whether the build `kay dev` left is still current, so a start whose sources did not change builds nothing: the stamps of what the last build read, taken before it read them, are kept and compared at the next start.
// A file whose stamp cannot be trusted, written within two seconds before the build began, makes the next start build again once.
export class BuildStamps {
  private known = new Map<string, string>()
  private startedAt = 0
  private generation = 0
  private readonly realRoot: string
  private readonly record: string
  // What the build writes for itself: the entries it bundles and the lists it hands the stylesheets.
  private readonly generated: string

  constructor(private readonly root: string, output: string, private readonly options: string) {
    this.realRoot = realpathSync(root)
    this.record = join(output, FINGERPRINT)
    this.generated = join(this.realRoot, KAY_DIR) + sep
  }

  // By the path the bundler names a file: the real one.
  private canon(path: string): string {
    return path.startsWith(this.root + sep) ? this.realRoot + path.slice(this.root.length) : path
  }

  // Whether the build the last run left is the one these sources and this kay give. The stamps become the ones the next record starts from.
  async fresh(): Promise<boolean> {
    let saved: StampRecord

    try {
      saved = await Bun.file(this.record).json() as StampRecord
    }
    catch {
      return false
    }

    const output = join(this.record, '..')
    let manifest: string | undefined

    try {
      manifest = await Bun.file(join(output, MANIFEST)).text()
    }
    catch {}

    if (saved.identity !== identity() || saved.options !== this.options || manifest === undefined || saved.manifest !== Bun.hash(manifest).toString(36) || await Bun.file(join(output, BUILD_FAILURE)).exists())
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

    return true
  }

  // A build starts: the record of the one before no longer describes the output, and the files it was asked to read again are stamped before it reads them.
  begin(changed: string[] | null): void {
    this.generation++
    this.startedAt = Date.now()
    rmSync(this.record, { force: true })

    if (changed === null)
      this.known.clear()

    for (const file of changed ?? [])
      this.known.set(this.canon(join(this.root, file)), fileStamp(this.canon(join(this.root, file))) ?? '')
  }

  // A build succeeded: its record is written once `settled`, the rewriting of the maps it started, is over, unless another build began meanwhile.
  finish(inputs: Iterable<string>, manifest: string, settled: Promise<unknown> | undefined): void {
    const generation = this.generation
    const stamps = new Map<string, string>()

    for (const path of [...inputs, ...kayModules()]) {
      const file = this.canon(path)

      if (stamps.has(file) || file.startsWith(this.generated))
        continue

      let stamp = this.known.get(file)

      if (stamp === undefined) {
        stamp = fileStamp(file) ?? ''

        if (unsettled(stamp, this.startedAt))
          stamp = RACY
      }

      stamps.set(file, stamp)
    }

    this.known = stamps
    void this.write(generation, manifest, settled)
  }

  private async write(generation: number, manifest: string, settled: Promise<unknown> | undefined): Promise<void> {
    try {
      await settled

      if (generation !== this.generation)
        return

      const record: StampRecord = { identity: identity(), options: this.options, manifest: Bun.hash(manifest).toString(36), outputs: await outputsOf(this.root), stamps: Object.fromEntries(this.known) }

      await writeAtomically(this.record, JSON.stringify(record))

      if (generation !== this.generation)
        rmSync(this.record, { force: true })
    }
    // Without a record the next start builds, which is what a read-only disk or a build that stopped halfway gets.
    catch {}
  }
}
