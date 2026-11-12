import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OverlayOwn from '../tests/fixture/src/components/overlay-own.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

describe.each([['dialog'], ['panel']])('%s with no open', (name) => {
  test('keeps its own state: the trigger opens it and its close button closes it, with no onOpenChange', async () => {
    mounted = await mountComponent(OverlayOwn, {})

    const root = mounted.root
    const shown = () => root.querySelector<HTMLDialogElement>(`#${name}`)?.open === true

    expect(shown()).toBe(false)
    expect(root.querySelector(`#open-${name}`)?.getAttribute('aria-haspopup')).toBe('dialog')

    click(root.querySelector(`#open-${name}`))
    await settle()
    expect(shown()).toBe(true)

    click(root.querySelector(`#${name} [data-part=head] button`))
    await settle()
    expect(shown()).toBe(false)

    click(root.querySelector(`#open-${name}`))
    await settle()
    expect(shown()).toBe(true)
  })

  test('calls onOpenChange once with true then once with false', async () => {
    const heard: string[] = []

    mounted = await mountComponent(OverlayOwn, { onOpenChange: (which: string, open: boolean) => heard.push(`${which}:${open}`) })

    const root = mounted.root

    click(root.querySelector(`#open-${name}`))
    await settle()
    click(root.querySelector(`#${name} [data-part=head] button`))
    await settle()
    expect(heard).toEqual([`${name}:true`, `${name}:false`])
  })

  test('closes by Escape too, through the same close logic', async () => {
    const heard: string[] = []

    mounted = await mountComponent(OverlayOwn, { onOpenChange: (which: string, open: boolean) => heard.push(`${which}:${open}`) })

    const root = mounted.root
    const element = root.querySelector<HTMLDialogElement>(`#${name}`)!

    click(root.querySelector(`#open-${name}`))
    await settle()
    element.close()
    await settle()
    expect(element.open).toBe(false)
    expect(heard).toEqual([`${name}:true`, `${name}:false`])
  })
})
