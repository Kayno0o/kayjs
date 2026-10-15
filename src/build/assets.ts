import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, extname, join } from 'node:path'
import process from 'node:process'

// Files a component or module imports for their URL.
export const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf', 'wasm']
export const ASSET_FILE = new RegExp(`\\.(?:${ASSET_EXTENSIONS.join('|')})$`, 'i')
// Where the browser build and imported assets are served from, out of `clientDir`.
export const ASSET_PREFIX = '/_kay/'
const ASSETS_DIR = 'assets'

// A server `kay dev` started, which it tells how many changes came before it.
export function underKayDev(): boolean {
  return process.env.KAY_DEV_CODE !== undefined
}

// Where kay keeps what it generates, under the project root.
export const KAY_DIR = '.kay'

// Names the directory under `.kay` the server `kay render` runs builds into: one of its own, removed once it answered, so it never deletes what `kay build` or a `kay dev` beside it wrote.
export const RENDER_OUTPUT = 'KAY_RENDER_OUTPUT'

const outputOf = new AsyncLocalStorage<string>()

// Runs `work` with every build it starts writing into `.kay/<name>`, whatever `outputDir` would say, for a build that must leave `kay build`'s output alone.
export async function inOutput<Result>(name: string, work: () => Promise<Result>): Promise<Result> {
  return outputOf.run(name, work)
}

// What `kay build` writes and production serves; a `kay dev` server builds into a directory of its own, so a build or a test run beside it never deletes the files its pages link, and so does each worker of `bun test --parallel`, the processes its tests start included.
export function outputDir(root: string): string {
  return join(root, KAY_DIR, outputOf.getStore() ?? process.env[RENDER_OUTPUT] ?? `${underKayDev() ? 'dev' : 'client'}${testWorker()}`)
}

// What sets apart the files each worker of `bun test --parallel` writes, which would otherwise overwrite one another's in a checkout they share.
export function testWorker(): string {
  const worker = process.env.BUN_TEST_WORKER_ID

  return worker === undefined ? '' : `-${worker}`
}

export function clientDir(root: string): string {
  return join(outputDir(root), 'dist')
}

// Named after its content, so the server, the islands and every build agree on a file's URL without sharing anything; written once, when missing.
export async function writeAsset(path: string, root: string): Promise<string> {
  const extension = extname(path)
  const bytes = await Bun.file(path).bytes()
  const name = `${basename(path, extension)}-${Bun.hash(bytes).toString(36)}${extension}`
  const target = Bun.file(join(clientDir(root), ASSETS_DIR, name))

  if (!await target.exists())
    await Bun.write(target, bytes)

  return `${ASSET_PREFIX}${ASSETS_DIR}/${encodeURIComponent(name)}`
}
