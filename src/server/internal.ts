export { registerEmbeddedMap } from '../build/sourcemap'
// The server half of the compiler's output contract, imported by the entry `kay build --compile` generates.
export type { Bundle } from './bundle'
export { registerBundle } from './bundle'
export { probeHealth } from './lifecycle'
