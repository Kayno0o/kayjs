import { expect, test } from 'bun:test'
import { pageLocale, wording } from '../../../src/runtime/words.client'

test('wording reads the messages the page brought, fills them, picks a plural, and keeps the English for a key it lacks', async () => {
  const payload = document.createElement('script')

  payload.type = 'application/json'
  payload.setAttribute('data-kay-i18n', '')
  payload.textContent = JSON.stringify({ locale: 'fr', messages: { 'ui.table.rowCount': { one: '{count} ligne', other: '{count} lignes' }, 'ui.pagination.label': 'Pages', 'ui.since': 'Depuis le {day}' } })
  document.body.append(payload)

  try {
    expect(pageLocale()).toBe('fr')
    expect(wording('ui.pagination.label', 'Pagination')).toBe('Pages')
    expect(wording('ui.table.rowCount', '{count} rows', { count: 1 })).toBe('1 ligne')
    expect(wording('ui.table.rowCount', '{count} rows', { count: 3 })).toBe('3 lignes')
    expect(wording('ui.table.filterLabel', 'Filter {n}', { n: 2 })).toBe('Filter 2')
    expect(wording('ui.table.filterLabel', 'Go to {n}')).toBe('Go to {n}')

    const day = new Date(Date.UTC(2026, 9, 4, 12))

    expect(wording('ui.since', 'Since {day}', { day })).toBe('Depuis le 4 oct. 2026')
    expect(wording('ui.noSince', 'Since {day}', { day })).toBe('Since 4 oct. 2026')
  }
  finally {
    payload.remove()
  }
})
