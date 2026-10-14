import type { KayConfig } from '../src/config'
import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import type { PrerenderOptions } from '../src/server/prerender'
import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { withConfig } from '../src/config'
import { modeOf, resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { PRERENDERED_DIR, readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { scratchDir } from './scratch'

// A copy of the checkout's client build in a scratch directory, without the pages it prerendered: what a test prerenders into and serves from, so the checkout's own `.kay/client` is never written.
// The `.kay` loader stays on the checkout's root, as the project's `paths.output` is the only thing that moves.
export interface ScratchBuild {
  dir: string
  // The pages directory under it.
  pages: string
  // The client build it holds, which `prerender` and `serve` read.
  client: () => Promise<ClientBuild>
  // Prerenders the routes `config` names into it, `client` standing in for its build when given.
  prerender: (config: KayConfig, options?: PrerenderOptions, client?: ClientBuild) => Promise<number>
  // What `pages()` serves, read from it.
  serve: (options?: PagesOptions) => ReturnType<typeof servePages>
  // The pages it holds, as a prerender writes them, and the manifest, back to what they were when `keeping` returns.
  keeping: <T>(change: () => Promise<T>) => Promise<T>
  remove: () => Promise<void>
}

// `manifestOnly` leaves the client build's files out, for a prerender refused before it reads any.
export async function scratchBuild(manifestOnly = false): Promise<ScratchBuild> {
  const root = process.cwd()
  const dir = await scratchDir('build-')
  const pages = join(dir, PRERENDERED_DIR)

  try {
    if (!manifestOnly)
      await cp(outputDir(root), dir, { recursive: true, filter: source => source !== join(outputDir(root), PRERENDERED_DIR) })

    const manifest = (await readManifest(root, manifestOnly ? outputDir(root) : dir))!

    delete manifest.pages
    delete manifest.site
    await writeManifest(root, manifest, dir)
  }
  catch (error) {
    await rm(dir, { recursive: true, force: true })

    throw error
  }

  const client = async () => (await readClient(root, dir))!
  const project = (config: KayConfig) => {
    const resolved = resolveProject(root, config)

    return { ...resolved, paths: { ...resolved.paths, output: dir } }
  }

  return {
    dir,
    pages,
    client,
    prerender: async (config, options, built) => prerenderPages(project(config), built ?? await client(), options),
    serve: async (options = {}) => {
      const mode = modeOf({ prebuilt: true, ...options })
      const resolved = resolveProject(root, { ...await withConfig(root, options), dev: mode.dev, prebuilt: mode.prebuilt }, mode)

      return servePages({ ...resolved, paths: { ...resolved.paths, output: dir } }, client)
    },
    keeping: async (change) => {
      const manifest = await readManifest(root, dir)
      const files = await Promise.all([...new Bun.Glob('**/*').scanSync(pages)].map(async (file): Promise<[string, Uint8Array]> => [file, await Bun.file(join(pages, file)).bytes()]))

      try {
        return await change()
      }
      finally {
        await rm(pages, { recursive: true, force: true })
        await Promise.all(files.map(async ([file, bytes]) => Bun.write(join(pages, file), bytes)))
        await writeManifest(root, manifest!, dir)
      }
    },
    remove: async () => rm(dir, { recursive: true, force: true }),
  }
}

export interface Prerendered extends ScratchBuild {
  count: () => number
}

// The routes prerendered once for a describe's tests, which read that one render through `serve` and the files under `pages`; a test changing the render goes through `keeping`.
export function prerendered(config: KayConfig, client: (built: ClientBuild) => ClientBuild = built => built): Prerendered {
  let count = 0
  let build: ScratchBuild | undefined

  beforeAll(async () => {
    build = await scratchBuild()
    count = await build.prerender(config, undefined, client(await build.client()))
  })

  afterAll(async () => build?.remove())

  // The tests run after beforeAll, so these only look through to the build it made.
  return {
    get dir() {
      return build!.dir
    },
    get pages() {
      return build!.pages
    },
    client: async () => build!.client(),
    prerender: async (...args) => build!.prerender(...args),
    serve: async options => build!.serve(options),
    keeping: async change => build!.keeping(change),
    remove: async () => build!.remove(),
    count: () => count,
  }
}

// A prerender a test expects refused, which throws before it writes the manifest or reads the build's files: only the manifest is copied.
export async function refusedPrerender(config: KayConfig, client: ClientBuild, options?: PrerenderOptions): Promise<number> {
  const build = await scratchBuild(true)

  try {
    return await build.prerender(config, options, client)
  }
  finally {
    await build.remove()
  }
}
