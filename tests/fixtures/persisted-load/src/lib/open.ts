import { persisted } from 'kay'

export const open = persisted.cookie('open', 'none', { values: ['none', 'a', 'b'] })
