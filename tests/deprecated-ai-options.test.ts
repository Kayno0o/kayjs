import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { aiOptions } from '../src/check/ai-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ai-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-ai-options', () => {
  it('renames reasoning and confirm in the options of ask(), shorthands included', async () => {
    const script = 'import { ask } from \'@kaynooo/kayjs-ai\'\nimport * as ai from \'@kaynooo/kayjs-ai\'\n\nconst reasoning = \'low\'\nconst confirm = () => true\n\nask(\'a\', { reasoning: \'high\', confirm: false })\nai.ask(\'b\', { reasoning, confirm })\nask([], { system: \'s\', tools: [], reasoning: \'none\' })\n'
    const page = '---\nimport { ask } from \'@kaynooo/kayjs-ai\'\n\nexport const reply = ask(\'c\', { confirm: () => false })\n---\np hi\n'
    const root = await project({ 'src/ask.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await aiOptions(root, {})

      expect(found).toHaveLength(6)
      expect(found.every(one => one.code === 'deprecated-ai-options')).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/ask.ts')).text()).toContain('ask(\'a\', { effort: \'high\', approval: false })')
      expect(await Bun.file(join(root, 'src/ask.ts')).text()).toContain('ai.ask(\'b\', { effort: reasoning, approval: confirm })')
      expect(await Bun.file(join(root, 'src/ask.ts')).text()).toContain('tools: [], effort: \'none\' })')
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('confirm:', 'approval:'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key beside its new name with no fix, and leaves other functions and other arguments alone', async () => {
    const script = 'import { ask } from \'@kaynooo/kayjs-ai\'\nimport { ask as mine } from \'./mine\'\n\nask(\'a\', { reasoning: \'low\', effort: \'high\' })\nmine(\'b\', { reasoning: \'low\' })\nask({ reasoning: \'low\' })\nask(\'c\', { effort: \'low\', approval: false })\n'
    const root = await project({ 'src/ask.ts': script })

    try {
      const found = await aiOptions(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await aiOptions(root, { lints: { 'deprecated-ai-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
