import { guard } from 'kay'

export default guard(({ deny }) => {
  deny(401, { message: 'Sign in first' })
})
