import type { TransitionClasses } from 'kay'

export interface Todo {
  id: number
  title: string
  done: boolean
}

export const fadeIn: TransitionClasses = { enter: 'transition-opacity', enterFrom: 'opacity-0' }
