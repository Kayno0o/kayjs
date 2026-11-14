import type { StoreUrl } from './own'

// kayjs-auth's data in a SQLite file, through pg-orm: `auth({ store: sqliteAuth('data/users.sqlite') })`. The file is made, and its `kay_*` tables with it, when the server starts; a relative path is kept under the project root.
export function sqliteAuth(path: string): StoreUrl {
  return { url: `sqlite://${path}` }
}
