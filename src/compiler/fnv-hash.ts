// FNV-1a over the UTF-16 units, 64 bits, where Bun's hash is missing (the playground, ESLint under Node): a scoped style's attribute only has to differ from another module's, so it need not match Bun.hash.
export function fnvHash(text: string): string {
  let state = 0xCBF29CE484222325n

  for (let i = 0; i < text.length; i++)
    state = BigInt.asUintN(64, (state ^ BigInt(text.charCodeAt(i))) * 0x100000001B3n)

  return state.toString(36)
}
