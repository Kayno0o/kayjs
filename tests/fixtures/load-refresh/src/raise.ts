import { visitors } from './live'

export function raise(): void {
  visitors.set(n => n + 1)
}
