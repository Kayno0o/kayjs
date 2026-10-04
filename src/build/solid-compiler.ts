import { createRequire } from 'node:module'
import { WASI } from 'node:wasi'

interface BunWASI {
  initialize?: (instance: WebAssembly.Instance) => void
  setMemory: (memory: WebAssembly.Memory) => void
}

// Solid's compiler has no musl build, so on alpine it runs its WASI build, which calls `initialize`: Node's WASI has it, Bun's does not.
// As in Node, it hands the instance's memory over, then runs the module's own initializer.
const prototype = WASI.prototype as unknown as BunWASI

prototype.initialize ??= function (this: BunWASI, instance: WebAssembly.Instance) {
  const exports = instance.exports as { memory?: WebAssembly.Memory, _initialize?: () => void }

  if (exports.memory)
    this.setMemory(exports.memory)

  exports._initialize?.()
}

type SolidCompiler = typeof import('@solidjs/compiler')

let compiler: SolidCompiler | undefined

// Required rather than imported, so the binding it loads finds `initialize` already there.
// Only on a first compile, so a server that never compiles, such as a `kay build --compile` executable, never loads it.
export function transform(...args: Parameters<SolidCompiler['transform']>): ReturnType<SolidCompiler['transform']> {
  compiler ??= createRequire(import.meta.url)('@solidjs/compiler') as SolidCompiler

  return compiler.transform(...args)
}
