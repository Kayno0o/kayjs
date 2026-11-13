import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { packageBytes, packageOf } from '../scripts/size-modules'
import { scratchDir } from './scratch'

describe('the package a module of a measured page belongs to', () => {
  it('tells kay\'s runtime, its libraries, icons, other packages and the app apart, as Bun names the inputs from the repo root', () => {
    expect(packageOf('src/runtime/dom.ts')).toBe('kay')
    expect(packageOf('kay-runtime:kay:runtime')).toBe('kay')
    expect(packageOf('packages/ui/src/table.kay')).toBe('kayjs-ui')
    expect(packageOf('node_modules/@kayjs/ui/src/table.kay')).toBe('kayjs-ui')
    expect(packageOf('packages/auth/src/sign-in.kay')).toBe('kayjs-auth')
    expect(packageOf('kay-icon:~icons/tabler/arrow-up')).toBe('icons')
    expect(packageOf('node_modules/@kaynooo/utils/dist/chunk-1.js')).toBe('@kaynooo/utils')
    expect(packageOf('.kay/scratch/sizes-ui-list/src/components/item-list.kay')).toBe('app')
    expect(packageOf('bench/apps/kay/components/table.kay')).toBe('app')
  })

  it('sums the bytes of the chunks a page loads by package, from the lines every build appended, and gives none when nothing was recorded', async () => {
    const file = join(await scratchDir('size-modules'), 'modules.jsonl')

    await Bun.write(file, `${JSON.stringify({ 'entry-a.js': { 'src/runtime/dom.ts': 100, 'src/runtime/unused.ts': 0 } })}\n${JSON.stringify({ 'island-b.js': { 'packages/ui/src/table.kay': 50, 'src/runtime/dom-loop.ts': 20 }, 'lazy-c.js': { 'src/runtime/swap.ts': 999 } })}\n`)

    expect(await packageBytes(file, ['/_kay/entry-a.js', '/_kay/island-b.js'])).toEqual({ 'kay': 120, 'kayjs-ui': 50 })
    expect(await packageBytes(undefined, ['/_kay/entry-a.js'])).toEqual({})
  })
})
