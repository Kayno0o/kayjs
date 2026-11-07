import { expect, test } from 'bun:test'
import { renderOnServer } from '../../../src/runtime/reactive'
import { askOptions, isRemote, loadOptions } from '../src/options-source'

test('a list is drawn as is, a function or a promise has to be asked', async () => {
  expect(isRemote([1])).toBe(false)
  expect(isRemote(Promise.resolve([1]))).toBe(true)
  expect(isRemote(() => [1])).toBe(true)
  expect(askOptions([1], 'x')).toEqual([1])
  expect(await askOptions(({ q }) => [q.length], 'abc')).toEqual([3])
})

test('a function that throws answers with a rejection', async () => {
  const answer = askOptions(() => {
    throw new Error('down')
  }, '')

  await expect(Promise.resolve(answer)).rejects.toThrow('down')
})

test('on the server a list is drawn and a function is never called', () => {
  let calls = 0
  const seen = renderOnServer(() => {
    const list = loadOptions(() => [1, 2], { label: 'Test' })
    const asked = loadOptions(() => () => {
      calls++

      return [1]
    }, { label: 'Test' })

    return { list: list.options(), listLoading: list.loading(), asked: asked.options(), askedLoading: asked.loading() }
  })

  expect(seen).toEqual({ list: [1, 2], listLoading: false, asked: [], askedLoading: true })
  expect(calls).toBe(0)
})
