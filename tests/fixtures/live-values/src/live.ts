import { live } from 'kay'

export const visitors = live(0)
export const room = live((id: string) => ({ id, users: 0 }))
export const secret = live('hidden')
