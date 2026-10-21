import type { ClientOptions } from '../src/build/client'
import type { ClientBuild } from '../src/server/client'
import { inOutput, testWorker } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { clientOptionsOf, resolveProject } from '../src/project'
import { pages as bundlingPages } from '../src/server'
import { servePages } from '../src/server/app'
import { projectSource } from '../src/server/source'

type PagesOptions = NonNullable<Parameters<typeof bundlingPages>[0]>

const builds = new Map<string, Promise<ClientBuild>>()

// The client build of `root` for `clientOptions`, made once per file into an output of its own.
export async function sharedClient(root: string, clientOptions: ClientOptions): Promise<ClientBuild> {
  const key = JSON.stringify([root, clientOptions], (_, value: unknown) => typeof value === 'bigint' ? String(value) : value)
  let held = builds.get(key)

  if (!held) {
    const name = `shared-build-${builds.size}${testWorker()}`

    held = inOutput(name, async () => buildClient(root, clientOptions))
    builds.set(key, held)
  }

  return held
}

// `pages()` for the tests that bundle the islands as the server boots: the build is made once per root and client options for the whole file, each into an output of its own so a later build never rewrites the files an earlier server serves.
// A test reading the default output (`clientDir(root)`) or changing the fixture between two servers keeps `pages()` from `src/server`.
// A development server and a prebuilt one go through `pages()` itself, and the key ignores function-valued options such as `plugins`, which no test here passes; the Bun check and boot-failure recording of `pages()` are skipped too.
export async function pages(options: PagesOptions = {}): Promise<Awaited<ReturnType<typeof bundlingPages>>> {
  if (options.dev || options.prebuilt !== false)
    return bundlingPages(options)

  const source = projectSource()
  const mode = source.mode(options)
  const root = source.root(options.root ?? process.cwd())
  const project = resolveProject(root, { ...await source.config(root, options), dev: mode.dev, prebuilt: mode.prebuilt }, mode)

  return servePages(project, async () => sharedClient(root, clientOptionsOf(project.config, mode)))
}
