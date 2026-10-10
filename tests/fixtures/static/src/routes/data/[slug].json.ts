import type { EndpointContext } from 'kay'

export const page = { prerender: [{ slug: 'first' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json({ slug: params.slug })
}
