import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { AUTH_METHODS, authMethods } from '../src/check/auth-methods'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

const DEPRECATED = /\/\*\* @deprecated since 1\.82: `auth\.(\w+\.\w+)` \*\/\n {2}(?:async )?(\w+)\(/g
const MANIFEST = JSON.stringify({ dependencies: { '@kaynooo/kayjs-auth': '^1.82.0' } })

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('auth-methods-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-auth-methods', () => {
  it('knows every flat method kayjs-auth keeps as an alias, and the grouped method it calls', async () => {
    const source = await Bun.file(join(import.meta.dir, '../packages/auth/src/flatMethods.ts')).text()

    expect(Object.fromEntries([...source.matchAll(DEPRECATED)].map(([, grouped, flat]) => [flat, grouped]))).toEqual({ ...AUTH_METHODS })
  })

  it('reports a flat call on the request\'s auth, and --fix calls the grouped method', async () => {
    const page = '--- server\nexport const ban = action(s.Object({ id: s.String() }), async ({ id }, ctx) => ctx.locals.auth.banUser(id, { reason: \'Spam\' }))\n\nconst users = await ctx.locals.auth.listUsers({ limit: 20 })\nconst roles = auth.adminRoles()\n---\np= users.total\n'
    const module = 'export async function mine(ctx: never) {\n  const { auth } = ctx\n\n  return [await auth?.listSessions(), await (ctx as any).locals?.auth.listOrganizations()]\n}\n'
    const untouched = 'export const a = (registry: never, auth: never) => [registry.register(1), auth.admin.listUsers(), auth.user(), auth[\'listUsers\'](), auth.listUsers]\n// kay-allow deprecated-auth-methods\nexport const b = (auth: never) => auth.invite(1)\n'
    const root = await project({ 'package.json': MANIFEST, 'src/routes/admin.kay': page, 'src/mine.ts': module, 'src/untouched.ts': untouched })

    try {
      const found = await authMethods(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.severity]).sort()).toEqual([
        ['src/mine.ts', 4, 'warning'],
        ['src/mine.ts', 4, 'warning'],
        ['src/routes/admin.kay', 2, 'warning'],
        ['src/routes/admin.kay', 4, 'warning'],
        ['src/routes/admin.kay', 5, 'warning'],
      ])
      expect(found.find(diagnostic => diagnostic.line === 2)!.message).toBe('`auth.banUser` is the flat name kayjs-auth had before 1.82, kept until 1.85: the method is `auth.admin.ban`')

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/admin.kay')).text()).toBe(page.replace('auth.banUser(', 'auth.admin.ban(').replace('auth.listUsers(', 'auth.admin.listUsers(').replace('auth.adminRoles(', 'auth.admin.roles('))
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toBe(module.replace('auth?.listSessions(', 'auth?.sessions.list(').replace('auth.listOrganizations(', 'auth.organizations.list('))
      expect(await Bun.file(join(root, 'src/untouched.ts')).text()).toBe(untouched)
      expect(await authMethods(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a project that does not depend on kayjs-auth, and one allowing the lint', async () => {
    const files = { 'src/users.ts': 'export const users = (auth: never) => auth.listUsers()\n' }
    const without = await project({ 'package.json': JSON.stringify({ dependencies: { kay: '^1.82.0' } }), ...files })
    const allowed = await project({ 'package.json': MANIFEST, ...files })

    try {
      expect(await authMethods(without, {})).toEqual([])
      expect(await authMethods(allowed, { lints: { 'deprecated-auth-methods': 'allow' } })).toEqual([])
      expect(await authMethods(allowed, { lints: { deprecated: 'deny' } })).toMatchObject([{ severity: 'error' }])
    }
    finally {
      await rm(without, { recursive: true, force: true })
      await rm(allowed, { recursive: true, force: true })
    }
  })
})
