import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click, clock } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  clock.stop()
  mounted?.unmount()
})

async function disclosures(mode: 'new' | 'old' | 'both') {
  const calls: string[] = []

  mounted = await mountComponent('src/components/open-change.kay', { mode, calls })

  return { root: mounted.root, calls }
}

describe('Dialog and SidePanel', () => {
  test('tell onOpenChange(false) when they close', async () => {
    const { root, calls } = await disclosures('new')

    click(root.querySelector('#shut-dialog'))
    click(root.querySelector('#shut-panel'))
    await settle()

    expect(calls).toEqual(['dialog onOpenChange false', 'panel onOpenChange false'])
  })

  test('still tell the deprecated onClose, with the close event', async () => {
    const { root, calls } = await disclosures('old')

    click(root.querySelector('#shut-dialog'))
    click(root.querySelector('#shut-panel'))
    await settle()

    expect(calls).toEqual(['dialog onClose close', 'panel onClose close'])
  })

  test('hear onOpenChange alone when both are given', async () => {
    const { root, calls } = await disclosures('both')

    click(root.querySelector('#shut-dialog'))
    click(root.querySelector('#shut-panel'))
    await settle()

    expect(calls).toEqual(['dialog onOpenChange false', 'panel onOpenChange false'])
  })
})

describe('Popover', () => {
  test('tells onOpenChange(open) as it shows and hides', async () => {
    const { root, calls } = await disclosures('new')

    clock.start()
    click(root.querySelector('#show-popover'))
    await clock.settle()
    click(root.querySelector('#hide-popover'))
    await clock.settle()

    expect(calls).toEqual(['popover onOpenChange true', 'popover onOpenChange false'])
  })

  test('still tells the deprecated onToggle', async () => {
    const { root, calls } = await disclosures('old')

    clock.start()
    click(root.querySelector('#show-popover'))
    await clock.settle()

    expect(calls).toEqual(['popover onToggle true'])
  })

  test('hears onOpenChange alone when both are given', async () => {
    const { root, calls } = await disclosures('both')

    clock.start()
    click(root.querySelector('#show-popover'))
    await clock.settle()

    expect(calls).toEqual(['popover onOpenChange true'])
  })
})

describe('CollapsibleSection', () => {
  test('tells onOpenChange(open) when folded and unfolded, and says nothing for the state it started in', async () => {
    const { root, calls } = await disclosures('new')
    const section = root.querySelector<HTMLDetailsElement>('#section')!

    await settle()

    expect(calls.filter(call => call.startsWith('section'))).toEqual([])

    section.open = false
    section.dispatchEvent(new Event('toggle'))
    await settle()

    section.open = true
    section.dispatchEvent(new Event('toggle'))
    await settle()

    expect(calls.filter(call => call.startsWith('section'))).toEqual(['section onOpenChange false', 'section onOpenChange true'])
  })
})
