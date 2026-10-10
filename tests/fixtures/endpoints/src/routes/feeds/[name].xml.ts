import type { EndpointContext } from 'kay'

export const page = { prerender: [{ name: 'first' }] }

export function GET({ params }: EndpointContext<{ name: string }>) {
  return new Blob([`<feed>${params.name}</feed>`])
}
