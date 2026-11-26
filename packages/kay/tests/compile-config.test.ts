// Regression test for #3549: compiled binaries receive the entire runtime config minus build-only keys.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { pickRuntimeConfig } from '../src/server/index'

describe('#3549 compiled binary forwards runtime config', () => {
  test('pickRuntimeConfig strips build-only keys and forwards arbitrary runtime keys', () => {
    const picked = pickRuntimeConfig({
      routesDir: 'src/routes',
      outDir: 'dist',
      publicDir: 'public',
      port: 4000,
      lang: 'fr',
      streamTimeout: 12345,
      ...({ customFlag: 'keep-me' } as Record<string, unknown>),
    }) as Record<string, unknown>

    expect(picked.routesDir).toBeUndefined()
    expect(picked.outDir).toBeUndefined()
    expect(picked.publicDir).toBeUndefined()
    expect(picked.port).toBeUndefined()
    expect(picked.lang).toBe('fr')
    expect(picked.streamTimeout).toBe(12345)
    expect(picked.customFlag).toBe('keep-me')
  })

  test('a --compile binary receives the runtime config keys and omits build-only keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3549-'))
    const binPath = join(dir, 'server-bin')
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>hi</p> }\n')
      writeFileSync(join(dir, 'kay.config.ts'), `
export default {
  routesDir: 'src/routes',
  outDir: 'dist',
  publicDir: 'public',
  port: 4123,
  lang: 'fr',
  streamTimeout: 12345,
  plugins: [
    {
      name: 'inspect-cfg',
      server(api) {
        api.route('GET', '/__cfg', () => Response.json({
          lang: api.config?.lang,
          streamTimeout: api.config?.streamTimeout,

          hasRoutesDir: 'routesDir' in (api.config ?? {}),
          hasOutDir: 'outDir' in (api.config ?? {}),
          hasPublicDir: 'publicDir' in (api.config ?? {}),
          hasPort: 'port' in (api.config ?? {}),
        }))
      },
    },
  ],
}
`)

      await build({ root: dir, compile: binPath })

      const proc = Bun.spawn([binPath], {
        cwd: dir,
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let out = ''
        let url = ''
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const { value, done } = await reader.read()
          if (done)
            break
          out += decoder.decode(value)
          const match = /http:\/\/[^\s]+/.exec(out)
          if (match) {
            url = match[0]
            break
          }
        }
        reader.releaseLock()
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

        const res = await fetch(`${url}/__cfg`)
        expect(res.status).toBe(200)
        const cfg = await res.json() as Record<string, unknown>
        expect(cfg).toEqual({
          lang: 'fr',
          streamTimeout: 12345,
          hasRoutesDir: false,
          hasOutDir: false,
          hasPublicDir: false,
          hasPort: false,
        })
      }
      finally {
        proc.kill()
        await proc.exited
      }
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('#3633: --compile forwards the site override and runs with dist/public missing', async () => {
    await withCompiledServer('127.0.0.1', async (url, health) => {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const res = await fetch(`${url}/__site`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ site: 'https://override.example' })
      expect(health()).toBe(0)
    })
  })

  // A host with IPv6 turned off (disable_ipv6, as on the dev and CI host) cannot bind ::1 at all.
  test.skipIf(!canListenOn('::1'))('#3633: --compile brackets an IPv6 HOST in its address and its --health probe', async () => {
    await withCompiledServer('::1', async (url, health) => {
      expect(url).toMatch(/^http:\/\/\[::1\]:\d+$/)
      expect(health()).toBe(0)
    })
  })
})

function canListenOn(hostname: string): boolean {
  try {
    Bun.serve({ hostname, port: 0, fetch: () => new Response() }).stop(true)
    return true
  }
  catch {
    return false
  }
}

// Builds an app whose kay.config.ts site is overridden at build time, with copyPublic off so dist/public is missing, compiles it, starts the binary on HOST and hands over the address it prints and a --health run.
async function withCompiledServer(host: string, run: (url: string, health: () => number) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kay-3633-compile-'))
  const binPath = join(dir, 'server-bin')
  try {
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public/note.txt'), 'not copied when copyPublic is false')
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }\n')
    writeFileSync(join(dir, 'kay.config.ts'), `
export default {
  site: 'https://config.example',
  plugins: [
    {
      name: 'inspect-site',
      server(api) {
        api.route('GET', '/__site', () => Response.json({ site: api.site }))
      },
    },
  ],
}
`)
    await build({ root: dir, copyPublic: false, site: 'https://override.example/', compile: binPath })

    const proc = Bun.spawn([binPath], { cwd: dir, env: { ...process.env, PORT: '0', HOST: host }, stdout: 'pipe', stderr: 'pipe' })
    try {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let out = ''
      let url = ''
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done)
          break
        out += decoder.decode(value)
        const match = /http:\/\/\S+/.exec(out)
        if (match) {
          url = match[0]
          break
        }
      }
      reader.releaseLock()
      const port = url === '' ? '0' : new URL(url).port
      const health = () => Bun.spawnSync([binPath, '--health'], { cwd: dir, env: { ...process.env, PORT: port, HOST: host }, stdout: 'pipe', stderr: 'pipe' }).exitCode
      await run(url, health)
    }
    finally {
      proc.kill()
      await proc.exited
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
