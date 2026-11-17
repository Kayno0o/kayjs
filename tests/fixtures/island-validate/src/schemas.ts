import { s } from 'kay'

export const contact = { email: s.email(), message: s.string({ min: 3 }) }
