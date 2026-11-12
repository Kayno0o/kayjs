import type { Lint, TypeLint } from './lints'

// The lints of a `for`'s rows, with the other lints in `LINTS`.
export const LOOP_LINTS = {
  'unkeyed-rows': {
    level: 'warn',
    group: 'islands',
    typed: true,
    summary: 'A `for` with no `key` in an island, or in a component only islands import, over rows of an object type with no `id` (a component shared with server-rendered pages is not reported): its rows are matched by the item itself, so an item rebuilt as a copy (`{ ...row, text }`, a list fetched again) is a new row, which redraws its markup and loses its fields and focus, where before 1.101 kay paired such copies with the rows left in their place. Give the rows an `id`, or write the `key` that names them (`key={row.slug}`); `key={i}` matches by position, as a list of copies was matched before. Rows kept as the same objects, or a list that never changes, need nothing, so `allow` it where that holds. The fix offered writes `key={i}`, adding the index to the `for`; `kay check --fix` leaves it, as position may not be what names a row.',
    wrong: '--- island\nconst rows = signal<{ text: string }[]>([])\n---\nfor row of rows()\n  p {row.text}',
    right: '--- island\nconst rows = signal<{ text: string }[]>([])\n---\nfor row, i of rows() key={i}\n  p {row.text}',
  },
} as const satisfies Record<string, Lint>

// What the type check's error on rows with no `id`, which carries the marker the `KayKeyed` type puts in it, stands for.
export function unkeyedRows(message: string): TypeLint | undefined {
  if (!message.includes('kayLint: "unkeyed-rows"'))
    return undefined

  return {
    code: 'unkeyed-rows',
    message: 'These rows have no `id` and no `key`, so a copy of an item is a new row',
    note: 'rows are matched by `id` or else by the item itself: a list rebuilt from copies redraws every row, losing its fields and focus',
    help: 'give the rows an `id`, name them with `key={row.slug}`, or write `key={i}` to match them by position',
  }
}
