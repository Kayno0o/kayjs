import { call } from 'kay'
import notes from '../api/notes'

export const addNote = async () => call(notes, '/', { method: 'post', body: { title: 'Milk' } })
