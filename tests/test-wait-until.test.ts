import { describe, expect, it } from 'bun:test'
import { waitUntil } from '../src/test'

describe('waitUntil', () => {
  it('resolves with the first truthy value of a sync or async condition', async () => {
    let calls = 0

    expect(await waitUntil(() => ++calls >= 3 && 'done')).toBe('done')
    expect(await waitUntil(async () => ({ ready: true }))).toEqual({ ready: true })
  })

  it('fails naming what it waited for and the last value seen', async () => {
    await expect(waitUntil(() => 0, { timeout: '50ms', what: 'the title' })).rejects.toThrow('waited 50ms for the title; the last value was 0')
    await expect(waitUntil(() => undefined, { timeout: '20ms' })).rejects.toThrow('the condition to hold; the last value was undefined')
  })
})
