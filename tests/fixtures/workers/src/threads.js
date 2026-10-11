// As an emscripten build with threads ships: the module starts itself as its worker and loads its wasm by a bare name beside it.
if (typeof WorkerGlobalScope !== 'undefined') {
  globalThis.onmessage = async ({ data: [a, b] }) => {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('add.wasm', import.meta.url)))

    postMessage(instance.exports.add(a, b))
  }
}

export function add(a, b) {
  const worker = new Worker(new URL('threads.js', import.meta.url), { type: 'module', name: 'em-pthread' })

  return new Promise((resolve) => {
    worker.onmessage = event => resolve(event.data)
    worker.postMessage([a, b])
  })
}
