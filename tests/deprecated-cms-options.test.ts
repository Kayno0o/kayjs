import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cmsOptions } from '../src/check/cms-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('cms-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-cms-options', () => {
  it('writes access for role and for a passwordGuard, and wraps an uploads list', async () => {
    const config = [
      'import { cms, passwordGuard } from \'@kayjs/cms\'',
      '',
      'export const a = cms({ role: \'editor\' })',
      'export const b = cms({ guard: passwordGuard(process.env.PASSWORD!) })',
      'export const c = cms({ guard: passwordGuard({ editor: \'x\', admin: \'y\' }, { maxAge: \'30d\' }), uploads: [\'image/*\', \'application/pdf\'] })',
      'export const d = cms({ guard: passwordGuard(\'x\', {}), pageSize: 10 })',
      '',
    ].join('\n')

    const fixed = [
      'import { cms, passwordGuard } from \'@kayjs/cms\'',
      '',
      'export const a = cms({ access: \'editor\' })',
      'export const b = cms({ access: { password: process.env.PASSWORD! } })',
      'export const c = cms({ access: { password: { editor: \'x\', admin: \'y\' }, maxAge: \'30d\' }, uploads: { types: [\'image/*\', \'application/pdf\'] } })',
      'export const d = cms({ access: { password: \'x\' }, pageSize: 10 })',
      '',
    ].join('\n')

    const root = await project({ 'kay.config.ts': config })

    try {
      const found = await cmsOptions(root, {})

      expect(found).toHaveLength(5)
      expect(found.every(one => one.code === 'deprecated-cms-options' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(fixed)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a member, a spread, an access already written and a guard of its own', async () => {
    const config = [
      'import { cms } from \'@kayjs/cms\'',
      'import { cms as other } from \'elsewhere\'',
      '',
      'export const a = cms({ guard: mine, member: ({ locals }) => locals.user })',
      'export const b = cms({ ...base, role: \'editor\' })',
      'export const c = cms({ access: \'admin\', role: \'editor\' })',
      'export const d = cms({ guard: mine })',
      'export const e = other({ role: \'editor\' })',
      'export const f = cms({ role: \'editor\', member: mine })',
      '',
    ].join('\n')

    const root = await project({ 'kay.config.ts': config })

    try {
      const found = await cmsOptions(root, {})

      expect(found.map(one => one.line)).toEqual([4, 5, 6, 9, 9])
      expect(found.some(one => one.fixes !== undefined)).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the lint out when it is allowed', async () => {
    const root = await project({ 'kay.config.ts': 'import { cms } from \'@kayjs/cms\'\nexport const a = cms({ role: \'editor\' })\n' })

    try {
      expect(await cmsOptions(root, { lints: { 'deprecated-cms-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
