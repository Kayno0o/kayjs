import type { FilterField } from './table'
import { persisted, signal } from 'kay'

export interface FilterInput {
  // Read once, when the table is made.
  filterParam: string | undefined
  fields: readonly FilterField[] | undefined
  // The query names the table writes itself, which a field's own would overwrite: the sort's and the pager's.
  reserved: (string | undefined)[]
}

// What a Table with a search box or extra fields holds: the typed text and each field's value, kept in the address under their own names when they have one.
export function tableFilter(input: FilterInput) {
  const typed = input.filterParam === undefined ? signal('') : persisted.query(input.filterParam, '')
  const extra = input.fields ?? []
  const taken = new Set(['sort', 'direction', input.filterParam ?? 'q', ...input.reserved])

  for (const field of extra) {
    if (taken.has(field.key))
      throw new Error(`kayjs-ui: a Table field cannot be keyed ${field.key}, a name the table's sort, search or export address already writes in the query`)
  }

  const values = extra.map(field => persisted.query(field.key, ''))
  const fieldsNow = () => Object.fromEntries(extra.flatMap((field, index) => values[index]!() === '' ? [] : [[field.key, values[index]!()]]))
  const asked = () => ({ text: typed(), fields: fieldsNow() })
  const active = () => typed() !== '' || extra.some((_, index) => values[index]!() !== '')

  return { typed, extra, values, fieldsNow, asked, active }
}
