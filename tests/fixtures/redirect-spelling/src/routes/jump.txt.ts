import type { EndpointContext } from 'kay'

export function GET({ url, redirect }: EndpointContext) {
  return redirect(url.searchParams.get('to') ?? '/')
}
