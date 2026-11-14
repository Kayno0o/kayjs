import { live } from 'kay'

export const visitors = live(0)
export const room = live((id: string) => ({ id, users: 0 }))
export const secret = live('hidden')
export const tally = live(5, { key: true })
export const tags = live<string[], '1d'>([], { key: true })
export const mine = live(0, { user: true })
