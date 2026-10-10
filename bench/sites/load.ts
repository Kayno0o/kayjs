import type { Subprocess } from 'bun'
import type { Variant } from './sites'
import { readFileSync } from 'node:fs'
import { median } from '../format'
import { memory, startServer, waitReady } from './serve'

export interface ColdStart {
  ms: number
  rss: number
}

export interface Load {
  url: string
  rps: number
  p50: number
  p99: number
  // CPU microseconds per request, of the site's server and of nginx compressing what it did not.
  serverCpu: number
  nginxCpu: number
}

const COLD_STARTS = 7
const CONCURRENCY = 32
const WARMUP_MS = 1000
const LOAD_MS = 5000
// What /proc counts CPU time in, per second.
const CLOCK_TICKS = 100
const WHITESPACE = /\s+/

// From spawning the server to its first 200 on the home page, and its memory then: median of `COLD_STARTS`.
export async function coldStart(variant: Variant): Promise<ColdStart> {
  const runs: ColdStart[] = []

  for (let run = 0; run < COLD_STARTS; run++) {
    const server = startServer(variant)

    runs.push({ ms: await waitReady(variant, server), rss: memory(server.pid).rss })
    server.kill()
    await server.exited
  }

  return { ms: median(runs.map(run => run.ms)), rss: median(runs.map(run => run.rss)) }
}

function cpuSeconds(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // The fields after the command name, which is in parentheses and may hold spaces.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

  return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS
}

function nginxCpuSeconds(nginx: Subprocess): number {
  const workers = readFileSync(`/proc/${nginx.pid}/task/${nginx.pid}/children`, 'utf8').trim().split(WHITESPACE).map(Number)

  return workers.reduce((sum, pid) => sum + cpuSeconds(pid), 0)
}

// `CONCURRENCY` clients requesting `path` through nginx over keepalive HTTP/1.1 as browsers ask, brotli accepted.
export async function load(variant: Variant, path: string, server: Subprocess, nginx: Subprocess): Promise<Load> {
  const url = `http://127.0.0.1:${variant.ports.http}${path}`
  const latencies: number[] = []
  const clients = async (until: number, record: boolean) => {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < until) {
        const started = performance.now()
        const response = await fetch(url, { headers: { 'accept': 'text/html,text/css,*/*', 'accept-encoding': 'br, gzip' }, decompress: false })

        await response.arrayBuffer()

        if (response.status !== 200)
          throw new Error(`${url} answered ${response.status}`)

        if (record)
          latencies.push(performance.now() - started)
      }
    }))
  }

  await clients(performance.now() + WARMUP_MS, false)

  const serverBefore = cpuSeconds(server.pid)
  const nginxBefore = nginxCpuSeconds(nginx)
  const started = performance.now()

  await clients(started + LOAD_MS, true)

  const seconds = (performance.now() - started) / 1000
  const sorted = latencies.toSorted((a, b) => a - b)
  const perRequest = (cpu: number) => cpu / latencies.length * 1e6

  return {
    url: path,
    rps: latencies.length / seconds,
    p50: sorted[sorted.length >> 1]!,
    p99: sorted[Math.floor(sorted.length * 0.99)]!,
    serverCpu: perRequest(cpuSeconds(server.pid) - serverBefore),
    nginxCpu: perRequest(nginxCpuSeconds(nginx) - nginxBefore),
  }
}
