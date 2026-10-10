import { guard } from 'kay'

export default guard(({ request, deny, headers }) => {
  if (!request.headers.has('authorization'))
    deny(401, 'Sign in first')

  headers.set('x-guarded', 'yes')
})
