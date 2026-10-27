import { expect, test } from 'bun:test'
import { lockedButton } from '../src/locked-button'

test('a locked button keeps its tab stop and drops the press, the popover and the command it would run', () => {
  const locked = lockedButton({ 'id': 'go', 'disabled': true, 'onClick': () => 1, 'popovertarget': 'menu', 'popovertargetaction': 'toggle', 'command': 'show-modal', 'commandfor': 'dialog', 'type': 'submit', 'aria-label': 'Go' })

  expect(locked).toEqual({ 'id': 'go', 'aria-label': 'Go', 'type': 'button', 'aria-disabled': 'true' })
})
