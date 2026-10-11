import { call } from 'kay'
import notes from '../api/notes'

// What several islands share, calling the notes module from any of them.
export async function addNote(title: string): Promise<number> {
  return (await call(notes, '/', { method: 'post', body: { title } })).id
}
