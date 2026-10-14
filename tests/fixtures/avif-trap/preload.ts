// Preloaded into an AVIF worker: the first encoder instance traps on its first encode, as libaom aborting would, and every call into it fails from then on.
// The encode is found by its arity, the one export taking five parameters, as the build minifies export names.
const { Instance } = WebAssembly
let trapped = false

function trapping(exports: WebAssembly.Exports): WebAssembly.Exports {
  let dead = false

  return Object.fromEntries(Object.entries(exports).map(([name, value]) => {
    if (typeof value !== 'function')
      return [name, value]

    const call = value as (...args: unknown[]) => unknown

    return [name, (...args: unknown[]) => {
      if (dead)
        throw new WebAssembly.RuntimeError('memory access out of bounds')

      if (call.length === 5 && !trapped) {
        trapped = dead = true

        throw new WebAssembly.RuntimeError('unreachable')
      }

      return call(...args)
    }]
  }))
}

class TrappingInstance extends Instance {
  #exports: WebAssembly.Exports | undefined

  override get exports(): WebAssembly.Exports {
    this.#exports ??= trapping(super.exports)

    return this.#exports
  }
}

WebAssembly.Instance = TrappingInstance
