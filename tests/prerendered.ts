import type { KayConfig } from '../src/config'
import type { ClientBuild } from '../src/server/client'
import type { PrerenderOptions } from '../src/server/prerender'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { PRERENDERED_DIR, readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { scratchDir } from './scratch'

export interface Prerendered {
  count: () => number
  // Runs what changes the prerendered build, a page hook or another render, then puts the describe's render back for the tests after it.
  keeping: <T>(change: () => Promise<T>) => Promise<T>
}

// The routes prerendered once for a describe's tests, which read that one render, the build put back as it was once they ran.
// It goes into the checkout's build, as the .kay loader serves one root a process and every test file serves its fixtures from the checkout. Under `bun test --parallel` that build is the worker's own (`outputDir` adds BUN_TEST_WORKER_ID), whose files run one after another, and `tests/one-run.ts` keeps two runs apart, so no other file reads or writes it meanwhile.
export function prerendered(config: KayConfig, client: (built: ClientBuild) => ClientBuild = built => built): Prerendered {
  const root = process.cwd()
  const dir = join(outputDir(root), PRERENDERED_DIR)
  let count = 0
  let restore: (() => Promise<void>) | undefined

  beforeAll(async () => {
    // Without the pages a run killed mid-describe left behind, which the client build never holds.
    const manifest = (await readManifest(root))!

    delete manifest.pages
    delete manifest.site

    restore = async () => {
      await rm(dir, { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
    await restore()
    count = await prerenderPages(resolveProject(root, config), client((await readClient(root))!))
  })

  afterAll(async () => restore?.())

  return {
    count: () => count,
    keeping: async (change) => {
      const manifest = (await readManifest(root))!
      const files = await Promise.all([...new Bun.Glob('**/*').scanSync(dir)].map(async (file): Promise<[string, Uint8Array]> => [file, await Bun.file(join(dir, file)).bytes()]))

      try {
        return await change()
      }
      finally {
        await rm(dir, { recursive: true, force: true })
        await Promise.all(files.map(async ([file, bytes]) => Bun.write(join(dir, file), bytes)))
        await writeManifest(root, manifest)
      }
    },
  }
}

// A prerender a test expects refused, which throws before it writes the manifest: the pages it renders first go to a scratch directory, not over the checkout's build.
export async function refusedPrerender(config: KayConfig, client: ClientBuild, options?: PrerenderOptions): Promise<number> {
  const project = resolveProject(process.cwd(), config)
  const output = await scratchDir('refused-')

  try {
    return await prerenderPages({ ...project, paths: { ...project.paths, output } }, client, options)
  }
  finally {
    await rm(output, { recursive: true, force: true })
  }
}
