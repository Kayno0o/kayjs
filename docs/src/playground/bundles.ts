import { Elysia } from 'elysia'
import { bundled } from './bundle'

export const compiler = bundled('compile.ts', true)
export const runtime = bundled('frame.ts', false)

// Bundles both once the server listens, so the first playground visitor finds them built: a `kay build` never starts the server, and so never pays for them.
export const playgroundWarm = {
  name: 'playground-warm',
  server: () => new Elysia().onStart(() => {
    // Not awaited, so the server answers meanwhile. A failure is left for the visitor's request to report, which builds again.
    void Promise.allSettled([compiler(), runtime()])
  }),
}
