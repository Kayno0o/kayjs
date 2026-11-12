import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cmsTestHelpers } from '../src/check/cms-test-helpers'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('cms-test-helpers-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-cms-test-helpers', () => {
  it('rewrites the calls and the import of a test file', async () => {
    const test = 'import { cmsSignInAs, cmsSignInWith, cmsSignOut } from \'@kaynooo/kayjs-cms/test\'\nimport { testSite } from \'kay/test\'\n\nconst site = await testSite()\n\nawait cmsSignInAs(site, \'admin\')\nawait cmsSignInAs(site)\nexpect((await cmsSignInWith(site, \'x\')).status).toBe(401)\ncmsSignOut(site)\n'
    const root = await project({ 'tests/admin.test.ts': test })

    try {
      const found = await cmsTestHelpers(root, {})

      expect(found).toHaveLength(5)
      expect(found.every(one => one.code === 'deprecated-cms-test-helpers' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'tests/admin.test.ts')).text()).toBe('import { cmsTest } from \'@kaynooo/kayjs-cms/test\'\nimport { testSite } from \'kay/test\'\n\nconst site = await testSite()\n\nawait cmsTest(site).signInAs(\'admin\')\nawait cmsTest(site).signInAs()\nexpect((await cmsTest(site).signInWith(\'x\')).status).toBe(401)\ncmsTest(site).signOut()\n')
      expect(await cmsTestHelpers(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the other imports and an existing cmsTest', async () => {
    const test = 'import { cmsSignOut, cmsTest, type CmsTest } from \'@kaynooo/kayjs-cms/test\'\n\ncmsSignOut(site)\ncmsTest(site)\n'
    const root = await project({ 'tests/a.test.ts': test })

    try {
      await applySafeFixes(root, await cmsTestHelpers(root, {}))
      expect(await Bun.file(join(root, 'tests/a.test.ts')).text()).toBe('import { cmsTest, type CmsTest } from \'@kaynooo/kayjs-cms/test\'\n\ncmsTest(site).signOut()\ncmsTest(site)\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix an aliased import or a name read other than by calling it, and leaves other modules alone', async () => {
    const aliased = 'import { cmsSignInAs as signIn } from \'@kaynooo/kayjs-cms/test\'\n\nsignIn(site)\n'
    const passed = 'import { cmsSignOut } from \'@kaynooo/kayjs-cms/test\'\n\nconst out = cmsSignOut\nout(site)\ncmsSignOut(site)\n'
    const other = 'import { cmsSignInAs } from \'./mine\'\n\ncmsSignInAs(site)\n'
    const root = await project({ 'tests/aliased.test.ts': aliased, 'tests/passed.test.ts': passed, 'tests/other.test.ts': other })

    try {
      const found = await cmsTestHelpers(root, {})

      expect(found.map(one => one.file.split('/').at(-1))).toEqual(['aliased.test.ts', 'aliased.test.ts', 'passed.test.ts', 'passed.test.ts'])
      expect(found.every(one => one.fixes === undefined)).toBe(true)
      expect(await cmsTestHelpers(root, { lints: { 'deprecated-cms-test-helpers': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-cms-test-helpers edge cases', () => {
  it('drops an import left empty and leaves parenthesised arguments with no fix', async () => {
    const a = 'import { cmsTest } from \'@kaynooo/kayjs-cms/test\'\nimport { cmsSignOut } from \'@kaynooo/kayjs-cms/test\'\n\ncmsSignOut(site)\ncmsTest(site)\n'
    const b = 'import { cmsSignOut } from \'@kaynooo/kayjs-cms/test\'\n\ncmsSignOut((site))\n'
    const root = await project({ 'tests/a.test.ts': a, 'tests/b.test.ts': b })

    try {
      const found = await cmsTestHelpers(root, {})

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'tests/a.test.ts')).text()).toBe('import { cmsTest } from \'@kaynooo/kayjs-cms/test\'\n\ncmsTest(site).signOut()\ncmsTest(site)\n')
      expect(await Bun.file(join(root, 'tests/b.test.ts')).text()).toBe(b)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
