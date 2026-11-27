// One file served as it is (a hashed asset, a public file, a prerendered page, a `--static` file): its headers, validators and encoded variants are fixed when it is listed, so a request only picks one.

import type { CompressionCache } from './compress'
import { statSync } from 'node:fs'
import { markCompressionHandled, mergeVaryValue, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { etagMatches } from './http'

const textEncoder = new TextEncoder()

/** A file on disk (or embedded in a binary), bytes, or an HTML string. */
export type FileSource = { path: string } | { bytes: Uint8Array<ArrayBuffer> } | { text: string }

interface Variant {
  body: BodyInit
  headers: Record<string, string>
  /** The file's path and size, for a variant on disk the compression cache may keep in memory. */
  disk: { path: string, size: () => number } | undefined
}

export interface ServedFile {
  /** The compression cache key, which changes with the file's version. */
  key: string
  etag: string | undefined
  headers: Record<string, string>
  notModifiedHeaders: Record<string, string>
  /** Headers of the variant compressed here on first request; undefined when the file is never compressed here. */
  compressedHeaders: Record<string, string> | undefined
  br: Variant | undefined
  gz: Variant | undefined
  body: BodyInit
  read: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
  /** The identity body's byte length, read on the first `HEAD`. */
  size: () => number
}

export interface ServedFileInit {
  key: string
  source: FileSource
  /** `content-type`, `cache-control` and the security headers. */
  headers: Record<string, string>
  /** Defaults to the source's size and mtime, or a hash of its bytes. */
  etag?: string | undefined
  /** Whether the server may compress it on first request. */
  compressible: boolean
  br?: FileSource | undefined
  gz?: FileSource | undefined
}

export function bodyOf(source: FileSource): BodyInit {
  return 'path' in source ? Bun.file(source.path) : 'bytes' in source ? source.bytes : source.text
}

async function bytesOf(source: FileSource): Promise<Uint8Array<ArrayBuffer>> {
  return 'path' in source ? new Uint8Array(await Bun.file(source.path).arrayBuffer()) : 'bytes' in source ? source.bytes : textEncoder.encode(source.text)
}

/** `W/"<size>-<mtime>"` for a file on disk, a hash of the bytes otherwise. */
export function sourceEtag(source: FileSource): string {
  if ('path' in source) {
    const st = statSync(source.path)
    return `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  }
  return `W/"${Bun.hash('bytes' in source ? source.bytes : source.text).toString(36)}"`
}

export function servedFile(init: ServedFileInit): ServedFile {
  const etag = init.etag ?? sourceEtag(init.source)
  const varies = init.compressible || init.br !== undefined || init.gz !== undefined
  const headers: Record<string, string> = { ...init.headers, etag, ...(varies ? { vary: mergeVaryValue(init.headers.vary, 'Accept-Encoding') } : {}) }
  const { 'content-type': _type, ...notModifiedHeaders } = headers
  const onDisk = (path: string): Variant['disk'] => {
    let bytes: number | undefined
    return { path, size: () => bytes ??= Bun.file(path).size }
  }
  const encoded = (source: FileSource | undefined, encoding: string): Variant | undefined =>
    source === undefined ? undefined : { body: bodyOf(source), headers: { ...headers, 'content-encoding': encoding, 'etag': toWeakEtag(etag) }, disk: 'path' in source ? onDisk(source.path) : undefined }
  let size: number | undefined
  return {
    key: `${init.key}:${etag}`,
    etag,
    headers,
    notModifiedHeaders,
    compressedHeaders: init.compressible ? { ...headers, etag: toWeakEtag(etag) } : undefined,
    br: encoded(init.br, 'br'),
    gz: encoded(init.gz, 'gzip'),
    body: bodyOf(init.source),
    read: () => bytesOf(init.source),
    size: () => size ??= 'path' in init.source ? Bun.file(init.source.path).size : 'bytes' in init.source ? init.source.bytes.byteLength : textEncoder.encode(init.source.text).byteLength,
  }
}

/** Answers a request for a listed file: a 304 to a matching `If-None-Match`, its length to a `HEAD`, else a precompressed sidecar, a variant compressed here, or the file. */
export function createFileServer(options: {
  compressEnabled: boolean
  compressCache: CompressionCache | undefined
  withHsts: (res: Response, request: Request) => Response
}) {
  const { compressEnabled, compressCache, withHsts } = options
  const done = (res: Response, request: Request): Response => markCompressionHandled(withHsts(res, request))

  return async function serveFile(request: Request, file: ServedFile, status = 200): Promise<Response> {
    if (status === 200 && file.etag !== undefined && etagMatches(request.headers.get('if-none-match'), file.etag))
      return done(new Response(null, { status: 304, headers: file.notModifiedHeaders }), request)
    if (request.method === 'HEAD')
      return done(new Response(null, { status, headers: { ...file.headers, 'content-length': String(file.size()) } }), request)
    const accept = request.headers.get('accept-encoding')
    if (compressEnabled && (file.br !== undefined || file.gz !== undefined)) {
      const pre = pickPrecompressedEncoding(accept, { br: file.br !== undefined, gz: file.gz !== undefined })
      if (pre !== undefined) {
        const variant = pre === 'br' ? file.br! : file.gz!
        const { disk } = variant
        const kept = disk !== undefined && compressCache?.keeps(disk.size()) === true
          ? await compressCache.sidecar(`${file.key}:${pre}`, async () => new Uint8Array(await Bun.file(disk.path).arrayBuffer()))
          : undefined
        return done(new Response(kept ?? variant.body, { status, headers: variant.headers }), request)
      }
    }
    if (file.compressedHeaders !== undefined && compressCache !== undefined) {
      const enc = pickEncoding(accept)
      if (enc !== undefined) {
        const compressed = await compressCache.file(file.key, enc, file.read)
        if (compressed !== undefined)
          return done(new Response(compressed, { status, headers: { ...file.compressedHeaders, 'content-encoding': enc } }), request)
      }
    }
    return done(new Response(file.body, { status, headers: file.headers }), request)
  }
}
