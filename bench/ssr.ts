import { measure } from 'mitata'
import { appFromArgs, loadApp } from './apps'

// Server-renders the products page in-process until mitata's statistics settle, and prints them as JSON.
const app = await loadApp(appFromArgs())
const render = async () => (await app.handle(new Request('http://localhost/'))).text()

// One render before measuring, so the first sample does not pay for module loading.
await render()
const stats = await measure(render, { min_cpu_time: 3e9 })

console.log(JSON.stringify({ avg: stats.avg, p50: stats.p50, p99: stats.p99 }))
