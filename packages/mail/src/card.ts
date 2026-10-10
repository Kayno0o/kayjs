// The card's padding on each side, which the content inside it is narrower by, its 1px border too.
export const CARD_PADDING_X = 28

export function contentWidth(width: number): number {
  return width - 2 * CARD_PADDING_X - 2
}
