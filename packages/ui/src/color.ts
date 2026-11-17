// A CSS colour an app hands a component, written into one private custom property of its element. A value that could end the declaration or the attribute is dropped, as a colour never holds one of these characters.
const UNSAFE = /[;{}<>\\"'!]|\/\*/

// The `style` text a component sets on its element: the colour's declaration, then the app's own `style`, which wins.
export function colorStyle(property: string, color: string | undefined, style?: string | undefined): string | undefined {
  const own = color !== undefined && color.trim() !== '' && !UNSAFE.test(color) ? `${property}: ${color.trim()}` : undefined

  return [own, style].filter(Boolean).join('; ') || undefined
}
