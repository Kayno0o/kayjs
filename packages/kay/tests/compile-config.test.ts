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

  test('a --compile binary receives a newly added config key and omits build-only keys', async () => {
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
  customRuntimeKey: 'forwarded-to-binary',
  plugins: [
    {
      name: 'inspect-cfg',
      server(api) {
        api.route('GET', '/__cfg', () => Response.json({
          lang: api.config?.lang,
          streamTimeout: api.config?.streamTimeout,
          customRuntimeKey: api.config?.customRuntimeKey,
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
          customRuntimeKey: 'forwarded-to-binary',
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
})
