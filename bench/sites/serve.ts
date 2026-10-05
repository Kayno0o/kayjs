import type { Subprocess } from 'bun'
import type { Variant } from './sites'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run, VARIANTS, WORK } from './sites'

const NGINX = join(WORK, 'nginx')
const READY_TIMEOUT_MS = 20_000
const VM_RSS = /VmRSS:\s+(\d+)/
const VM_HWM = /VmHWM:\s+(\d+)/
// Where nginx keeps its dynamic modules: Arch's and Debian's path unless `NGINX_MODULES` says otherwise.
const MODULES = process.env.NGINX_MODULES ?? '/usr/lib/nginx/modules'

// A variant's server as production runs it: Astro's standalone entry under Bun (its image aliases node to bun), kay's compiled executable.
export function startServer(variant: Variant): Subprocess {
  return Bun.spawn(variant.kind === 'astro' ? ['bun', 'dist/server/entry.mjs'] : ['./server'], {
    cwd: variant.dir,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(variant.ports.backend), CACHE_PATH: ':memory:', ...variant.site.env },
  })
}

// Milliseconds until the server answers its home page with a 200.
export async function waitReady(variant: Variant): Promise<number> {
  const started = performance.now()

  while (performance.now() - started < READY_TIMEOUT_MS) {
    try {
      const response = await fetch(`http://127.0.0.1:${variant.ports.backend}/`)

      await response.arrayBuffer()

      if (response.status === 200)
        return performance.now() - started
    }
    catch {}
    await Bun.sleep(2)
  }

  throw new Error(`${variant.dir} did not answer on ${variant.ports.backend}`)
}

// Resident and peak memory of a process, in bytes.
export function memory(pid: number): { rss: number, peak: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const read = (field: RegExp) => Number(field.exec(status)![1]) * 1024

  return { rss: read(VM_RSS), peak: read(VM_HWM) }
}

function upstream(variant: Variant): string {
  return `${variant.site.name.replace('-', '_')}_${variant.kind}`
}

// nginx as production sets it up in front of the sites (nginx-sites): HTTP/2 over TLS, brotli and gzip at level 6, a keepalive upstream.
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

  return Bun.spawn(['nginx', '-p', NGINX, '-c', join(NGINX, 'nginx.conf'), '-e', join(NGINX, 'error.log')], { stdout: 'ignore', stderr: 'ignore' })
}

// Every variant's server and nginx in front, until `stop`.
export async function startAll(): Promise<{ servers: Map<Variant, Subprocess>, nginx: Subprocess, stop: () => void }> {
  const nginx = await startNginx()
  const servers = new Map(VARIANTS.map(variant => [variant, startServer(variant)]))

  const stop = () => {
    for (const server of servers.values())
      server.kill()
    nginx.kill()
  }

  try {
    for (const variant of VARIANTS)
      await waitReady(variant)
  }
  catch (error) {
    stop()

    throw error
  }

  return { servers, nginx, stop }
}
