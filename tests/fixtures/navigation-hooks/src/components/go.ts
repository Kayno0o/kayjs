import { navigate } from 'kay'

// A plain module an island imports, which calls navigate() without any .kay file of its own.
export async function goSecond(): Promise<boolean> {
  return navigate('/second')
}
