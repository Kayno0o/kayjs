import type { Instances } from './live'
import { stream } from 'kay'
import instanceApi from '../api/instance'

// The server's own word of which instance answers, opened when a save starts waiting for a rebuild and closed with the form that made it.
export function serverInstances(): Instances {
  const link = stream(instanceApi, '/', { start: false })

  return { start: () => link.start(), onData: link.onData, onError: link.onError }
}
