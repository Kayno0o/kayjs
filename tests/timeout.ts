import { setDefaultTimeout } from 'bun:test'

// Every run takes the suite's timeout, a file run alone or `bun test --changed` as much as `bun run test`: Bun's own 5 s fails tests that build or type-check whenever the machine is busy, and CI shares its host with the sessions working on kay, where a file's first site build passed 20 s.
setDefaultTimeout(60_000)
