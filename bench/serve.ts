import { appFromArgs, loadApp } from './apps'

// Serves an app on a free port and prints it, for the browser runs.
const app = await loadApp(appFromArgs())
const server = Bun.serve({ port: 0, fetch: async request => app.handle(request) })

console.log(`ready ${server.port}`)
