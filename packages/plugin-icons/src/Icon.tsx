/** @jsxImportSource @kayjs/kay */
import type { JSX } from '@kayjs/kay/jsx-runtime'
import type { IconData } from './types'

export type IconComponentProps = Omit<JSX.IntrinsicElements['svg'], 'children' | 'innerHTML'> & { icon: IconData }

function isName(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

// An icon is an image when the caller names it, and hidden from assistive tech otherwise.
export function Icon({ icon, viewBox, width, height, role, 'aria-hidden': ariaHidden, ...rest }: IconComponentProps) {
  const named = (): boolean => isName(rest['aria-label']) || isName(rest['aria-labelledby'])
  return (
    <svg
      {...rest}
      viewBox={viewBox ?? icon.viewBox}
      width={width ?? icon.width}
      height={height ?? icon.height}
      role={role ?? (named() ? 'img' : undefined)}
      aria-hidden={ariaHidden ?? (named() ? undefined : 'true')}
      innerHTML={icon.body}
    />
  )
}
