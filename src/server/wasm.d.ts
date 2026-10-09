// Imported `with { type: 'file' }`, a wasm module is the path of its file, embedded in an executable.
declare module '*.wasm' {
  const path: string

  export default path
}
