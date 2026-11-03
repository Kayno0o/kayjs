import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OldSelect from '../tests/fixture/src/components/old-select.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('onSelect still fires on a Timeline and a Table until 1.90, and is left unheard when onSelectedChange is given', async () => {
  const old: string[] = []
  const fresh: string[] = []

  mounted = await mountComponent(OldSelect, { onOld: (name: string) => old.push(name), onNew: (name: string) => fresh.push(name) })
  await settle()
  click(mounted.root.querySelector('#old button'))
  click(mounted.root.querySelector('#both button'))
  click(mounted.root.querySelector('#table tbody input[type=checkbox]'))
  await settle()

  expect(old).toEqual(['timeline:a', 'table:1'])
  expect(fresh).toEqual(['both:b'])
})
