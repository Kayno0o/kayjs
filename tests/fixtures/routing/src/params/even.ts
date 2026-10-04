// An even whole number, as a number.
export default (value: string): number | undefined => (/^\d+$/).test(value) && Number(value) % 2 === 0 ? Number(value) : undefined
