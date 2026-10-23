(fence
  (fence_body) @injection.content
  (#set! injection.language "typescript"))

(style_fence
  (fence_body) @injection.content
  (#set! injection.language "css"))

([
  (hole_content)
  (paren_content)
  (bracket_content)
  (expression)
  (condition)
  (await_expression)
  (each_expression)
] @injection.content
  (#set! injection.language "typescript"))

((markdown_body) @injection.content
  (#set! injection.language "markdown"))
