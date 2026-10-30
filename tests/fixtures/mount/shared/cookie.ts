import { persisted } from 'kay'

export const tone = persisted('shared-tone', 'peach', { storage: 'cookie' })
