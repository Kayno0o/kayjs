import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { pruneTestOutputs } from '../src/test/outputs'
import { fixtureCopy } from './scratch'

const DAY = 24 * 60 * 60 * 1000

describe('testSite check outputs', () => {
  // A process serves one project, so the tests of this file share one root.
  let shared: string | undefined
  const sharedRoot = async () => shared ??= resolve(await fixtureCopy('static'))

  it('removes the .kay/test-client folders no run used for a day and keeps recent ones and other folders', async () => {
    const root = await sharedRoot()
    const folder = async (name: string, age: number) => {
      const path = join(root, '.kay', name)
      const when = new Date(Date.now() - age)

      await mkdir(path, { recursive: true })
      await utimes(path, when, when)

      return path
    }
    const stale = await folder('test-client.old1', 2 * DAY)
    const staleWorker = await folder('test-client-3.old2', 2 * DAY)
    const recent = await folder('test-client.new1', DAY / 2)
    const other = await folder('client', 5 * DAY)
    const site = await testSite({ root })

    await site.close()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(staleWorker)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('touches the folder of a build that stays cached, so another process\'s prune keeps it', async () => {
    const root = await sharedRoot()
    const first = await testSite({ root })
    const dir = join(root, '.kay')
    const [output] = readdirSync(dir).filter(name => name.startsWith('test-client')).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    const old = new Date(Date.now() - 2 * DAY)

    await first.close()
    await utimes(join(dir, output!), old, old)

    // The same process asks again with the build cached: the hit touches the folder.
    const second = await testSite({ root })

    await second.close()

    expect(Date.now() - statSync(join(dir, output!)).mtimeMs).toBeLessThan(DAY / 2)

    pruneTestOutputs(root, 'test-client.other', true)

    expect(existsSync(join(dir, output!))).toBe(true)
  })
})
