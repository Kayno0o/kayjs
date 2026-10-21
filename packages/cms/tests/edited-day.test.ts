import { expect, it } from 'bun:test'
import { editedDay } from '../src/datetime'

// 23:30 UTC on the 20th is already the 21st in Paris.
const LATE = Date.UTC(2026, 9, 20, 23, 30)

it('writes the UTC day while the browser has not said its zone', () => {
  expect(editedDay(LATE)).toBe('2026-10-20')
})

it('writes the day in the editor\'s zone and the page\'s language', () => {
  expect(editedDay(LATE, 'Europe/Paris', 'fr')).toBe('21 oct. 2026')
  expect(editedDay(LATE, 'America/New_York', 'en')).toBe('Oct 20, 2026')
})

it('falls back to the UTC day for a zone or language Intl refuses', () => {
  expect(editedDay(LATE, 'Not/AZone', 'fr')).toBe('2026-10-20')
})
