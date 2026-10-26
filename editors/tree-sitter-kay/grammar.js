/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// kay's template is indentation based, so src/scanner.c emits the layout tokens (newline, indent, dedent) and the spans of embedded code: fence bodies, `{...}` holes, `(...)` parameters, the expression of a line and the shorthand classes.
// Everything else is regular. The compiler's parser (src/compiler/parser.ts) is the reference for the syntax.
module.exports = grammar({
  name: 'kay',

  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
    $.fence_body,
    $.style_body,
    $._fence_close,
    $.hole_content,
    $.paren_content,
    $.bracket_content,
    $.expression,
    $.condition,
    $.await_expression,
    $.each_expression,
    $.class_name,
    $.markdown_body,
    $._error_sentinel,
  ],

  extras: () => [/[ \t]/],

  word: $ => $.tag_name,

  rules: {
    source_file: $ => seq(optional($._newline), repeat($._fence), repeat($._statement)),

    // Fences
    _fence: $ => choice($.fence, $.style_fence),

    fence: $ => seq(
      $.fence_marker,
      optional($.fence_label),
      optional($.type_parameters),
      $._fence_line_end,
      optional($.fence_body),
      optional($._fence_close),
    ),

    style_fence: $ => seq(
      $.fence_marker,
      alias('style', $.fence_label),
      $._fence_line_end,
      optional(alias($.style_body, $.fence_body)),
      optional($._fence_close),
    ),

    fence_marker: () => '---',
    fence_label: () => choice('server', 'client', 'script', 'module'),
    type_parameters: () => /<[^\n]*>/,
    _fence_line_end: () => /\r?\n/,

    // Template lines
    _line_end: $ => seq($._newline, optional($.block)),

    block: $ => seq($._indent, repeat1($._statement), $._dedent),

    _statement: $ => choice(
      $.comment_line,
      $.text_line,
      $.slot_fill,
      $.slot_outlet,
      $.snippet,
      $.error_line,
      $.const_line,
      $.if_line,
      $.else_line,
      $.for_line,
      $.await_line,
      $.then_line,
      $.catch_line,
      $.try_line,
      $.pending_line,
      $.match_line,
      $.when_line,
      $.markdown,
      $.element,
    ),

    comment_line: $ => seq($.comment, $._line_end),
    comment: () => token(/\/\/[^\n]*/),

    text_line: $ => seq(
      choice(
        seq('|', repeat($._text_part)),
        seq($.hole, repeat($._text_part)),
      ),
      $._line_end,
    ),

    slot_fill: $ => seq($.slot_name, optional($.parameters), $._line_end),
    slot_name: () => token(seq('@', /[A-Z_$][\w$]*/i)),

    slot_outlet: $ => seq('slot', optional($.identifier), optional($.parameters), $._line_end),

    snippet: $ => seq('snippet', $.identifier, optional($.parameters), $._line_end),

    parameters: $ => seq(alias($._open_paren, '('), optional($.paren_content), ')'),

    error_line: $ => seq('error', repeat($.class_name), optional(choice($.field_name, $.string)), $._line_end),
    field_name: () => /[\w$-]+/,

    const_line: $ => seq(
      'const',
      choice($.identifier, $.hole, seq('[', optional($.bracket_content), ']')),
      '=',
      $.expression,
      $._line_end,
    ),

    if_line: $ => seq(
      choice('if', seq('else', 'if')),
      $.condition,
      optional(seq('as', $.identifier)),
      $._line_end,
    ),
    else_line: $ => seq('else', $._line_end),

    for_line: $ => seq(
      'for',
      choice($.identifier, $.hole, seq('[', optional($.bracket_content), ']')),
      optional(seq(',', $.identifier)),
      'of',
      $.each_expression,
      optional(seq('key', '=', $.hole)),
      $._line_end,
    ),

    await_line: $ => seq('await', $.await_expression, optional(seq('then', optional($.identifier))), $._line_end),
    then_line: $ => seq('then', optional($.identifier), $._line_end),
    catch_line: $ => seq('catch', optional($.identifier), $._line_end),
    try_line: $ => seq('try', $._line_end),
    pending_line: $ => seq('pending', $._line_end),

    match_line: $ => seq('match', $.expression, $._line_end),
    when_line: $ => seq('when', $.expression, $._line_end),

    markdown: $ => seq('markdown', $._newline, optional($.markdown_body)),

    // Elements
    element: $ => seq($._element_body, $._line_end),

    _element_body: $ => seq(
      $._tag_head,
      optional($.attributes),
      optional(choice($.block_expansion, repeat1($._text_part))),
    ),

    block_expansion: $ => seq(alias($._expansion_marker, ':'), $._element_body),

    _tag_head: $ => choice(
      seq(choice($.tag_name, $.component_name), repeat($._shorthand)),
      seq(choice($.class_name, alias($.line_id, $.id_name)), repeat($._shorthand)),
    ),
    _shorthand: $ => choice($.class_name, $.id_name),

    tag_name: () => /[a-z][\w-]*/,
    component_name: () => /[A-Z][\w-]*/,
    line_id: () => /#[\w-]+/,
    id_name: () => token.immediate(prec(2, /#[\w-]+/)),

    _open_paren: () => token.immediate(prec(2, '(')),
    _expansion_marker: () => token.immediate(prec(2, /:[ \t]+/)),

    attributes: $ => seq(
      alias($._open_paren, '('),
      repeat(choice($.attribute, $.hole, ',', $._attribute_line_break)),
      ')',
    ),
    _attribute_line_break: () => /\r?\n/,

    attribute: $ => seq(
      $.attribute_name,
      optional($.modifiers),
      optional(seq('=', choice($.string, $.hole))),
    ),
    attribute_name: () => /[A-Z_@:][\w\-:.@]*/i,
    modifiers: () => token.immediate(/(\|[\w-]*)+/),
    string: () => choice(/"[^"]*"/, /'[^']*'/),

    // Text
    _text_part: $ => choice($.text, $.escape, $.hole, $.inline_element),
    text: () => /([^\n{\\#]|\\[^{#\n]|#[^\[\n])+|[\\#]/,
    escape: () => /\\[{#]/,

    inline_element: $ => seq(
      '#[',
      $._tag_head,
      optional($.attributes),
      repeat($._inline_part),
      ']',
    ),
    _inline_part: $ => choice(alias($.inline_text, $.text), $.escape, $.hole, $.inline_element),
    inline_text: () => /([^\n{\\#\]]|\\[^{#\n\]]|#[^\[\n\]])+|[\\#]/,

    hole: $ => seq('{', optional($.hole_content), '}'),

    identifier: () => /[A-Z_$][\w$]*/i,
  },
})
