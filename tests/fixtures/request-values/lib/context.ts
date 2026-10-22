import { defineContext } from 'kay/library'
import { loads } from './state'

// The visitor is named by a header, standing in for a session.
export default defineContext((request) => {
  loads.push(new URL(request.url).pathname)

  const name = request.headers.get('x-user')
  const roles = (request.headers.get('x-roles') ?? '').split(',').filter(Boolean)

  return { user: name === null ? null : { name, roles }, can: (role: string) => roles.includes(role) }
})
