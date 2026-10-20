import type { JSX } from '../src/runtime/jsx'
import { expect, it } from 'bun:test'

type ButtonAttributes = JSX.IntrinsicElements['button']

it('types a button\'s invoker attributes: the HTML commands and any --custom one', () => {
  const dialog: ButtonAttributes = { commandfor: 'settings', command: 'show-modal' }
  const popover: ButtonAttributes = { commandfor: 'menu', command: 'toggle-popover' }
  const custom: ButtonAttributes = { commandfor: 'photo', command: '--rotate-left' }

  // @ts-expect-error a command is an HTML keyword or starts with two hyphens
  const unknown: ButtonAttributes = { commandfor: 'menu', command: 'open' }

  expect([dialog, popover, custom, unknown]).toHaveLength(4)
})
