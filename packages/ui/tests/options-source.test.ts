import { expect, test } from 'bun:test'
import { renderOnServer } from '../../../src/runtime/reactive'
import { askOptions, isRemote, loadOptions, searchOptions } from '../src/options-source'

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

test('searchOptions answers none below minLength, keeps only the latest question, and drops a stale one', async () => {
  const waiting: { q: string, resolve: (answer: number[]) => void }[] = []
  const loads: string[] = []
  const search = searchOptions<number>(() => async ({ q }) => new Promise<number[]>((resolve) => {
    waiting.push({ q, resolve })
  }), { minLength: () => 2, onLoad: (options, query) => loads.push(`${query}:${options.length}`), label: 'Test' })

  await search.load('a')
  expect(search.answered()).toBe('a')
  expect(waiting).toEqual([])

  const first = search.load('ab')
  const second = search.load('abc')

  waiting[1]!.resolve([1, 2])
  await second
  waiting[0]!.resolve([9])
  await first
  expect(search.found()).toEqual([1, 2])
  expect(search.answered()).toBe('abc')

  const dropped = search.load('abcd')

  search.stale()
  waiting[2]!.resolve([7])
  await dropped
  expect(search.answered()).toBe('abc')
  expect(loads).toEqual(['abc:2'])
})
