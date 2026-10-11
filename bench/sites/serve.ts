import type { Subprocess } from 'bun'
import type { Variant } from './sites'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { run, VARIANTS, WORK } from './sites'

const NGINX = join(WORK, 'nginx')
const READY_TIMEOUT_MS = 20_000
const VM_RSS = /VmRSS:\s+(\d+)/
const VM_HWM = /VmHWM:\s+(\d+)/
const PSS = /^Pss:\s+(\d+)/m
// A process's parent, after the name in parentheses, which may hold spaces and parentheses of its own.
const STAT_PARENT = /^\) \S (\d+)/
const DIGITS = /^\d+$/
// Where nginx keeps its dynamic modules: Arch's and Debian's path unless `NGINX_MODULES` says otherwise.
const MODULES = process.env.NGINX_MODULES ?? '/usr/lib/nginx/modules'
const NOT_WORD = /\W/g
// Every process the bench started and has not seen exit, which an interrupted run stops.
const running = new Set<Subprocess>()

// Where a variant's server writes its stderr, the last start's only.
function serverLog(variant: Variant): string {
  return join(variant.dir, 'server.log')
}

// A process the bench started, stopped with every other if the run is interrupted.
export function tracked<Process extends Subprocess>(process: Process): Process {
  running.add(process)
  void (async () => {
    await process.exited
    running.delete(process)
  })()

  return process
}

// What an interrupted run leaves: every process it started and each one's own, then what still runs in `dirs`, as a dev server's spare respawned while it stopped.
export async function stopEverything(dirs: string[]): Promise<void> {
  const pids = [...running].flatMap(process => processTree(process.pid))

  killAll([...pids, ...dirs.flatMap(processesIn)])
  await Promise.all([...running].map(async process => process.exited))
}

export function killAll(pids: number[]) {
  for (const pid of new Set(pids)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }
}

// Fails when something already answers on `port`, as a server an interrupted run left would: the next one would move to another port, or be timed against it.
export async function ensureFree(port: number, what: string): Promise<void> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data: () => undefined } })

    socket.end()
  }
  catch {
    return
  }

  throw new Error(`${what}: something already answers on port ${port}, a server an interrupted run left? Stop it, then run again`)
}

// A variant's server as production runs it: Astro's standalone entry under Bun (its image aliases node to bun), kay's compiled executable.
export async function startServer(variant: Variant): Promise<Subprocess> {
  await ensureFree(variant.ports.backend, variant.dir)

  return tracked(Bun.spawn(variant.kind === 'astro' ? [process.execPath, 'dist/server/entry.mjs'] : ['./server'], {
    cwd: variant.dir,
    stdout: 'ignore',
    stderr: Bun.file(serverLog(variant)),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(variant.ports.backend), CACHE_PATH: ':memory:', ...variant.site.env },
  }))
}

// Milliseconds until the server answers its home page with a 200; what it printed on stderr if it exits or never does.
export async function waitReady(variant: Variant, server: Subprocess): Promise<number> {
  const started = performance.now()

  while (performance.now() - started < READY_TIMEOUT_MS && server.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${variant.ports.backend}/`)

      await response.arrayBuffer()

      if (response.status === 200)
        return performance.now() - started
    }
    catch {}
    await Bun.sleep(2)
  }

  server.kill()
  await server.exited
  const stderr = (await Bun.file(serverLog(variant)).text()).slice(-2000)

  throw new Error(`${variant.dir} did not answer on ${variant.ports.backend}, exit code ${server.exitCode}:\n${stderr}`)
}

// Resident and peak memory of a process, in bytes.
export function memory(pid: number): { rss: number, peak: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const read = (field: RegExp) => Number(field.exec(status)![1]) * 1024

  return { rss: read(VM_RSS), peak: read(VM_HWM) }
}

// A process and every process it started, still running.
export function processTree(pid: number): number[] {
  const children = new Map<number, number[]>()

  for (const name of readdirSync('/proc')) {
    if (!DIGITS.test(name))
      continue

    let stat: string

    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8')
    }
    catch {
      continue
    }

    const parent = parentOf(stat)

    children.set(parent, [...children.get(parent) ?? [], Number(name)])
  }

  const tree = [pid]

  for (const member of tree)
    tree.push(...children.get(member) ?? [])

  return tree
}

// The parent of a process, from its `/proc/<pid>/stat` line.
export function parentOf(stat: string): number {
  return Number(STAT_PARENT.exec(stat.slice(stat.lastIndexOf(')')))?.[1])
}

// The processes running in `dir` or below it, whoever started them.
export function processesIn(dir: string): number[] {
  return readdirSync('/proc').filter(name => DIGITS.test(name)).flatMap((name) => {
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`)

      return cwd === dir || cwd.startsWith(dir + sep) ? [Number(name)] : []
    }
    catch {
      return []
    }
  })
}

// Proportional and resident memory of a process tree, in bytes: resident memory counts the pages its processes share once each, which proportional memory divides between them.
export function treeMemory(pid: number): { pss: number, rss: number, processes: number } {
  const tree = processTree(pid)
  let pss = 0
  let rss = 0

  // A process that exits between the two reads counts in neither.
  for (const member of tree) {
    try {
      const proportional = Number(PSS.exec(readFileSync(`/proc/${member}/smaps_rollup`, 'utf8'))![1]) * 1024
      const resident = memory(member).rss

      pss += proportional
      rss += resident
    }
    catch {}
  }

  return { pss, rss, processes: tree.length }
}

function upstream(variant: Variant): string {
  return `${variant.site.name.replace(NOT_WORD, '_')}_${variant.kind}`
}

// nginx as a production server sets it up in front of the sites: HTTP/2 over TLS, brotli and gzip at level 6, a keepalive upstream.
export async function startNginx(): Promise<Subprocess> {
  mkdirSync(join(NGINX, 'tmp'), { recursive: true })

  if (!existsSync(join(NGINX, 'cert.pem')))
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=localhost', '-keyout', join(NGINX, 'key.pem'), '-out', join(NGINX, 'cert.pem')], NGINX)

  const servers = VARIANTS.map(variant => `
  upstream ${upstream(variant)} { server 127.0.0.1:${variant.ports.backend}; keepalive 32; }
  server {
    listen 127.0.0.1:${variant.ports.https} ssl;
    listen 127.0.0.1:${variant.ports.http};
    http2 on;
    ssl_certificate ${NGINX}/cert.pem;
    ssl_certificate_key ${NGINX}/key.pem;
    location / {
      proxy_pass http://${upstream(variant)};
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
  }`).join('\n')

  await Bun.write(join(NGINX, 'nginx.conf'), `load_module ${MODULES}/ngx_http_brotli_filter_module.so;
worker_processes auto;
daemon off;
pid ${NGINX}/nginx.pid;
error_log ${NGINX}/error.log warn;
events { worker_connections 4096; }
http {
  types_hash_max_size 4096;
  include /etc/nginx/mime.types;
  access_log off;
  client_body_temp_path ${NGINX}/tmp/body;
  proxy_temp_path ${NGINX}/tmp/proxy;
  fastcgi_temp_path ${NGINX}/tmp/fastcgi;
  uwsgi_temp_path ${NGINX}/tmp/uwsgi;
  scgi_temp_path ${NGINX}/tmp/scgi;
  keepalive_requests 100000;
  gzip on; gzip_vary on; gzip_min_length 1024; gzip_comp_level 6; gzip_proxied any;
  gzip_types text/plain text/css text/xml text/javascript application/javascript application/json application/manifest+json application/wasm image/svg+xml;
  brotli on; brotli_comp_level 6;
  brotli_types text/plain text/css text/xml text/javascript application/javascript application/x-javascript application/json application/manifest+json application/wasm application/xml image/svg+xml;
${servers}
}
`)

  for (const variant of VARIANTS) {
    await ensureFree(variant.ports.http, `nginx for ${variant.dir}`)
    await ensureFree(variant.ports.https, `nginx for ${variant.dir}`)
  }

  return tracked(Bun.spawn(['nginx', '-p', NGINX, '-c', join(NGINX, 'nginx.conf'), '-e', join(NGINX, 'error.log')], { stdout: 'ignore', stderr: 'ignore' }))
}

// Every variant's server and nginx in front, until `stop` saw them exit.
export async function startAll(): Promise<{ servers: Map<Variant, Subprocess>, nginx: Subprocess, stop: () => Promise<void> }> {
  const nginx = await startNginx()
  const servers = new Map<Variant, Subprocess>()
  const stop = async () => {
    for (const server of [...servers.values(), nginx])
      server.kill()
    await Promise.all([...servers.values(), nginx].map(async server => server.exited))
  }

  try {
    for (const variant of VARIANTS)
      servers.set(variant, await startServer(variant))
    for (const variant of VARIANTS)
      await waitReady(variant, servers.get(variant)!)
  }
  catch (error) {
    await stop()

    throw error
  }

  return { servers, nginx, stop }
}
