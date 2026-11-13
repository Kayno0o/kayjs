import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { keptWordFiles, recipeOnlyUtilities } from '../src/build/recipe-utilities'
import { scratchDir } from './scratch'

const lifter = { id: 1, lift: () => undefined, utilities: () => new Set(['inline-flex', 'gap-1']) }

it('forgets the words of a file the walk no longer finds', async () => {
  const root = await scratchDir('recipe-utilities-')

  try {
    await Bun.write(join(root, 'a.txt'), 'gap-1\n')
    await Bun.write(join(root, 'b.txt'), 'nothing\n')

    expect([...await recipeOnlyUtilities(root, lifter, [])]).toEqual(['inline-flex'])
    expect(keptWordFiles().filter(file => file.startsWith(root)).toSorted()).toEqual([join(root, 'a.txt'), join(root, 'b.txt')])

    await rm(join(root, 'a.txt'))

    expect([...await recipeOnlyUtilities(root, lifter, [])].toSorted()).toEqual(['gap-1', 'inline-flex'])
    expect(keptWordFiles().filter(file => file.startsWith(root))).toEqual([join(root, 'b.txt')])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
