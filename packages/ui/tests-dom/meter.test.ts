import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import { library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function mount(name: 'meter' | 'progress', props: Record<string, unknown>) {
  mounted = await mountComponent(await library(name), { label: 'Disk', ...props })

  return mounted.root
}

const bar = (root: Element, role: string) => root.querySelector(`[role="${role}"]`)!

test('a Meter announces 3 of 10 as 3 out of 10, not as 30', async () => {
  const meter = bar(await mount('meter', { value: 3, max: 10 }), 'meter')

  expect([meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuemin'), meter.getAttribute('aria-valuemax'), meter.getAttribute('aria-valuetext')]).toEqual(['3', '0', '10', null])
  expect(meter.querySelector('[data-part=fill]')!.getAttribute('style')).toBe('width: 30%')
})

test('a Meter holds its value between 0 and max, and a missing number at 0', async () => {
  const over = bar(await mount('meter', { value: 14, max: 10 }), 'meter')

  expect(over.getAttribute('aria-valuenow')).toBe('10')
  mounted?.unmount()

  const nan = bar(await mount('meter', { value: Number.NaN }), 'meter')

  expect([nan.getAttribute('aria-valuenow'), nan.querySelector('[data-part=fill]')!.getAttribute('style')]).toEqual(['0', 'width: 0%'])
})

test('formatValue is the meter\'s aria-valuetext and the text showValue draws', async () => {
  const root = await mount('meter', { value: 3, max: 10, formatValue: (value: number, max: number) => `${value} of ${max} GB`, showValue: true })

  expect(bar(root, 'meter').getAttribute('aria-valuetext')).toBe('3 of 10 GB')
  expect(root.querySelector('[data-part=reading]')!.textContent).toBe('3 of 10 GB')
})

test('showValue alone draws value / max, and a meter without it draws no text', async () => {
  const root = await mount('meter', { value: 3, max: 10, showValue: true })

  expect(root.querySelector('[data-part=reading]')!.textContent).toBe('3 / 10')
  expect(bar(root, 'meter').getAttribute('aria-valuetext')).toBeNull()
  mounted?.unmount()
  expect((await mount('meter', { value: 3, max: 10 })).querySelector('[data-part=reading]')).toBeNull()
})

test('a @reading block replaces the text and gets the text, the value and the max', async () => {
  const seen: unknown[][] = []
  const reading = (...args: unknown[]) => {
    seen.push(args)

    return 'custom'
  }
  const root = await mount('meter', { value: 3, max: 10, reading })

  expect(root.querySelector('[data-part=reading]')!.textContent).toBe('custom')
  expect(seen[0]).toEqual(['3 / 10', 3, 10])
})

test('thresholds colour the fill by the first step holding the value, in any order, and keep the accent past them', async () => {
  const thresholds = [{ upTo: 90, tone: 'warning' }, { upTo: 70, tone: 'success' }, { upTo: 100, tone: 'danger' }]
  const fill = async (value: number, steps: unknown = thresholds) => {
    mounted?.unmount()

    const part = (await mount('meter', { value, thresholds: steps })).querySelector('[data-part=fill]')!

    return [part.getAttribute('data-tone'), part.classList.contains('bg-accent'), part.classList.contains('bg-success'), part.classList.contains('bg-warning'), part.classList.contains('bg-danger')]
  }

  expect(await fill(40)).toEqual(['success', false, true, false, false])
  expect(await fill(70)).toEqual(['success', false, true, false, false])
  expect(await fill(71)).toEqual(['warning', false, false, true, false])
  expect(await fill(95)).toEqual(['danger', false, false, false, true])
  expect(await fill(95, [{ upTo: 70, tone: 'success' }])).toEqual([null, true, false, false, false])
})

test('class={{ fill }} still replaces a threshold\'s colour', async () => {
  const fill = (await mount('meter', { value: 40, thresholds: [{ upTo: 100, tone: 'success' }], class: { fill: 'bg-info' } })).querySelector('[data-part=fill]')!

  expect(fill.classList.contains('bg-info')).toBe(true)
})

test('size sets the height through the root', async () => {
  const sizes = []

  for (const size of ['sm', 'md', 'lg']) {
    mounted?.unmount()

    const meter = bar(await mount('meter', { value: 1, size }), 'meter')

    sizes.push([meter.getAttribute('data-size'), ['h-1', 'h-2', 'h-3'].filter(name => meter.classList.contains(name))])
  }

  expect(sizes).toEqual([['sm', ['h-1']], ['md', ['h-2']], ['lg', ['h-3']]])
})

test('a Progress takes formatValue, thresholds, size and the text too, and stays silent while indeterminate', async () => {
  const root = await mount('progress', { value: 3, max: 10, formatValue: (value: number, max: number) => `${value} of ${max} files`, showValue: true, size: 'lg', thresholds: [{ upTo: 5, tone: 'warning' }] })
  const progress = bar(root, 'progressbar')

  expect([progress.getAttribute('aria-valuenow'), progress.getAttribute('aria-valuetext'), progress.getAttribute('data-size')]).toEqual(['30', '3 of 10 files', 'lg'])
  expect(root.querySelector('[data-part=reading]')!.textContent).toBe('3 of 10 files')
  expect(root.querySelector('[data-part=fill]')!.getAttribute('data-tone')).toBe('warning')
  mounted?.unmount()

  const waiting = await mount('progress', { showValue: true, formatValue: () => 'never' })

  expect([bar(waiting, 'progressbar').getAttribute('aria-valuetext'), waiting.querySelector('[data-part=reading]')]).toEqual([null, null])
})

test('a Progress without formatValue reads its percentage', async () => {
  expect((await mount('progress', { value: 0.5, max: 1, showValue: true })).querySelector('[data-part=reading]')!.textContent).toBe('50%')
})

test('formatValue words the total of segments, and an empty list reads as a plain zero', async () => {
  const words = bar(await mount('meter', { segments: [{ value: 2, label: 'a' }, { value: 3, label: 'b' }], max: 10, formatValue: (value: number, max: number) => `${value} used of ${max}` }), 'meter')

  expect(words.getAttribute('aria-valuetext')).toBe('5 used of 10')
  mounted?.unmount()

  const empty = bar(await mount('meter', { segments: [], max: 10 }), 'meter')

  expect([empty.getAttribute('aria-valuetext'), empty.getAttribute('aria-valuenow'), empty.querySelectorAll('[data-part=fill]').length]).toEqual(['0 / 10', '0', 0])
})
