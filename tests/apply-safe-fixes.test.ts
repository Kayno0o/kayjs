import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { scratchDir } from './scratch'

const problem = (file: string, edit: { start: number, end: number, text: string }) => ({ file, line: 1, column: 1, end: 1, severity: 'error' as const, code: 'x', message: 'x', fixes: [{ title: 'x', safe: true, edits: [edit] }] })

it('applies an insertion and a replacement at one start in a fixed order, whichever fix comes first', async () => {
  const root = await scratchDir('apply-fixes-')
  const file = join(root, 'a.ts')

  try {
    for (const order of [[0, 1], [1, 0]]) {
      await Bun.write(file, 'abcdef')

      const fixes = [problem(file, { start: 2, end: 2, text: 'X' }), problem(file, { start: 2, end: 4, text: 'Z' })]

      expect(await applySafeFixes(root, order.map(index => fixes[index]!))).toBe(2)
      expect(await Bun.file(file).text()).toBe('abXZef')
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
