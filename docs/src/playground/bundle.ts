import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress } from 'node:zlib'

const compress = promisify(brotliCompress)

export interface Bundled {
  text: string | Uint8Array<ArrayBuffer>
  brotli: Uint8Array<ArrayBuffer>
  // One validator per encoding, as the plain and the brotli body are different representations.
  etag: string
  brotliEtag: string
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

const OXC_PARSER = /^oxc-parser$/

// The parser is a native binding, so the browser gets the WebAssembly build the binding package ships as one file, which fetches `parser.wasm32-wasip1.wasm` from beside the bundle (a route of the docs serves it).
const wasmParser: Bun.BunPlugin = {
  name: 'playground-wasm-parser',
  setup(build) {
    build.onResolve({ filter: OXC_PARSER }, () => ({ path: Bun.resolveSync('@oxc-parser/binding-wasm32-wasip1/package.json', import.meta.dir).replace('package.json', 'browser-bundle.js') }))
  },
}

// The WebAssembly build of the parser as the browser fetches it, read and compressed once, under validators that change with its bytes: the playground revalidates it as it does the bundles, so a second open costs a 304.
export function parserWasm(): () => Promise<Bundled> {
  let kept: Promise<Bundled> | undefined

  async function read(): Promise<Bundled> {
    const text = new Uint8Array(await Bun.file(Bun.resolveSync('@oxc-parser/binding-wasm32-wasip1/wasm', import.meta.dir)).arrayBuffer())
    const hash = Bun.hash(text).toString(36)

    return { text, brotli: new Uint8Array(await compress(text)), etag: `"${hash}"`, brotliEtag: `"${hash}-br"` }
  }

  return async () => {
    kept ??= read()

    try {
      return await kept
    }
    catch (error) {
      kept = undefined

      throw error
    }
  }
}

// What a browser lacks of the Node a library written for both reads: the parser asks `process.env` and `process.emitWarning`, which would throw as its chunk evaluates, so they are defined away rather than shimmed.
const DEFINED = { 'process.env': '{}', 'process.emitWarning': 'undefined' }

// A playground file bundled for the browser when first asked for (the server asks once it listens), then kept: no docs page carries it, and kay's own client build would refuse the parser's reads of `process`.
export function bundled(file: string, minify: boolean): () => Promise<Bundled> {
  let kept: Promise<Bundled> | undefined

  async function build(): Promise<Bundled> {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, file)], target: 'browser', format: 'esm', minify, define: DEFINED, plugins: [asyncHooks, wasmParser] })

    if (!result.success)
      throw new Error(`The playground's ${file} did not build: ${result.logs.join('\n')}`)

    const text = await result.outputs[0]!.text()

    const hash = Bun.hash(text).toString(36)

    return { text, brotli: new Uint8Array(await compress(text)), etag: `"${hash}"`, brotliEtag: `"${hash}-br"` }
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

const WEAK_PREFIX = /^W\//
const BROTLI_REFUSED = /(?:^|,)\s*br\s*;\s*q=0(?:\.0{0,3})?\s*(?:,|$)/i
const BROTLI_TOKEN = /(?:^|,)\s*br\s*(?:;|,|$)/i

// RFC 9110 section 13.1.2: `*` or a list of entity-tags, compared weakly, so `W/` forms match their strong twins.
function listed(header: string | null, etag: string): boolean {
  if (header === null)
    return false

  if (header.trim() === '*')
    return true

  return header.split(',').some(tag => tag.trim().replace(WEAK_PREFIX, '') === etag)
}

// The body in the form the request accepts, brotli when it does, under the validator of that form.
export function respond(request: Request, built: Bundled, headers: Record<string, string>): Response {
  const accepted = request.headers.get('accept-encoding') ?? ''
  const brotli = BROTLI_TOKEN.test(accepted) && !BROTLI_REFUSED.test(accepted)
  const etag = brotli ? built.brotliEtag : built.etag
  const cacheControl = headers['cache-control'] ?? 'no-cache'

  // Revalidated on each visit, so an unchanged bundle costs a 304 and not the download.
  if (listed(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl, 'vary': 'accept-encoding' } })

  if (brotli)
    return new Response(built.brotli, { headers: { ...headers, 'etag': etag, 'content-encoding': 'br', 'vary': 'accept-encoding' } })

  return new Response(built.text, { headers: { ...headers, etag, vary: 'accept-encoding' } })
}
