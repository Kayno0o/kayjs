import { persisted } from 'kay'

export const history = persisted.local<Record<string, number>>('history', {})
export const label = 'History'
