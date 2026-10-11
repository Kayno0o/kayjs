import type { AstroIntegration } from 'astro'
import solid from '@astrojs/solid-js'
import { defineConfig } from 'astro/config'

// An adapter whose entry exports Astro's request handler, for the bench to call in-process.
const bench: AstroIntegration = {
  name: 'bench',
  hooks: {
    'astro:config:done': ({ setAdapter }) => {
      setAdapter({ name: 'bench', entrypointResolution: 'auto', serverEntrypoint: new URL('entry.ts', import.meta.url), supportedAstroFeatures: {} })
    },
  },
}

export default defineConfig({
  output: 'server',
  adapter: bench,
  integrations: [solid()],
})
