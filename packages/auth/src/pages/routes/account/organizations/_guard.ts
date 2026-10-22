import type { Auth } from '../../../../auth'
import { guard } from 'kay'

// The organization pages exist only on a site declaring `organizations`; anywhere else they answer 404, pages and actions alike.
export default guard<{ auth: Auth }>((ctx) => {
  if (ctx.locals.auth.features().organizations === null)
    ctx.deny(404)
})
