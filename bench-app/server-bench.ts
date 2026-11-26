// Kay v2 Server Footprint & Compression Benchmark:
// Measures compiled binary RssAnon, RssFile, VmRSS, cold boot latency, wire sizes, and in-process req/s.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { measure } from 'mitata'
import { build } from '@kayjs/kay/build'
import { createServer } from '@kayjs/kay/server'

const ROOT = import.meta.dir

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function readProcMemoryMiB(pid: number): { rssAnon: number, rssFile: number, vmRss: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const kb = (field: string) => {
    const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(status)
    return m ? Number(m[1]) / 1024 : 0
  }
  return {
    rssAnon: kb('RssAnon'),
    rssFile: kb('RssFile'),
    vmRss: kb('VmRSS'),
  }
}

// 1. Build & compile standalone executable
rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
const binPath = join(ROOT, 'dist/bench-server-bin')
const tBuild = performance.now()
await build({ root: ROOT, minify: true, compile: binPath })
const buildMs = performance.now() - tBuild

// 2. Measure compiled binary idle RSS & cold boot (median of 3 fresh processes, after 1 request)
const bootSamples: number[] = []
const anonSamples: number[] = []
const fileSamples: number[] = []
const rssSamples: number[] = []
let rawBytes = 0
let gzipBytes = 0
let zstdBytes = 0

for (let i = 0; i < 3; i++) {
  const port = 36500 + i * 17 + Math.floor(Math.random() * 10)
  const t0 = performance.now()
  const proc = Bun.spawn([binPath], {
    env: { ...process.env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let out = ''
    while (!out.includes('listening on')) {
      const { done, value } = await reader.read()
      if (done)
        throw new Error(`server binary exited early: ${out}`)
      out += dec.decode(value)
    }
    reader.releaseLock()

    const rRaw = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'identity' }, decompress: false })
    rawBytes = (await rRaw.arrayBuffer()).byteLength
    bootSamples.push(performance.now() - t0)

    const rGz = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'gzip' }, decompress: false })
    gzipBytes = (await rGz.arrayBuffer()).byteLength

    const rZstd = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'accept-encoding': 'zstd' }, decompress: false })
    zstdBytes = (await rZstd.arrayBuffer()).byteLength

    if (existsSync(`/proc/${proc.pid}/status`)) {
      const mem = readProcMemoryMiB(proc.pid)
      anonSamples.push(mem.rssAnon)
      fileSamples.push(mem.rssFile)
      rssSamples.push(mem.vmRss)
    }
  }
  finally {
    proc.kill()
    await proc.exited
  }
}

// 3. In-process throughput: raw vs gzip vs zstd (cached & uncached)
const app = await createServer({ root: ROOT })
const reqRaw = new Request('http://localhost/')
const reqGzip = new Request('http://localhost/', { headers: { 'accept-encoding': 'gzip' } })
const reqZstd = new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd' } })

await app.handle(reqRaw)
await app.handle(reqGzip)
await app.handle(reqZstd)

const rawStats = await measure(async () => (await app.handle(reqRaw)).arrayBuffer(), { min_cpu_time: 1e9 })
const gzipStats = await measure(async () => (await app.handle(reqGzip)).arrayBuffer(), { min_cpu_time: 1e9 })
const zstdStats = await measure(async () => (await app.handle(reqZstd)).arrayBuffer(), { min_cpu_time: 1e9 })

console.log('\n=== KAY V2 SERVER FOOTPRINT (bench-app --compile) ===')
console.log(`Build + --compile: ${buildMs.toFixed(1)} ms`)
console.log(`Cold boot + 1st page (median of 3): ${median(bootSamples).toFixed(1)} ms`)
console.log(`Memory after 1st page: RssAnon ${median(anonSamples).toFixed(1)} MiB | RssFile ${median(fileSamples).toFixed(1)} MiB | VmRSS ${median(rssSamples).toFixed(1)} MiB`)
console.log(`Wire size (/): raw ${(rawBytes / 1024).toFixed(2)} KB | gzip ${(gzipBytes / 1024).toFixed(2)} KB (-${(100 - gzipBytes / rawBytes * 100).toFixed(1)}%) | zstd ${(zstdBytes / 1024).toFixed(2)} KB (-${(100 - zstdBytes / rawBytes * 100).toFixed(1)}%)`)
console.log(`SSR req/s (500 products): raw ${Math.round(1e9 / rawStats.avg)} | gzip(LRU) ${Math.round(1e9 / gzipStats.avg)} | zstd(LRU) ${Math.round(1e9 / zstdStats.avg)}`)
