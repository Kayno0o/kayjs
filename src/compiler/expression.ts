import { parseExpression } from '@babel/parser'

export function isFunctionExpression(code: string): boolean {
  try {
    const expression = parseExpression(code, { plugins: ['typescript'] })

    return expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression'
  }
  catch {
    return false
  }
}

// The string a JSX attribute or text spells, its entities decoded, as a component receives it.
export function decodeEntities(text: string): string {
  if (!text.includes('&'))
    return text

  try {
    const expression = parseExpression(`<a b="${text.replaceAll('"', '&quot;')}" />`, { plugins: ['jsx'] })

    if (expression.type === 'JSXElement') {
      const value = expression.openingElement.attributes[0]

      if (value?.type === 'JSXAttribute' && value.value?.type === 'StringLiteral')
        return value.value.value
    }
  }
  catch {}

  return text
}
