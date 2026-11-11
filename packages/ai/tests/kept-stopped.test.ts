import type { AiReply } from '../src'
import { afterEach, expect, it } from 'bun:test'
import { forgetKept, keep, stopKept } from '../src/kept'

afterEach(forgetKept)

function reply(): { reply: AiReply, stopped: () => boolean } {
  let stopped = false

  return { reply: { stop: () => void (stopped = true) } as unknown as AiReply, stopped: () => stopped }
}

it('remembers at most 200 stops that came before their reply, the oldest going first', async () => {
  const owner = Promise.resolve('ann')

  for (let index = 0; index < 250; index++)
    stopKept(`early-${index}`, owner)

  const oldest = reply()
  const newest = reply()

  keep('early-0', oldest.reply, owner)
  keep('early-249', newest.reply, owner)
  await Bun.sleep(5)

  expect(oldest.stopped()).toBe(false)
  expect(newest.stopped()).toBe(true)
})
