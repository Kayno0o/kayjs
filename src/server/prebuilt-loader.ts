import type { OnLoadArgs, OnLoadResult, PluginBuilder } from 'bun'
import type { CapturedLoad } from '../build/captured-loads'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { plugin } from 'bun'
import { ASSET_FILE } from '../build/assets'
import { KAY_FILE, scriptLoader } from '../build/files'
import { registerEmbeddedMapFile } from '../build/sourcemap'
import { projectPaths } from '../project'
import { readServerRecord, recordName, ROOT_TOKEN, SERVER_DIR, UP_TOKEN } from './server-record'

const WASM_FILE = /\.wasm$/i
const REGEX_SYNTAX = /[$()*+.?[\\\]^{|}]/g
const registered = new Map<string, Promise<boolean>>()
const TOKENS = new RegExp(`${ROOT_TOKEN}|${UP_TOKEN}`, 'g')

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

  // A build recorded later is looked for again.
  if (!await known)
    registered.delete(base)

  return known
}

async function register(root: string, output: string): Promise<boolean> {
  const base = root
  const record = await readServerRecord(output)

  if (record === undefined)
    return false

  const anchor = resolve(base, record.anchor ?? '.')
  // What the tokens of a recorded module stand for, as the build moved.
  const placed = (text: string) => text.replace(TOKENS, token => token === ROOT_TOKEN ? base : anchor)
  const replaced = record.replaced.map(file => join(base, file))
  const prefix = base.endsWith(sep) ? base : base + sep
  const scripts = new RegExp(`^${prefix.replace(REGEX_SYNTAX, '\\$&')}(?!(?:.*/)?node_modules/).*\\.(?:m?ts|tsx)$`)
  let loads: Promise<CapturedLoad[]> | undefined
  let onResolve: PluginBuilder['onResolve'] | undefined

  // What the loader would answer: set up on the first module the record cannot answer.
  const compiled = async (args: OnLoadArgs): Promise<OnLoadResult> => {
    loads ??= (async () => {
      const [{ kay }, { capturedLoads }] = await Promise.all([import('../build/plugin'), import('../build/captured-loads')])

      return (await capturedLoads(kay({ target: 'ssr', root, cacheDir: projectPaths(root).cache, settings: record.settings, placeholder: record.placeholder }), onResolve)).loads
    })()

    return (await loads).find(load => load.filter.test(args.path))?.callback(args) ?? asIs(args.path)
  }

  const answer = async (args: OnLoadArgs): Promise<OnLoadResult> => {
    const name = recordName(base, args.path)
    const found = Object.hasOwn(record.files, name) ? record.files[name] : undefined

    const kept = Object.hasOwn(record.covered, name) ? record.covered[name] : undefined

    if (found === undefined) {
      const text = kept === undefined ? undefined : await Bun.file(args.path).text()

      return text !== undefined && Bun.hash(text).toString(36) === kept ? { contents: text, loader: scriptLoader(args.path) } : compiled(args)
    }

    // A wasm file's record is its import's shape, a path or an asset URL, which the file's bytes do not change: asking the loader for it again would lose whether the import wanted the path.
    if (!WASM_FILE.test(args.path) && Bun.hash(await Bun.file(args.path).bytes()).toString(36) !== found.hash)
      return compiled(args)

    // Read when a stack first needs it, and named by the path the module has now.
    if (found.map !== undefined) {
      const map = join(output, SERVER_DIR, found.map)

      registerEmbeddedMapFile(args.path, () => readFileSync(map, 'utf8'))
    }

    return { contents: placed(await Bun.file(join(output, SERVER_DIR, found.file)).text()), loader: found.loader }
  }

  plugin({
    name: 'kay-prebuilt',
    setup(build) {
      onResolve = build.onResolve.bind(build)
      build.onLoad({ filter: KAY_FILE }, answer)
      build.onLoad({ filter: ASSET_FILE }, answer)

      if (replaced.length > 0)
        build.onLoad({ filter: new RegExp(`^(?:${replaced.map(file => resolve(file).replace(REGEX_SYNTAX, '\\$&')).join('|')})$`) }, answer)

      build.onLoad({ filter: scripts }, answer)

      for (const [name, file] of Object.entries(record.icons))
        build.module(name, () => ({ contents: placed(readFileSync(join(output, SERVER_DIR, file), 'utf8')), loader: 'js' }))
    },
  })

  return true
}
