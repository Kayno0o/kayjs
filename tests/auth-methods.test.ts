import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { AUTH_METHODS, authMethods } from '../src/check/auth-methods'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

const DEPRECATED = /\/\*\* @deprecated since 1\.87: `auth\.(\w+\.\w+)` \*\/\n {2,4}(?:async )?(\w+)\(/g
const MANIFEST = JSON.stringify({ dependencies: { '@kaynooo/kayjs-auth': '^1.87.0' } })

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('auth-methods-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-auth-account-methods', () => {
  it('knows every flat method kayjs-auth keeps as an alias, and the grouped method it calls', async () => {
    const flat = await Bun.file(join(import.meta.dir, '../packages/auth/src/flatMethods.ts')).text()
    const created = await Bun.file(join(import.meta.dir, '../packages/auth/src/auth.ts')).text()

    expect(Object.fromEntries([...flat.matchAll(DEPRECATED), ...created.matchAll(DEPRECATED)].map(([, grouped, name]) => [name, grouped]))).toEqual({ ...AUTH_METHODS })
  })

  it('reports a flat call on the request\'s auth, and --fix calls the grouped method', async () => {
    const page = '--- server\nexport const drop = action(s.Object({ password: s.String() }), async ({ password }, ctx) => ctx.locals.auth.deleteAccount({ password }))\n\nconst fields = await ctx.locals.auth.profile(\'fr\')\nconst log = auth.listAuditLog({ limit: 5 })\n---\np= fields\n'
    const module = 'export async function mine(ctx: never) {\n  const { auth } = ctx\n\n  return [await auth?.listIdentities(), await (ctx as any).locals?.auth.exportData()]\n}\n'
    const untouched = 'export const a = (registry: never, auth: never) => [registry.unlink(1), auth.account.delete(1), auth.user(), auth[\'unlink\'](), auth.unlink]\n// kay-allow deprecated-auth-account-methods\nexport const b = (auth: never) => auth.linkProvider(1)\n'
    const casts = 'export const c = (auth: any) => [auth!.providerToken(\'github\'), (auth as any).changeUsername(\'ada\')]\n'
    const own = 'import * as auth from \'./auth\'\n\nexport const r = () => [auth.unlink(\'x\'), auth.profile()]\n'
    const created = 'import { auth } from \'./auth\'\n\nexport const make = async () => auth.createUser({ email: \'ada@example.com\' })\n'
    const root = await project({ 'package.json': MANIFEST, 'src/routes/account.kay': page, 'src/mine.ts': module, 'src/untouched.ts': untouched, 'src/casts.ts': casts, 'src/own.ts': own, 'src/make.ts': created })

    try {
      const found = await authMethods(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.severity]).sort()).toEqual([
        ['src/casts.ts', 1, 'warning'],
        ['src/casts.ts', 1, 'warning'],
        ['src/make.ts', 3, 'warning'],
        ['src/mine.ts', 4, 'warning'],
        ['src/mine.ts', 4, 'warning'],
        ['src/routes/account.kay', 2, 'warning'],
        ['src/routes/account.kay', 4, 'warning'],
        ['src/routes/account.kay', 5, 'warning'],
      ])
      expect(found.find(diagnostic => diagnostic.line === 2)!.message).toBe('`auth.deleteAccount` is the flat name kayjs-auth had before 1.87, kept until 1.90: the method is `auth.account.delete`')

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/account.kay')).text()).toBe(page.replace('auth.deleteAccount(', 'auth.account.delete(').replace('auth.profile(', 'auth.account.profile(').replace('auth.listAuditLog(', 'auth.audit.list('))
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toBe(module.replace('auth?.listIdentities(', 'auth?.oauth.identities(').replace('auth.exportData(', 'auth.account.export('))
      expect(await Bun.file(join(root, 'src/untouched.ts')).text()).toBe(untouched)
      expect(await Bun.file(join(root, 'src/casts.ts')).text()).toBe(casts.replace('auth!.providerToken(', 'auth!.oauth.providerToken(').replace('.changeUsername(', '.account.changeUsername('))
      expect(await Bun.file(join(root, 'src/own.ts')).text()).toBe(own)
      expect(await Bun.file(join(root, 'src/make.ts')).text()).toBe(created.replace('auth.createUser(', 'auth.admin.createUser('))
      expect(await authMethods(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a project that does not depend on kayjs-auth, and one allowing the lint', async () => {
    const files = { 'src/users.ts': 'export const users = (auth: never) => auth.listIdentities()\n' }
    const without = await project({ 'package.json': JSON.stringify({ dependencies: { kay: '^1.87.0' } }), ...files })
    const allowed = await project({ 'package.json': MANIFEST, ...files })

    try {
      expect(await authMethods(without, {})).toEqual([])
      expect(await authMethods(allowed, { lints: { 'deprecated-auth-account-methods': 'allow' } })).toEqual([])
      expect(await authMethods(allowed, { lints: { deprecated: 'deny' } })).toMatchObject([{ severity: 'error' }])
    }
    finally {
      await rm(without, { recursive: true, force: true })
      await rm(allowed, { recursive: true, force: true })
    }
  })
})
