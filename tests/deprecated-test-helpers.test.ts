import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { testHelpers } from '../src/check/test-helpers'
import { scratchDir } from './scratch'

async function fixed(source: string, options = {}): Promise<{ text: string, codes: (string | undefined)[] }> {
  const root = await scratchDir('test-helpers-')

  try {
    await Bun.write(join(root, 'tests/a.test.ts'), source)

    const found = await testHelpers(root, options)

    await applySafeFixes(root, found)

    return { text: await Bun.file(join(root, 'tests/a.test.ts')).text(), codes: found.map(one => one.code) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-test-helpers', () => {
  it('keeps the local name of each library helper it renames', async () => {
    const source = 'import { aiTest } from \'@kayjs/ai/test\'\nimport { authTest as auth } from \'@kayjs/auth/test\'\nimport { cmsTest, signIn } from \'@kayjs/cms/test\'\nimport { mailTest } from \'@kayjs/mail/test\'\n\nexport const all = [aiTest, auth, cmsTest, mailTest, signIn]\n'

    expect((await fixed(source)).text).toBe('import { test as aiTest } from \'@kayjs/ai/test\'\nimport { test as auth } from \'@kayjs/auth/test\'\nimport { test as cmsTest, signIn } from \'@kayjs/cms/test\'\nimport { test as mailTest } from \'@kayjs/mail/test\'\n\nexport const all = [aiTest, auth, cmsTest, mailTest, signIn]\n')
  })

  it('renames the two methods on a test site and on its `as()` views, and no other receiver', async () => {
    const source = 'import { testSite } from \'kay/test\'\n\nconst site = await testSite()\nconst admin = site.as(\'cookie\')\nconst other = { refusal: () => 1, socketRefusal: () => 2 }\n\nawait site.refusal(action, {})\nawait admin.refusal(action, {})\nawait site.socketRefusal(api, \'/ws\')\nother.refusal()\n'

    expect((await fixed(source)).text).toBe('import { testSite } from \'kay/test\'\n\nconst site = await testSite()\nconst admin = site.as(\'cookie\')\nconst other = { refusal: () => 1, socketRefusal: () => 2 }\n\nawait site.expectRefused(action, {})\nawait admin.expectRefused(action, {})\nawait site.socket.refused(api, \'/ws\')\nother.refusal()\n')
  })

  it('leaves a file that does not import testSite from kay/test alone', async () => {
    expect((await fixed('const site = await testSite()\nawait site.refusal(action, {})\n')).codes).toEqual([])
  })

  it('reports nothing for the new names or when allowed', async () => {
    expect((await fixed('import { test } from \'@kayjs/mail/test\'\nimport { testSite } from \'kay/test\'\n\nconst site = await testSite()\ntest(site)\nawait site.expectRefused(action, {})\n')).codes).toEqual([])
    expect((await fixed('import { mailTest } from \'@kayjs/mail/test\'\n', { lints: { 'deprecated-test-helpers': 'allow' } })).codes).toEqual([])
  })
})
