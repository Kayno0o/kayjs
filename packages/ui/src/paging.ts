import { s } from 'kay'

// The input fields of an action that lists by offset, which `infiniteList({ action })` fills in for each page: `s.Object({ ...pageFields(), q: s.Optional(s.String()) })`. `max` is the most rows one call may ask for.
export function pageFields(max = 500) {
  return {
    offset: s.Optional(s.Integer({ minimum: 0 })),
    limit: s.Optional(s.Integer({ minimum: 1, maximum: max })),
  }
}

export interface PageInput {
  offset?: number | undefined
  limit?: number | undefined
}

// The page of a list held whole, `limit` rows (100 by default) from `offset` on, with the `total` held: the same call serves the action and the page rendering its first rows.
export function pageOf<Row>(rows: Row[], { offset = 0, limit = 100 }: PageInput = {}): { rows: Row[], total: number } {
  return { rows: rows.slice(offset, offset + limit), total: rows.length }
}
