import process from 'node:process'

// Node modules loaded the first time a feature needs them rather than at import: once loaded, a compiled server pays 4.6 MiB for zlib, 2.9 MiB for http and 1.9 MiB for crypto, which one sending the build's compressed copies, with no session, card or preview, never needs.
export const nodeZlib = () => process.getBuiltinModule('node:zlib')
export const nodeCrypto = () => process.getBuiltinModule('node:crypto')
export const nodeHttp = () => process.getBuiltinModule('node:http')
