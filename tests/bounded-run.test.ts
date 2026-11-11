import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { runBounded } from '../scripts/bounded-run'
import { scratchDir } from './scratch'

const ZOMBIE = /\) Z /

// A zombie still answers signal 0: in a container whose first process reaps nothing, as CI's, the killed child stays one, so its state in /proc counts it gone.
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }

  try {
    return !ZOMBIE.test(await Bun.file(`/proc/${pid}/stat`).text())
  }
  catch {
    return true
  }
}

it('kills what a command started once the limit passes, not only the command', async () => {
  const file = join(await scratchDir('bounded-'), 'child.pid')

  expect(await runBounded(['sh', '-c', `sleep 60 & echo $! > ${file}; wait`], 300)).toBe(true)

  const pid = Number(await Bun.file(file).text())

  await Bun.sleep(100)
  expect(await alive(pid)).toBe(false)
})

it('leaves a command that ends in time alone', async () => {
  expect(await runBounded(['true'], 5000)).toBe(false)
})
