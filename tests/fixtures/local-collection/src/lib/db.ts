export interface Note {
  id: string
  title: string
  rev: number
}

// The server's side of the collection, in memory: its rows and how often the save action ran.
export const notes = new Map<string, Note>()
export const stats = { saves: 0, drops: 0 }
