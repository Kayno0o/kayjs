import { guard } from 'kay'

// A request carrying the `refuse` cookie is turned away, as a signed-out visitor's would be.
export default guard(({ cookies, deny }) => {
  if (cookies.get('refuse') === '1')
    deny(403, { message: 'No entry' })

  if (cookies.get('refuse') === '500')
    deny(500, { message: 'Broken' })

  if (cookies.get('refuse') === '401')
    deny(401, { message: 'Sign in' })
})
