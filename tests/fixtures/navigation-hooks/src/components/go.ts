import { navigate } from 'kay'

// Something kay's transform rewrites in the browser, to show the prefix import goes in beside it.
const names = import.meta.glob('./data/*.ts', { eager: true, import: 'default' })

// A plain module an island imports, which calls navigate() without any .kay file of its own.
export async function goSecond(): Promise<boolean> {
  return Object.keys(names).length === 1 ? navigate('/second') : false
}
