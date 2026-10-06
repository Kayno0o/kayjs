import { persisted, signal } from 'kay'

// One state for every island of a page, which the server renders per request.
export const added = signal(0)
export const theme = persisted<'light' | 'dark'>('theme', 'light')
export const note = persisted('note', '', { storage: 'local' })
