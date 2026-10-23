export interface Game {
  coins: number
  ticks: number
  miners: { id: number, ore: number }[]
}
