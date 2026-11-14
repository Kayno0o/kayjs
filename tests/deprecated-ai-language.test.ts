import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { aiLanguage } from '../src/check/ai-language'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ai-language-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-ai-language', () => {
  it('renames language to locale in the options of transcribe and describeImage, in a script and a fence', async () => {
    const script = [
      'import { describeImage, transcribe } from \'@kayjs/ai\'',
      'import * as ai from \'@kayjs/ai\'',
      '',
      'const language = \'fr\'',
      'export const a = transcribe(new Blob(), { language: \'fr\' })',
      'export const b = describeImage(new Uint8Array(), { language, signal: undefined })',
      'export const c = ai.transcribe(new Blob(), { model: \'x\', language: \'pt-BR\' })',
      'export const d = transcribe(new Blob(), { locale: \'fr\' })',
      'export const e = transcribe(new Blob(), { language: \'fr\', locale: \'fr\' })',
      'export const f = transcribe(new Blob(), { ...{}, language: \'fr\' })',
      '',
    ].join('\n')

    const fixed = script
      .replace('{ language: \'fr\' })\nexport const b', '{ locale: \'fr\' })\nexport const b')
      .replace('{ language, signal', '{ locale: language, signal')
      .replace('language: \'pt-BR\'', 'locale: \'pt-BR\'')

    const page = '---\nimport { transcribe } from \'@kayjs/ai\'\n\nconst heard = transcribe(new Blob(), { language: \'en\' })\n---\np {heard}\n'
    const root = await project({ 'src/calls.ts': script, 'src/routes/page.kay': page, 'src/other.ts': 'export const x = { language: \'fr\' }\n' })
    const found = await aiLanguage(root, {})

    expect(found).toHaveLength(6)
    expect(found.every(one => one.code === 'deprecated-ai-language')).toBe(true)
    expect(found.filter(one => one.fixes?.[0]?.safe === true)).toHaveLength(4)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/calls.ts')).text()).toBe(fixed)
    expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('language: \'en\'', 'locale: \'en\''))
    expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe('export const x = { language: \'fr\' }\n')
  })

  it('reads nothing off a transcribe that is not the library\'s', async () => {
    const root = await project({ 'src/own.ts': 'import { transcribe } from \'./mine\'\nexport const a = transcribe(new Blob(), { language: \'fr\' })\n' })

    expect(await aiLanguage(root, {})).toEqual([])
  })

  it('is silent when the lint is allowed', async () => {
    const root = await project({ 'src/a.ts': 'import { transcribe } from \'@kayjs/ai\'\nexport const a = transcribe(new Blob(), { language: \'fr\' })\n' })

    expect(await aiLanguage(root, { lints: { 'deprecated-ai-language': 'allow' } })).toEqual([])
  })
})
