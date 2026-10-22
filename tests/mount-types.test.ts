import { expect, it } from 'bun:test'
import { mountComponent } from '../src/test'

declare function Toggle(props: { label: string, open?: boolean }): unknown
declare function Plain(props: Record<never, never>): unknown

it('types the props of the component mountComponent takes, required when it has a required one', () => {
  const mounts = async () => {
    await mountComponent(Toggle, { label: 'Menu' })
    await mountComponent(Plain)
    await mountComponent('src/components/toggle.kay', { anything: 1 })

    // @ts-expect-error a required prop is missing
    await mountComponent(Toggle, {})

    // @ts-expect-error the props are required
    await mountComponent(Toggle)

    // @ts-expect-error a prop of the wrong type
    await mountComponent(Toggle, { label: 1 })
  }

  expect(mounts).toBeFunction()
})
