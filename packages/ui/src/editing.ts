import { signal } from 'kay'

// The add-or-edit dialog a list page has open.
export interface Editing<Row, Draft = void> {
  // The row being edited; undefined while adding or closed.
  row: () => Row | undefined
  // What the new row starts from; undefined while editing or closed.
  draft: () => Draft | undefined
  // Whether the dialog shows, for its `open` prop.
  open: () => boolean
  // Opens the dialog on a row, or on what a new row starts from; each takes the place of the one open.
  edit: (row: Row) => void
  create: (draft: Draft) => void
  // Forgets the row or draft, for the dialog's `onClose`.
  close: () => void
}

// One dialog adding and editing the rows of a list: `edit(row)` opens it on a row, `create(draft)` on what a new row starts from, `close` shuts it, and `open()` says whether it shows.
// Wrapped in an object, a row held is the very one the page handed over, a function row included.
export function editing<Row, Draft = void>(): Editing<Row, Draft> {
  const session = signal<{ row: Row } | { draft: Draft } | null>(null)
  const row = () => {
    const current = session()

    return current && 'row' in current ? current.row : undefined
  }
  const draft = () => {
    const current = session()

    return current && 'draft' in current ? current.draft : undefined
  }

  return {
    row,
    draft,
    open: () => session() !== null,
    edit: next => session.set({ row: next }),
    create: next => session.set({ draft: next }),
    close: () => session.set(null),
  }
}
