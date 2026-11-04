import { guard } from 'kay'
import { seen } from '../../seen'

export default guard(({ signal }) => {
  seen.guard = signal
})
