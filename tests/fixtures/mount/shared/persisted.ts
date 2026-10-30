import { persisted } from 'kay'

export const theme = persisted('shared-theme', 'light', { storage: 'local' })
