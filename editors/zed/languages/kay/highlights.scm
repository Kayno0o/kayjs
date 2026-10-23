(comment) @comment

(fence_marker) @punctuation.special
(fence_label) @keyword
(type_parameters) @type

(tag_name) @tag
(component_name) @constructor
(class_name) @string.special
(id_name) @string.special

(attribute_name) @attribute
(modifiers) @operator
(string) @string

(escape) @string.escape
(slot_name) @function

(identifier) @variable
(field_name) @property

[
  "if"
  "else"
  "for"
  "of"
  "key"
  "as"
  "await"
  "then"
  "catch"
  "try"
  "pending"
  "match"
  "when"
  "const"
  "snippet"
  "slot"
  "error"
  "markdown"
] @keyword

(hole
  [
    "{"
    "}"
  ] @punctuation.special)

[
  "("
  ")"
  "["
  "]"
  "#["
] @punctuation.bracket

[
  ","
  ":"
  "|"
] @punctuation.delimiter

"=" @operator
