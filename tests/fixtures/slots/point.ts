export class Point {
  constructor(readonly x: number, readonly y: number) {}

  sum(): number {
    return this.x + this.y
  }
}
