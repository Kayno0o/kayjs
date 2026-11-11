import { api } from 'kay/server'
// The span a handler starts through the tracer, as an app's own instrumentation does.
import { traced } from '../../../../../src/server/trace'

export default api().get('/', async () => traced('probe.work', {}, async () => {
  await Bun.sleep(1)

  return 'worked'
}))
