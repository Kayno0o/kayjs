import { signal } from 'kay'

// One state for every island of a page, which the server renders per request.
export const added = signal(0)
export const theme = signal<'light' | 'dark'>('light', { persist: 'theme' })
export const note = signal('', { persist: 'note', storage: 'local' })
