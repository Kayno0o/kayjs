// The products collection's store, which the tests read back.
// Set to make the loader throw, as a database down would.
export const outage: { message?: string | undefined } = {}

export const products: { slug: string, data: { name: string, color?: string, mood?: string } }[] = [{ slug: 'mug', data: { name: 'Mug', color: '#ff0000', mood: 'calm' } }]
