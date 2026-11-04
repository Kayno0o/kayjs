import { defineConfig } from 'kay/server'

// No request log: the profile prints its result on stdout.
export default defineConfig({ dirs: { routes: 'routes' }, observe: { log: false } })
