import type { EndpointContext } from 'kay'

export const page = { prerender: [{ slug: 'first' }, { slug: 'second' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json({ slug: params.slug }, { headers: { 'cache-control': 'max-age=60' } })
}
