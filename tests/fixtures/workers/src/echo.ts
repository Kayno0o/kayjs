// A module worker the island starts, loading its wasm from beside its own bundle.
globalThis.onmessage = async (event: MessageEvent<number>) => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('./add.wasm', import.meta.url)))

  postMessage(String((instance.exports.add as (a: number, b: number) => number)(event.data, 1)))
}
