import { setDefaultTimeout } from 'bun:test'

// Every run takes the suite's timeout, a file run alone or `bun test --changed` as much as `bun run test`: Bun's own 5 s fails tests that build or type-check whenever the machine is busy.
setDefaultTimeout(20_000)
