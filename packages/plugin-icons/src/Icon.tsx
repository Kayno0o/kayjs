import type { IconData } from './types'
import { raw } from 'kay/ssr'

export interface IconComponentProps {
  icon: IconData
  class?: string | undefined
  className?: string | undefined
  style?: string | Record<string, string | number | undefined> | undefined
  'aria-label'?: string | undefined
  [attr: string]: unknown
}

export function Icon({ icon, ...rest }: IconComponentProps) {
  const hasLabel = rest['aria-label'] !== undefined
  return (
    <svg
      viewBox={icon.viewBox}
      width={icon.width}
      height={icon.height}
      aria-hidden={hasLabel ? undefined : 'true'}
      role={hasLabel ? 'img' : undefined}
      {...rest}
      innerHTML={raw(icon.body)}
    />
  )
}
