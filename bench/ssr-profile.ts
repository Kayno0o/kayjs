import type { CpuProfile } from './attribution'
import { Session } from 'node:inspector/promises'
import { appFromArgs, loadApp } from './apps'
import { originOf, timeByOrigin } from './attribution'

const WARMUP_RENDERS = 200
const RENDERS = 3000
const SAMPLING_INTERVAL_US = 100

// Server-renders the products page under Bun's CPU profiler, boot and warmup left out, and prints each origin's microseconds per render as JSON.
const app = await loadApp(appFromArgs())
const render = async () => (await app.handle(new Request('http://localhost/'))).text()

for (let index = 0; index < WARMUP_RENDERS; index++)
  await render()

const session = new Session()

session.connect()
await session.post('Profiler.enable')
await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
await session.post('Profiler.start')

for (let index = 0; index < RENDERS; index++)
  await render()

const { profile } = await session.post('Profiler.stop') as { profile: CpuProfile }
const times = timeByOrigin(profile, frame => frame.url === '' ? undefined : originOf(frame.url))

console.log(JSON.stringify(Object.fromEntries([...times].map(([origin, time]) => [origin, time / RENDERS]))))
