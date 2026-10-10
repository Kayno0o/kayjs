import type { EndpointContext } from 'kay'

export function GET({ url }: EndpointContext) {
  return `# Site\n\nServed at ${url.pathname}\n`
}
