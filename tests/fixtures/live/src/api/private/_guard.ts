import { guard } from 'kay'

export default guard(({ locals, cookies, deny }) => {
  cookies.set('checked', 'private')

  if (locals.user === undefined)
    deny(401, 'Sign in first')
})
