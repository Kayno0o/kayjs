import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress } from 'node:zlib'

const compress = promisify(brotliCompress)

export interface Bundled {
  text: string
  brotli: Uint8Array<ArrayBuffer>
  etag: string
}

// The server render keeps its locale and island ids in an AsyncLocalStorage, which a browser lacks: the playground renders synchronously, so a stack of one is the same storage.
const ASYNC_HOOKS = `export class AsyncLocalStorage {
  #current

  run(store, run, ...args) {
    const previous = this.#current

    this.#current = store

    try {
      return run(...args)
    }
    finally {
      this.#current = previous
    }
  }

  getStore() {
    return this.#current
  }
}
`

const ASYNC_HOOKS_FILTER = /^node:async_hooks$/
const ANY_FILE = /.*/

const asyncHooks: Bun.BunPlugin = {
  name: 'playground-async-hooks',
  setup(build) {
    build.onResolve({ filter: ASYNC_HOOKS_FILTER }, () => ({ path: 'async-hooks', namespace: 'playground' }))
    build.onLoad({ filter: ANY_FILE, namespace: 'playground' }, () => ({ contents: ASYNC_HOOKS, loader: 'js' }))
  },
}

// What a browser lacks of the Node a library written for both reads: Babel asks `process.env` and `process.emitWarning`, which would throw as its chunk evaluates, so they are defined away rather than shimmed.
const DEFINED = { 'process.env': '{}', 'process.emitWarning': 'undefined' }

// A playground file bundled for the browser when the first visitor asks for it, then kept: no docs page carries it, and kay's own client build would refuse Babel's reads of `process`.
export function bundled(file: string, minify: boolean): () => Promise<Bundled> {
  let kept: Promise<Bundled> | undefined

  async function build(): Promise<Bundled> {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, file)], target: 'browser', format: 'esm', minify, define: DEFINED, plugins: [asyncHooks] })

    if (!result.success)
      throw new Error(`The playground's ${file} did not build: ${result.logs.join('\n')}`)

    const text = await result.outputs[0]!.text()

    return { text, brotli: new Uint8Array(await compress(text)), etag: `"${Bun.hash(text).toString(36)}"` }
  }

  return async () => {
    kept ??= build()

    try {
      return await kept
    }
    catch (error) {
      kept = undefined

      throw error
    }
  }
}

// The body in the form the request accepts, brotli when it does.
export function respond(request: Request, built: Bundled, headers: Record<string, string>): Response {
  // Revalidated on each visit, so an unchanged bundle costs a 304 and not the download.
  if (request.headers.get('if-none-match') === built.etag)
    return new Response(null, { status: 304, headers: { 'etag': built.etag, 'cache-control': headers['cache-control'] ?? 'no-cache' } })

  if (request.headers.get('accept-encoding')?.includes('br'))
    return new Response(built.brotli, { headers: { ...headers, 'etag': built.etag, 'content-encoding': 'br', 'vary': 'accept-encoding' } })

  return new Response(built.text, { headers: { ...headers, etag: built.etag, vary: 'accept-encoding' } })
}
