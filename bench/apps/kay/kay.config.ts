import { defineConfig } from 'kay/server'

// No request log: the profile prints its result on stdout.
export default defineConfig({ routes: 'routes', log: false })
