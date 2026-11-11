import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { filterOptions } from '../src/check/filter-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('filter-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-filter-options', () => {
  it('renames hide in the form layout of every collection of cms(), a shorthand included', async () => {
    const config = 'import { cms } from \'@kaynooo/kayjs-cms\'\n\nconst hide = [\'sku\']\n\nexport default { extensions: [cms({ collections: {\n  products: { form: { fields: [\'name\'], hide: [\'sku\'] } },\n  posts: { form: { \'hide\': [\'seo\'] }, list: { columns: [\'title\'] } },\n  pages: { form: { hide } },\n} })] }\n'
    const root = await project({ 'kay.config.ts': config })

    try {
      const found = await filterOptions(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(one => one.code === 'deprecated-filter-options' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config
        .replace('hide: [\'sku\'] } }', 'exclude: [\'sku\'] } }')
        .replace('\'hide\': [', 'exclude: [')
        .replace('form: { hide } }', 'form: { exclude: hide } }'))
      expect(await filterOptions(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a form beside its exclude with no fix, and leaves other calls and other hide keys alone', async () => {
    const script = 'import { cms } from \'@kaynooo/kayjs-cms\'\nimport { cms as other } from \'./mine\'\n\ncms({ collections: { a: { form: { hide: [\'x\'], exclude: [\'y\'] } } } })\nother({ collections: { a: { form: { hide: [\'x\'] } } } })\ncms({ collections: { a: { list: { hide: [\'x\'] } } }, hide: [\'x\'] })\ncms({ collections: { a: { form: { exclude: [\'x\'] } } } })\n'
    const root = await project({ 'src/setup.ts': script })

    try {
      const found = await filterOptions(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]?.fixes ?? []).toEqual([])
      expect(await filterOptions(root, { lints: { 'deprecated-filter-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
