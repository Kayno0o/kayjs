import type { OnLoadArgs, OnLoadResult } from 'bun'
import type { CapturedLoad } from '../build/captured-loads'
import { readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { plugin } from 'bun'
import { ASSET_FILE } from '../build/assets'
import { KAY_FILE, scriptLoader } from '../build/files'
import { projectPaths } from '../project'
import { readServerRecord, ROOT_TOKEN, SERVER_DIR } from './server-record'

const REGEX_SYNTAX = /[$()*+.?[\\\]^{|}]/g
const registered = new Map<string, Promise<boolean>>()

// The runtime wants an answer from every load, so a script the loader leaves as it is is read.
async function asIs(path: string): Promise<OnLoadResult> {
  return { contents: await Bun.file(path).text(), loader: scriptLoader(path) }
}

// Lets this process import the modules `kay build` recorded, in the place of the `.kay` loader: a `.kay` file, an imported asset or a script the loader changes is read from the record, with the compiler left unloaded.
// A module the record lacks, or whose source changed since the build, is compiled as the loader would compile it. False when the build recorded none.
export async function registerPrebuiltLoader(root: string, output: string): Promise<boolean> {
  const base = realpathSync(root)
  const known = registered.get(base) ?? register(base, output)

  registered.set(base, known)

  return known
}

async function register(base: string, output: string): Promise<boolean> {
  const root = base
  const record = await readServerRecord(output)

  if (record === undefined)
    return false

  const covered = new Set(record.covered)
  const replaced = record.replaced.map(file => join(base, file))
  const prefix = base.endsWith(sep) ? base : base + sep
  const scripts = new RegExp(`^${prefix.replace(REGEX_SYNTAX, '\\$&')}(?!(?:.*/)?node_modules/).*\\.(?:m?ts|tsx)$`)
  let loads: Promise<CapturedLoad[]> | undefined

  // What the loader would answer: set up on the first module the record cannot answer.
  const compiled = async (args: OnLoadArgs): Promise<OnLoadResult> => {
    loads ??= (async () => {
      const [{ kay }, { capturedLoads }] = await Promise.all([import('../build/plugin'), import('../build/captured-loads')])

      return (await capturedLoads(kay({ target: 'ssr', root, cacheDir: projectPaths(root).cache, settings: record.settings, placeholder: record.placeholder }))).loads
    })()

    return (await loads).find(load => load.filter.test(args.path))?.callback(args) ?? asIs(args.path)
  }

  const answer = async (args: OnLoadArgs): Promise<OnLoadResult> => {
    const name = relative(base, args.path).split(sep).join('/')
    const found = record.files[name]

    if (found === undefined)
      return covered.has(name) ? asIs(args.path) : compiled(args)

    if (Bun.hash(await Bun.file(args.path).bytes()).toString(36) !== found.hash)
      return compiled(args)

    return { contents: (await Bun.file(join(output, SERVER_DIR, found.file)).text()).replaceAll(ROOT_TOKEN, base), loader: found.loader }
  }

  plugin({
    name: 'kay-prebuilt',
    setup(build) {
      build.onLoad({ filter: KAY_FILE }, answer)
      build.onLoad({ filter: ASSET_FILE }, answer)

      if (replaced.length > 0)
        build.onLoad({ filter: new RegExp(`^(?:${replaced.map(file => resolve(file).replace(REGEX_SYNTAX, '\\$&')).join('|')})$`) }, answer)

      build.onLoad({ filter: scripts }, answer)

      for (const [name, file] of Object.entries(record.icons))
        build.module(name, () => ({ contents: readFileSync(join(output, SERVER_DIR, file), 'utf8'), loader: 'js' }))
    },
  })

  return true
}
