import process from 'node:process'

// Node modules a server loads the first time a feature needs them: once loaded, zlib costs a compiled server 4.6 MiB, http 2.9 MiB, crypto 1.9 MiB and net 1.7 MiB (its `BlockList`, 7 ms of start).
// Bun hoists a bundled module's imports to the top of the executable, so a static import of one anywhere on the server loads it at start; `tests/new.test.ts` checks none does.
export const nodeZlib = () => process.getBuiltinModule('node:zlib')
export const nodeCrypto = () => process.getBuiltinModule('node:crypto')
export const nodeHttp = () => process.getBuiltinModule('node:http')
export const nodeNet = () => process.getBuiltinModule('node:net')
