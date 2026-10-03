import { guard } from 'kay'

// Signed-out visitors are sent away and only ada gets in; the cookie shows a guard's response headers reach the visitor.
export default guard(({ locals, cookies, redirect, deny }) => {
  cookies.set('seen', 'admin')

  if (locals.user === undefined)
    redirect('/about')

  if (locals.user !== 'ada')
    deny(403, 'Admins only')
})
