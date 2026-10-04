// One row of a BarList.
export interface BarListRow {
  key: string | number
  label: string
  value: number
  // What the row reads on its right, the value as it is when omitted.
  display?: string
}
