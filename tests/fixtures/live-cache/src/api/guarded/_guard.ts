import { guard } from 'kay'

export default guard(({ locals, deny }) => {
  if (locals.user === undefined)
    deny(401, 'Sign in first')
})
