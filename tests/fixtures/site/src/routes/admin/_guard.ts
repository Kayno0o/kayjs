import { guard } from 'kay'

// Signed-out visitors are sent away and only ada gets in; the cookie and the header show a guard's response headers reach the visitor.
export default guard(({ locals, cookies, headers, redirect, deny }) => {
  cookies.set('seen', 'admin')
  headers.set('vary', 'x-user')

  if (locals.user === undefined)
    redirect('/about')

  if (locals.user !== 'ada')
    deny(403, 'Admins only')
})
