import { Database } from 'bun:sqlite'

// Another process of the app: takes the write lock of the file, changes the title of one entry, and commits after a pause, so a move started meanwhile has to wait for it.
declare const self: Worker

self.onmessage = (event: MessageEvent<{ path: string, table: string, title: string, holdMs: number, order?: number }>) => {
  const { path, table, title, holdMs, order } = event.data
  const db = new Database(path)

  db.run('PRAGMA busy_timeout = 5000')
  db.run('BEGIN IMMEDIATE')

  const stored = db.query<{ data: string }, []>(`SELECT data FROM ${table} WHERE collection = 'posts' AND place = 'a'`).get()!
  const data = { ...JSON.parse(stored.data) as Record<string, unknown>, title, ...order !== undefined && { order } }

  db.query(`UPDATE ${table} SET data = ? WHERE collection = 'posts' AND place = 'a'`).run(JSON.stringify(data))
  self.postMessage('locked')
  setTimeout(() => {
    db.run('COMMIT')
    db.close()
    self.postMessage('committed')
  }, holdMs)
}
