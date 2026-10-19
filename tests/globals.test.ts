import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { bunGlobalNames } from '../src/compiler/globals'
import { scratchDir } from './scratch'

function alive(pid: number) {
  try {
    process.kill(pid, 0)

    return true
  }
  catch {
    return false
  }
}

test('Bun globals are listed by a child', () => {
  expect(bunGlobalNames().has('Bun')).toBe(true)
})

test('a globals child that never ends is killed at the timeout', async () => {
  const pidFile = join(await scratchDir('globals'), 'child-pid')
  const started = performance.now()

  expect(() => bunGlobalNames([process.execPath, '-e', `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); while (true);`], 700)).toThrow()
  expect(performance.now() - started).toBeLessThan(5000)

  const pid = Number(readFileSync(pidFile, 'utf8'))

  rmSync(pidFile)
  expect(alive(pid)).toBe(false)
})
