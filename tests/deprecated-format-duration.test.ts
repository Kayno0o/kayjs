import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { formatDurationNumbers } from '../src/check/format-duration'
import { scratchDir } from './scratch'

describe('deprecated-format-duration', () => {
  it('writes a literal number of milliseconds with its unit, in a fence and in a template', async () => {
    const root = await scratchDir('format-duration-')
    const page = [
      '---',
      'import { formatDuration, formatBytes } from \'kay/i18n\'',
      'import * as i18n from \'kay/i18n\'',
      '',
      'const left = formatDuration(14 * 60_000)',
      'const kept = formatDuration(\'5m\')',
      'const variable = formatDuration(ms)',
      '---',
      'p {formatDuration(7_500_000)} {formatDuration(1 + 2 * 3, { unitDisplay: \'long\' })} {i18n.formatDuration(1500)} {formatBytes(1536)}',
      '',
    ].join('\n')

    try {
      await Bun.write(join(root, 'src/routes/page.kay'), page)
      await Bun.write(join(root, 'src/other.kay'), '---\nconst formatDuration = (n: number) => n\n---\np {formatDuration(5)}\n')

      const found = await formatDurationNumbers(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.code === 'deprecated-format-duration' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page
        .replace('14 * 60_000', '\'840000ms\'')
        .replace('7_500_000', '\'7500000ms\'')
        .replace('1 + 2 * 3', '\'7ms\'')
        .replace('1500', '\'1500ms\''))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
