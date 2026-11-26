// Tests for `kay inspect [dir] [--json]` (#3610): fast static inspection without bundling.

import type { InspectReport } from '../src/cli/inspect'
import { describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatInspectReport, inspectProject } from '../src/cli/inspect'

const PACKAGES_DIR = resolve(import.meta.dir, '../..')
const KAY_PKG_DIR = resolve(import.meta.dir, '..')
const TEMPLATES_DIR = resolve(KAY_PKG_DIR, 'templates')
const CLI = resolve(import.meta.dir, '../src/cli/index.ts')

async function kay(args: string[], cwd = process.cwd(), extraEnv?: Record<string, string>): Promise<{ code: number, out: string, err: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

function linkWorkspacePackages(appDir: string): void {
  mkdirSync(join(appDir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(appDir, 'node_modules/@kayjs/kay'), 'dir')
  symlinkSync(join(PACKAGES_DIR, 'ui'), join(appDir, 'node_modules/@kayjs/ui'), 'dir')
  symlinkSync(join(PACKAGES_DIR, 'plugin-auth'), join(appDir, 'node_modules/@kayjs/auth'), 'dir')
}

describe('#3610 kay inspect [dir] [--json]', () => {
  test('kay inspect --json on fullstack template lists routes, islands with reason, actions, and plugins without bundling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-inspect-fullstack-'))
    try {
      cpSync(join(TEMPLATES_DIR, 'fullstack'), dir, { recursive: true })
      linkWorkspacePackages(dir)

      const res = await kay(['inspect', '--json'], dir)
      expect(res.code).toBe(0)
      expect(existsSync(join(dir, 'dist'))).toBe(false)

      const report = JSON.parse(res.out) as InspectReport
      expect(report.routes).toEqual([
        {
          path: '/api/health',
          file: 'src/routes/api/health.ts',
          methods: ['GET'],
          layouts: [],
          middlewares: [],
          load: false,
          prerender: false,
        },
        {
          path: '/',
          file: 'src/routes/index.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: [],
          load: false,
          prerender: false,
        },
      ])

      expect(report.islands).toEqual([
        {
          exportName: 'Counter',
          file: 'src/components/Counter.tsx',
          reason: expect.stringMatching(/uses (signal|onClick)/),
          hydrate: 'load',
        },
        {
          exportName: 'GreetForm',
          file: 'src/components/GreetForm.tsx',
          reason: expect.stringMatching(/uses (signal|onSubmit|onInput)/),
          hydrate: 'load',
        },
      ])

      expect(report.actions).toEqual([
        {
          exportName: 'greet',
          file: 'src/actions/greet.ts',
          url: expect.stringMatching(/^\/_kay\/action\/greet-[a-z0-9]+$/),
          middlewares: [],
        },
      ])

      expect(report.plugins).toEqual([])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('kay inspect --json on app template lists routes, middleware, plugin routes, and resolved plugins without bundling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-inspect-app-'))
    try {
      cpSync(join(TEMPLATES_DIR, 'app'), dir, { recursive: true })
      linkWorkspacePackages(dir)

      const res = await kay(['inspect', dir, '--json'], process.cwd(), { AUTH_DB: ':memory:' })
      expect(res.code).toBe(0)
      expect(existsSync(join(dir, 'dist'))).toBe(false)

      const report = JSON.parse(res.out) as InspectReport

      const fileRoutes = report.routes.filter(r => r.file !== undefined)
      expect(fileRoutes).toEqual([
        {
          path: '/dashboard',
          file: 'src/routes/dashboard/index.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: ['src/routes/dashboard/_middleware.ts'],
          load: false,
          prerender: false,
        },
        {
          path: '/',
          file: 'src/routes/index.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: [],
          load: false,
          prerender: false,
        },
        {
          path: '/login',
          file: 'src/routes/login.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: [],
          load: false,
          prerender: false,
        },
      ])

      const authRoutes = report.routes.filter(r => r.plugin === '@kayjs/auth')
      expect(authRoutes.map(r => r.path)).toContain('/auth/signin')
      expect(authRoutes.map(r => r.path)).toContain('/auth/signup')
      expect(authRoutes.map(r => r.path)).toContain('/auth/session')
      expect(authRoutes.find(r => r.path === '/auth/signin')?.methods).toContain('POST')

      expect(report.islands).toEqual([
        {
          exportName: 'Toaster',
          file: expect.stringMatching(/Toaster\.tsx$/),
          reason: 'uses onClick',
          hydrate: 'load',
        },
      ])
      expect(report.actions).toEqual([])

      // Resolved order places `@kayjs/auth` (`enforce: 'pre'`) before `@kayjs/ui` even though `kay.config.ts` lists `ui` first.
      expect(report.plugins).toEqual([
        {
          name: '@kayjs/auth',
          enforce: 'pre',
          providesLocals: ['user', 'session'],
          readsLocals: [],
          commands: [],
        },
        {
          name: '@kayjs/ui',
          providesLocals: [],
          readsLocals: [],
          commands: ['ui-eject'],
        },
      ])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports load, prerender, hydrate modes, state-promoted islands, guarded actions, plugin ordering, and human-readable output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-inspect-rich-'))
    try {
      mkdirSync(join(dir, 'src/routes/admin'), { recursive: true })
      mkdirSync(join(dir, 'src/stores'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      linkWorkspacePackages(dir)

      writeFileSync(join(dir, 'src/stores/count.ts'), 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n')
      writeFileSync(join(dir, 'src/components/Widgets.tsx'), [
        'import { count } from \'../stores/count\'',
        'export const hydrate = \'visible\'',
        'export function Total() { return <output>{count.value}</output> }',
        'export function StaticBadge() { return <span>ok</span> }',
      ].join('\n'))
      writeFileSync(join(dir, 'src/routes/_layout.tsx'), 'export default function Layout({ children }: { children: unknown }) { return <main>{children}</main> }\n')
      writeFileSync(join(dir, 'src/routes/index.tsx'), [
        'import { Total, StaticBadge } from \'../components/Widgets\'',
        'export const prerender = true',
        'export async function load() { return { title: \'Home\' } }',
        'export default function Home() { return <section><Total /><StaticBadge /></section> }',
      ].join('\n'))
      writeFileSync(join(dir, 'src/routes/admin/_middleware.ts'), 'export default async function guard(_ctx: unknown, next: () => Promise<Response>) { return next() }\n')
      writeFileSync(join(dir, 'src/routes/admin/actions.ts'), [
        'import { action } from \'@kayjs/kay/server\'',
        'export const purge = action(async () => ({ ok: true }))',
      ].join('\n'))
      writeFileSync(join(dir, 'src/routes/admin/index.tsx'), [
        'import { purge } from \'./actions\'',
        'export default function Admin() { return <form action={purge} method="post"><button type="submit">Purge</button></form> }',
      ].join('\n'))
      writeFileSync(join(dir, 'kay.config.ts'), `
export default {
  plugins: [
    {
      name: 'consumer',
      after: ['provider'],
      readsLocals: ['tenant'],
      commands: { 'sync-all': () => {} },
      server(api: { route: (m: string, p: string, h: () => Response) => void }) {
        api.route('GET', '/_plugin/status', () => new Response('ok'))
        api.route('POST', '/_plugin/status', () => new Response('ok'))
      },
    },
    {
      name: 'provider',
      enforce: 'pre',
      providesLocals: ['tenant'],
    },
  ],
}
`)

      const report = await inspectProject(dir)
      expect(existsSync(join(dir, 'dist'))).toBe(false)

      expect(report.routes).toEqual([
        {
          path: '/admin',
          file: 'src/routes/admin/index.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: ['src/routes/admin/_middleware.ts'],
          load: false,
          prerender: false,
        },
        {
          path: '/',
          file: 'src/routes/index.tsx',
          layouts: ['src/routes/_layout.tsx'],
          middlewares: [],
          load: true,
          prerender: true,
        },
        {
          path: '/_plugin/status',
          plugin: 'consumer',
          methods: ['GET', 'POST'],
          layouts: [],
          middlewares: [],
          load: false,
          prerender: false,
        },
      ])

      expect(report.islands).toEqual([
        {
          exportName: 'Total',
          file: 'src/components/Widgets.tsx',
          reason: 'reads count from \'../stores/count\'',
          hydrate: 'visible',
        },
      ])

      expect(report.actions).toEqual([
        {
          exportName: 'purge',
          file: 'src/routes/admin/actions.ts',
          url: expect.stringMatching(/^\/_kay\/action\/purge-[a-z0-9]+$/),
          middlewares: ['src/routes/admin/_middleware.ts'],
        },
      ])

      // Resolved order places `provider` (enforce: 'pre') before `consumer` (after: ['provider']).
      expect(report.plugins).toEqual([
        {
          name: 'provider',
          enforce: 'pre',
          providesLocals: ['tenant'],
          readsLocals: [],
          commands: [],
        },
        {
          name: 'consumer',
          providesLocals: [],
          readsLocals: ['tenant'],
          commands: ['sync-all'],
        },
      ])

      const text = formatInspectReport(report)
      expect(text).toContain('Routes (3):')
      expect(text).toContain('/  src/routes/index.tsx  load  prerender')
      expect(text).toContain('/_plugin/status  GET,POST  (plugin: consumer)')
      expect(text).toContain('Islands (1):')
      expect(text).toContain('Total  src/components/Widgets.tsx  hydrate=visible  reads count from \'../stores/count\'')
      expect(text).toContain('Actions (1):')
      expect(text).toContain('purge  src/routes/admin/actions.ts')
      expect(text).toContain('middlewares=[src/routes/admin/_middleware.ts]')
      expect(text).toContain('Plugins (2):')
      expect(text).toContain('1. provider  enforce=pre  providesLocals=[tenant]')
      expect(text).toContain('2. consumer  readsLocals=[tenant]  commands=[sync-all]')

      const cliText = await kay(['inspect'], dir)
      expect(cliText.code).toBe(0)
      expect(cliText.out.trim()).toBe(text)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('kay inspect --help works and a broken kay.config.ts exits 1 without a stack trace', async () => {
    const help = await kay(['inspect', '--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('--json')
    expect(help.out).toContain('Exit codes:')

    const dir = mkdtempSync(join(tmpdir(), 'kay-inspect-badcfg-'))
    try {
      writeFileSync(join(dir, 'kay.config.ts'), 'export default { plugins: [ }\n')
      const res = await kay(['inspect', dir])
      expect(res.code).toBe(1)
      expect(res.err).toContain('kay.config.ts')
      expect(res.err).not.toMatch(/^\s+at /m)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
