import { expect, test } from 'bun:test'
import { registerSaver, saveAll } from '../src/editor/save-all'

const A = { collection: 'posts', slug: 'a' }
const B = { collection: 'posts', slug: 'b' }
const C = { collection: 'home', slug: 'index' }

// A saver recording when its save starts and ends in `log`, held for `delay` ms, which it reports as succeeded.
function saver(name: string, log: string[], pending = true, delay = 0) {
  return {
    pending: () => pending,
    save: async () => {
      log.push(`start ${name}`)
      await Bun.sleep(delay)
      log.push(`end ${name}`)

      return true
    },
  }
}

test('Save all saves the entries in the order the page lists them, whatever order their forms registered in', async () => {
  const log: string[] = []
  const forget = [registerSaver(C, saver('c', log)), registerSaver(B, saver('b', log)), registerSaver(A, saver('a', log))]

  await saveAll([A, B, C])
  for (const each of forget) {
    each()
  }

  expect(log.filter(line => line.startsWith('start'))).toEqual(['start a', 'start b', 'start c'])
})

test('Save all waits for an entry\'s save to end before it starts the next one', async () => {
  const log: string[] = []
  const forget = [registerSaver(A, saver('a', log, true, 20)), registerSaver(B, saver('b', log, true, 5))]

  await saveAll([A, B])
  for (const each of forget) {
    each()
  }

  expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
})

test('Save all skips an entry with nothing pending and one whose form is not there', async () => {
  const log: string[] = []
  const forget = [registerSaver(A, saver('a', log, false)), registerSaver(C, saver('c', log))]

  await saveAll([A, B, C])
  for (const each of forget) {
    each()
  }

  expect(log).toEqual(['start c', 'end c'])
})

test('a form forgotten by its disposer is not saved, and a newer form of the same entry survives the older one\'s disposer', async () => {
  const log: string[] = []
  const forgetFirst = registerSaver(A, saver('first', log))
  const forgetSecond = registerSaver(A, saver('second', log))

  forgetFirst()
  await saveAll([A])
  forgetSecond()
  await saveAll([A])

  expect(log).toEqual(['start second', 'end second'])
})
