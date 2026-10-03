import { guard } from 'kay'

// No special page applies here, so the denial goes out as plain text, with what the guard set.
export default guard(({ cookies, headers, deny }) => {
  cookies.set('seen', 'locked')
  headers.set('x-guard', 'locked')
  deny(403, 'Locked')
})
