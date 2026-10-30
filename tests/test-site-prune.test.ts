import { existsSync } from 'node:fs'
import { mkdir, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const DAY = 24 * 60 * 60 * 1000

describe('testSite check outputs', () => {
  it('removes the .kay/test-client folders no run used for a day and keeps recent ones and other folders', async () => {
    const root = resolve(await fixtureCopy('static'))
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
})
