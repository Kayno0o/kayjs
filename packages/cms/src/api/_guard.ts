import { guard } from 'kay'
import { editRequested } from '../kay/server'

// Entries are read and written only for a request kay let into edit mode, whatever guard the app put there.
export default guard((ctx) => {
  if (!editRequested(ctx.request))
    ctx.deny(403, 'Not in edit mode')
})
