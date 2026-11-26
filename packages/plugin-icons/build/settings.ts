// The settings both the table and the bench build with, so the bench scores the table that ships.
// How many meaning neighbours a word keeps, the similarity under which a neighbour is dropped, and how much a neighbour weighs against a tag pairing.
export const NEIGHBOURS = 8
export const FLOOR = Number(process.env.ICONS_FLOOR ?? 0.76)
export const MEANING_WEIGHT = Number(process.env.ICONS_MEANING ?? 0.5)
