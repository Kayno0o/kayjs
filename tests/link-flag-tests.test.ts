import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { linkFlagTests } from '../src/check/link-flag-tests'
import { scratchDir } from './scratch'

async function withFiles<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await scratchDir('link-flag-tests-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return await run(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-link-flags in the app\'s tests', () => {
  it('writes the selector that names an old flag, as the template was rewritten', async () => {
    const test = [
      'const kept = page.querySelectorAll(\'[data-keep-scroll]\')',
      'const nav = page.find("nav:not([data-no-transition]) a[data-no-prefetch]")',
      'const tpl = page.find(`[data-keep-scroll] a`)',
      '',
    ].join('\n')

    await withFiles({ 'tests/tabs.test.ts': test, 'src/routes/index.kay': 'p Hi\n' }, async (root) => {
      const found = await linkFlagTests(root, undefined)

      expect(found.map(d => [d.line, d.severity, d.fixes?.[0]?.safe])).toEqual([[1, 'warning', true], [2, 'warning', true], [2, 'warning', true], [3, 'warning', true]])
      expect(await applySafeFixes(root, found)).toBe(4)
      expect(await Bun.file(join(root, 'tests/tabs.test.ts')).text()).toBe([
        'const kept = page.querySelectorAll(\'[data-scroll=keep]\')',
        'const nav = page.find("nav:not([data-transition=false]) a[data-prefetch=false]")',
        'const tpl = page.find(`[data-scroll=keep] a`)',
        '',
      ].join('\n'))
    })
  })

  it('reports an attribute read with a fix that is not safe, as the new name holds a word where the old one was present', async () => {
    await withFiles({ 'src/nav.spec.ts': 'expect(link.getAttribute(\'data-keep-scroll\')).toBe(\'\')\nexpect(link.hasAttribute("data-no-prefetch")).toBe(true)\n' }, async (root) => {
      const found = await linkFlagTests(root, undefined)

      expect(found.map(d => d.fixes?.[0]?.safe)).toEqual([false, false])
      expect(await applySafeFixes(root, found)).toBe(0)
      expect(found.map(d => d.fixes![0]!.edits[0]!.text)).toEqual(['data-scroll', 'data-prefetch'])
    })
  })

  it('reports a selector it cannot rewrite with no fix: one with a value, one that goes on in a template', async () => {
    await withFiles({ 'tests/a.test.ts': 'page.find(\'[data-keep-scroll="false"]\')\nconst name = `data-keep-scroll-${x}`\npage.find(`[data-keep-scroll${suffix}]`)\n' }, async (root) => {
      const found = await linkFlagTests(root, undefined)

      expect(found.map(d => [d.line, d.fixes ?? []])).toEqual([[1, []], [3, []]])
    })
  })

  it('leaves comments, other attributes and files that are not tests alone', async () => {
    await withFiles({
      'tests/a.test.ts': '// the old [data-keep-scroll] selector\n/* data-no-prefetch */\npage.find(\'[data-keep-scroll-x]\')\npage.find(\'[data-scroll=keep]\')\n',
      'src/helper.ts': 'export const sel = \'[data-keep-scroll]\'\n',
      'node_modules/lib/a.test.ts': 'page.find(\'[data-keep-scroll]\')\n',
    }, async (root) => {
      expect(await linkFlagTests(root, undefined)).toEqual([])
    })
  })

  it('takes the level the config gives', async () => {
    await withFiles({ 'tests/a.test.ts': 'page.find(\'[data-keep-scroll]\')\n' }, async (root) => {
      expect((await linkFlagTests(root, { 'deprecated-link-flags': 'deny' })).map(d => d.severity)).toEqual(['error'])
      expect(await linkFlagTests(root, { deprecated: 'allow' })).toEqual([])
    })
  })
})
