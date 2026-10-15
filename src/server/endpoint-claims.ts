import type { Endpoint } from './routes'
import type { ServedPaths } from './served-paths'

// Apart from `./endpoints` so `kay check` claims the paths without loading the server.
// Two endpoints serving the same paths, or one taking a path a page or a public file serves, stop the server, as two pages do; each is exported as `exportedEndpoints` says.
export function claimEndpoints(served: ServedPaths, endpoints: Endpoint[], root: string): void {
  for (const endpoint of endpoints) {
    const { pattern, suffix, file } = endpoint
    const path = `${pattern}${suffix ?? ''}`

    served.claim({ path: pattern, owner: file, kind: 'endpoint', suffix, exported: async () => (await (await import('./endpoints')).exportedEndpoints(root, [endpoint])).paths }, (taken) => {
      if (taken.kind === 'page')
        return `kay: ${taken.owner} and ${file} both serve ${pattern}${suffix === undefined ? '' : `, which ${file} takes for its paths ending in ${suffix}`}; move one`

      return taken.kind === 'public' ? `kay: ${file} and the public file ${taken.path} both serve ${path}; drop one` : `kay: ${taken.owner} and ${file} both serve ${path}`
    })
  }
}
