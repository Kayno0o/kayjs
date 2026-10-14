// Builds kay's AVIF encoder into src/server/codec: libavif and libaom with libaom's x86 SSE intrinsics compiled to wasm SIMD, about twice as fast as @jsquash/avif's scalar build at the same bytes (#485). Needs docker. `bun codecs/avif/build.ts`
// A version bump changes SOURCES, then the licence texts it names in LICENSES/, src/build/licenses.ts and NOTICE; a link failing on undefined `*_sse2`/`*_ssse3` symbols names asm-only functions to add to asm-only.txt.
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const EMSDK = '6.0.12'
const SOURCES = {
  libavif: { url: 'https://github.com/AOMediaCodec/libavif/archive/refs/tags/v1.4.2.tar.gz', sha256: '2b645287340ba5a631d268b551dc2d72bd73ac33335962dd36dcdb6d8366921d' },
  libaom: { version: '3.15.2', url: 'https://storage.googleapis.com/aom-releases/libaom-3.15.2.tar.gz', sha256: '67bb54b245f33ed98600e08269e6139986e48114e14042474ddd8885801dfddc' },
  libwebp: { url: 'https://github.com/webmproject/libwebp/archive/refs/tags/v1.6.0.tar.gz', sha256: '93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136' },
}

const KIT = import.meta.dir
const CACHE = join(KIT, '.cache')
const OUT = join(CACHE, 'out')
const TARGET = join(KIT, '../../src/server/codec')

mkdirSync(CACHE, { recursive: true })

for (const [name, { url, sha256 }] of Object.entries(SOURCES)) {
  const file = Bun.file(join(CACHE, `${name}.tar.gz`))
  const bytes = await file.exists() ? await file.bytes() : new Uint8Array(await (await fetch(url)).arrayBuffer())
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

  if (digest !== sha256)
    throw new Error(`${url}: sha256 ${digest}, expected ${sha256}`)

  await Bun.write(file, bytes)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT)
chmodSync(OUT, 0o777)

// Root in the container, so a userns-remapped daemon can still write the output, which build.sh leaves world-writable.
const docker = Bun.spawn(['docker', 'run', '--rm', '--user', 'root', '-v', `${KIT}:/kit:ro`, '-v', `${CACHE}:/src:ro`, '-v', `${OUT}:/out`, `emscripten/emsdk:${EMSDK}`, 'bash', '/kit/build.sh'], { stdout: 'inherit', stderr: 'inherit' })

if (await docker.exited !== 0)
  throw new Error(`the build failed (exit ${docker.exitCode})`)

mkdirSync(TARGET, { recursive: true })

for (const name of ['avif-enc.js', 'avif-enc.wasm'])
  await Bun.write(join(TARGET, name), Bun.file(join(OUT, name)))

// Any change to the kit writes other bytes, so the variant cache key names the wasm itself.
const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(join(TARGET, 'avif-enc.wasm')).bytes()).digest('hex').slice(0, 8)

await Bun.write(join(TARGET, 'avif-enc-build.ts'), `// Written by codecs/avif/build.ts: the encoder's libaom and the start of its wasm's sha256, part of the AVIF variant cache key.
export const AVIF_ENCODER = 'aom${SOURCES.libaom.version}-${hash}'
`)

console.log(`src/server/codec: avif-enc.wasm ${(Bun.file(join(TARGET, 'avif-enc.wasm')).size / 2 ** 20).toFixed(2)} MB`)
