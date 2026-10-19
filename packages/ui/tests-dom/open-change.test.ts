import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click, clock } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  clock.stop()
  mounted?.unmount()
})

async function disclosures() {
  const calls: string[] = []

  mounted = await mountComponent('src/components/open-change.kay', { calls })

  return { root: mounted.root, calls }
}

describe('Dialog and SidePanel', () => {
  test('tell onOpenChange(false) when they close', async () => {
    const { root, calls } = await disclosures()

    click(root.querySelector('#shut-dialog'))
    click(root.querySelector('#shut-panel'))
    await settle()

    expect(calls).toEqual(['dialog onOpenChange false', 'panel onOpenChange false'])
  })
})

describe('Popover', () => {
  test('tells onOpenChange(open) as it shows and hides', async () => {
    const { root, calls } = await disclosures()

    clock.start()
    click(root.querySelector('#show-popover'))
    await clock.settle()
    click(root.querySelector('#hide-popover'))
    await clock.settle()

    expect(calls).toEqual(['popover onOpenChange true', 'popover onOpenChange false'])
  })
})
