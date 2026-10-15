const WHOLE_NUMBER = /^\d+$/

// An even whole number, as a number.
export default (value: string): number | undefined => WHOLE_NUMBER.test(value) && Number(value) % 2 === 0 ? Number(value) : undefined
