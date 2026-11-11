import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { scheduleTz } from '../src/check/schedule-tz'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('schedule-tz-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-schedule-tz', () => {
  it('renames tz in the options of schedule(), a shorthand included, in a script and a fence', async () => {
    const script = 'import { schedule } from \'kay/server\'\nimport * as kay from \'kay\'\n\nconst tz = \'UTC\'\n\nexport const a = schedule(\'@daily\', () => undefined, { tz: \'Europe/Paris\', lock: \'a\' })\nexport const b = schedule({ \'@daily\': () => undefined }, { tz })\nexport const c = kay.schedule(\'@daily\', () => undefined, { lock: \'c\', tz: \'Asia/Tokyo\' })\nexport const d = schedule(\'@daily\', () => undefined, { timeZone: \'UTC\' })\n'
    const page = '---\nimport { schedule } from \'kay/server\'\n\nexport default schedule(\'@daily\', () => undefined, { tz: \'UTC\' })\n---\np hi\n'
    const root = await project({ 'src/jobs.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await scheduleTz(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.code === 'deprecated-schedule-tz' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/jobs.ts')).text()).toBe(script.replace('{ tz: \'Europe/Paris\'', '{ timeZone: \'Europe/Paris\'').replace('{ tz })', '{ timeZone: tz })').replace('lock: \'c\', tz:', 'lock: \'c\', timeZone:'))
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('{ tz:', '{ timeZone:'))
      expect(await scheduleTz(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a tz beside a timeZone with no fix, and leaves other calls and other schedule functions alone', async () => {
    const script = 'import { schedule } from \'kay/server\'\nimport { schedule as other } from \'./mine\'\n\nschedule(\'@daily\', () => undefined, { tz: \'UTC\', timeZone: \'UTC\' })\nother(\'@daily\', () => undefined, { tz: \'UTC\' })\nfoo({ tz: \'UTC\' })\n'
    const root = await project({ 'src/jobs.ts': script })

    try {
      const found = await scheduleTz(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await scheduleTz(root, { lints: { 'deprecated-schedule-tz': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
