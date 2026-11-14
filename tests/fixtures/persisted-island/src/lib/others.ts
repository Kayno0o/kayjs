import { persisted, queryParam } from 'kay'

export const theme = persisted.session<string>('theme', 'light')
export const consent = persisted.cookie<boolean>('consent', false)
export const filter = queryParam<string>('filter', { default: '' })
