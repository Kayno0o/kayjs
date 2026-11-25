// Regression tests for #3570: ecosystem peerDependencies/imports align with @kayjs/kay,
// shared validateSchema/validateSchemaSync helpers, MCP ActionContext.ip propagation, and external consumer resolution.

import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Glob } from 'bun'
import { mcp } from '@kayjs/mcp'
import { build } from '../src/build/index'
import { createServer, formatSchemaIssues, validateSchema, validateSchemaSync } from '../src/server/index'
import type { StandardSchemaV1 } from '../src/server/index'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

const stringSchema: StandardSchemaV1<unknown, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string' && (value as { name: string }).name.length > 0)
        return { value: { name: (value as { name: string }).name } }
      return { issues: [{ message: 'name required', path: [{ key: 'name' }] }] }
    },
  },
}

const asyncSchema: StandardSchemaV1<unknown, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      return stringSchema['~standard'].validate(value)
    },
  },
}

describe('#3570 ecosystem packaging & shared helpers', () => {
  test('all 12 ecosystem packages declare peerDependencies on @kayjs/kay and never import bare "kay"', async () => {
    const pkgPaths: string[] = []
    for await (const p of new Glob('packages/*/package.json').scan(REPO_ROOT)) {
      if (p === 'packages/kay/package.json')
        continue
      pkgPaths.push(p)
    }
    expect(pkgPaths.length).toBe(12)

    for (const rel of pkgPaths) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as {
        name: string
        peerDependencies?: Record<string, string>
      }
      expect(pkg.peerDependencies?.['@kayjs/kay']).toBeDefined()
      expect(pkg.peerDependencies?.kay).toBeUndefined()
    }

    for await (const rel of new Glob('packages/{plugin-*,ui}/src/**/*.{ts,tsx}').scan(REPO_ROOT)) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      expect(src).not.toMatch(/from\s+['"]kay(?:\/[^'"]*)?['"]/)
      expect(src).not.toMatch(/@jsxImportSource\s+kay\b/)
    }
  })

  test('external consumer without a "kay" alias resolves @kayjs/kay from ecosystem packages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-ext-consumer-'))
    try {
      const nmKayjs = join(dir, 'node_modules', '@kayjs')
      mkdirSync(nmKayjs, { recursive: true })
      // Copy packed files (package.json + src) to simulate real npm install — NO node_modules/kay alias!
      const copyPkg = (srcDir: string, dstName: string) => {
        const dst = join(nmKayjs, dstName)
        mkdirSync(dst, { recursive: true })
        cpSync(join(REPO_ROOT, srcDir, 'package.json'), join(dst, 'package.json'))
        cpSync(join(REPO_ROOT, srcDir, 'src'), join(dst, 'src'), { recursive: true })
      }
      copyPkg('packages/kay', 'kay')
      copyPkg('packages/plugin-auth', 'auth')
      copyPkg('packages/plugin-content', 'content')
      copyPkg('packages/plugin-mcp', 'mcp')
      copyPkg('packages/plugin-images', 'images')
      copyPkg('packages/plugin-seo', 'seo')
      copyPkg('packages/ui', 'ui')
      symlinkSync(join(REPO_ROOT, 'node_modules/oxc-parser'), join(dir, 'node_modules/oxc-parser'), 'dir')

      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'ext-consumer',
        type: 'module',
        private: true,
      }, null, 2))

      writeFileSync(join(dir, 'smoke.ts'), `
import { createAuth } from '@kayjs/auth'
import { defineCollection } from '@kayjs/content'
import { mcp } from '@kayjs/mcp'
import { images } from '@kayjs/images'
import { seo } from '@kayjs/seo'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/server'

const cfg = defineConfig({
  plugins: [
    createAuth({ secret: '0123456789abcdef0123456789abcdef' }).plugin,
    mcp({ token: 'tok', tools: {} }),
    images(),
    seo({ site: 'https://example.com' }),
    ui(),
  ],
})
const col = defineCollection({ dir: './content' })
if (cfg.plugins?.length !== 5 || typeof col.all !== 'function')
  throw new Error('unexpected plugin resolution')
console.log('EXT_OK')
`)

      const proc = Bun.spawnSync(['bun', 'run', 'smoke.ts'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (proc.exitCode !== 0)
        throw new Error(`external consumer failed:\n${proc.stderr.toString()}`)
      expect(proc.stdout.toString().trim()).toBe('EXT_OK')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('validateSchema, validateSchemaSync, and formatSchemaIssues are exported from kay/server', async () => {
    const syncOk = validateSchemaSync(stringSchema, { name: 'ada' })
    expect(syncOk).toEqual({ ok: true, value: { name: 'ada' } })

    const syncFail = validateSchemaSync(stringSchema, { name: '' })
    expect(syncFail.ok).toBe(false)
    if (!syncFail.ok) {
      expect(syncFail.fieldErrors).toEqual({ name: 'name required' })
      expect(formatSchemaIssues(syncFail.issues)).toBe('name: name required')
    }

    expect(() => validateSchemaSync(asyncSchema, { name: 'ada' }, 'sync only')).toThrow('sync only')

    const asyncOk = await validateSchema(asyncSchema, { name: 'ada' })
    expect(asyncOk).toEqual({ ok: true, value: { name: 'ada' } })
  })

  test('plugin-mcp passes ctx.ip into handler ActionContext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-mcp-ip-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }\n')

      let seenIp: string | undefined
      const plugin = mcp({
        token: 'secret-token',
        tools: {
          whoami: {
            description: 'Returns caller IP',
            handler(_input, ctx) {
              seenIp = ctx.ip
              return { ip: ctx.ip }
            },
          },
        },
      })

      await build({ root: dir, plugins: [plugin] })
      const app = await createServer({ root: dir, plugins: [plugin] })
      const res = await app.handle(new Request('http://localhost/mcp/tools', {
        method: 'POST',
        headers: {
          'authorization': 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }), '203.0.113.42')

      expect(res.status).toBe(200)
      const json = await res.json() as { result?: { content?: { text: string }[] } }
      expect(seenIp).toBe('203.0.113.42')
      expect(JSON.parse(json.result!.content![0]!.text)).toEqual({ ip: '203.0.113.42' })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
