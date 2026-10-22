import { route } from '../runtime/route'

// The path of the page showing an entry of a collection with a `route`, its slug as the param; undefined for a slug the route refuses, `.`, `..` or a doubled `/`.
export function entryPath(pattern: string, slug: string): string | undefined {
  try {
    return (route as (pattern: string, params: Record<string, string>) => string)(pattern, { slug })
  }
  catch {
    return undefined
  }
}
