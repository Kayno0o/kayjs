import { live } from 'kay'

export const unread = live(0, { user: true })
export const visitors = live(0)
