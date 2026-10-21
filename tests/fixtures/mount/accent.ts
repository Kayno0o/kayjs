import { persisted } from 'kay'

export const accent = persisted('accent', 'blue', { storage: 'local', values: ['blue', 'green'] })
