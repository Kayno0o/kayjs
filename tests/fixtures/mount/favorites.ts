import { persisted } from 'kay'

export const favorites = persisted<string[]>('favorites', [], { storage: 'local' })
