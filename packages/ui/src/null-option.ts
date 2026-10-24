// What a group's `options` must also satisfy for its `value`: a null option needs a `value` typed to allow `null`, and shares no group with an option of `""`, which posts the same empty string.
// An intersection with the options, so `Value` is still inferred from the options and the typed `onChange` alone.
// A `string` option may be `""`, which no type can tell, so it is left alone.
export type NullOption<Value, Held> = null extends Value
  ? null extends Held
    ? '' extends Value ? string extends Value ? unknown : { 'a null option and an option of "" post the same empty string': never } : unknown
    : { 'a null option needs a value typed to allow null': never }
  : unknown
