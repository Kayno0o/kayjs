import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { runBounded } from '../scripts/bounded-run'
import { scratchDir } from './scratch'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch {
    return false
  }
}

it('kills what a command started once the limit passes, not only the command', async () => {
  const file = join(await scratchDir('bounded-'), 'child.pid')

  expect(await runBounded(['sh', '-c', `sleep 60 & echo $! > ${file}; wait`], 300)).toBe(true)

  const pid = Number(await Bun.file(file).text())

  await Bun.sleep(100)
  expect(alive(pid)).toBe(false)
})

it('leaves a command that ends in time alone', async () => {
  expect(await runBounded(['true'], 5000)).toBe(false)
})
