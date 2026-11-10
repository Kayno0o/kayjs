import { expect, test } from 'bun:test'
import fr from '../src/messages/fr'
import { closeWatcher, followsHref, renderedOpen } from '../src/overlay'

test('autosave leaves typing out of the guard, and dirty and a docked panel still lock it', () => {
  expect([
    closeWatcher({ modal: true, dirty: false, edited: true, autosave: true, footer: true }),
    closeWatcher({ modal: true, dirty: true, edited: true, autosave: true, footer: false }),
    closeWatcher({ modal: true, docked: true, dirty: false, edited: true, autosave: true, footer: false }),
  ]).toEqual(['any', 'none', 'none'])
})

test.each([
  // modal, docked, dirty, edited, footer, closedby
  [true, false, false, false, false, 'any'],
  [true, false, false, true, true, 'none'],
  [true, false, false, true, false, 'closerequest'],
  [true, false, true, false, false, 'none'],
  [true, false, true, true, true, 'none'],
  [false, false, false, false, false, 'closerequest'],
  [false, false, false, true, true, 'closerequest'],
  [false, false, true, false, false, 'none'],
  [false, true, false, false, false, 'none'],
  [true, true, false, false, false, 'none'],
] as const)('closeWatcher modal %p docked %p dirty %p edited %p footer %p is %p', (modal, docked, dirty, edited, footer, expected) => {
  expect(closeWatcher({ modal, docked, dirty, edited, footer })).toBe(expected)
})

test('an overlay renders open on the server with a closeHref or beside the page, and never shut', () => {
  expect([renderedOpen(true, true, undefined), renderedOpen(true, true, '/x'), renderedOpen(true, false, undefined), renderedOpen(false, false, '/x')]).toEqual([false, true, true, false])
})

test('a close link follows only with no handler', () => {
  expect([followsHref('/x', undefined), followsHref('/x', () => undefined), followsHref(undefined, undefined)]).toEqual([true, false, false])
})

test('the French catalog words the Dialog close button', () => {
  expect((fr as unknown as { ui: { dialog: { close: string } } }).ui.dialog.close).toBe('Fermer')
})
