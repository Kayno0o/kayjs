import { guard } from 'kay'
import { visits } from '../../limits'

export default guard(async (ctx) => {
  await visits.enforce(ctx)
})
