import type { EndpointContext } from 'kay'

export function GET({ deny }: EndpointContext) {
  return deny(418, { message: 'Short and stout' })
}
