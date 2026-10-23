// The external scanner of the kay grammar: the layout of the indentation-based template, the code spans embedded in it and the shorthand class names.
// src/compiler/parser.ts is the reference for what each span covers.
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
  FENCE_BODY,
  STYLE_BODY,
  FENCE_CLOSE,
  HOLE_CONTENT,
  PAREN_CONTENT,
  BRACKET_CONTENT,
  EXPRESSION,
  CONDITION,
  AWAIT_EXPRESSION,
  EACH_EXPRESSION,
  CLASS_NAME,
  MARKDOWN_BODY,
  ERROR_SENTINEL,
};

#define MAX_INDENTS 100
#define MAX_NESTING 64

typedef struct {
  uint16_t count;
  uint16_t indents[MAX_INDENTS];
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_space(int32_t c) { return c == ' ' || c == '\t'; }

static inline bool at_line_end(TSLexer *lexer) { return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r'; }

static inline bool is_word(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; }

static inline bool is_identifier_start(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'; }

static inline bool is_digit(int32_t c) { return c >= '0' && c <= '9'; }

// Consumes the line break at the cursor, a `\r\n` included.
static void consume_line_break(TSLexer *lexer) {
  if (lexer->lookahead == '\r') advance(lexer);
  if (lexer->lookahead == '\n') advance(lexer);
}

// Code scanning: strings, template literals and comments are skipped as units, so a bracket or a `---` inside them means nothing.
// The depth keeps counting past the stored kinds, so the closers of a deeper nesting still balance its openers. Only the kind of a level past MAX_NESTING is lost, read as a plain bracket.
typedef struct {
  char stack[MAX_NESTING];
  int depth;
} Nesting;

static void push(Nesting *nesting, char kind) {
  if (nesting->depth < MAX_NESTING) nesting->stack[nesting->depth] = kind;
  nesting->depth++;
}

static void skip_string(TSLexer *lexer) {
  int32_t quote = lexer->lookahead;

  advance(lexer);

  while (!lexer->eof(lexer) && lexer->lookahead != quote && lexer->lookahead != '\n') {
    if (lexer->lookahead == '\\') advance(lexer);
    if (!lexer->eof(lexer) && lexer->lookahead != '\n') advance(lexer);
  }

  if (lexer->lookahead == quote) advance(lexer);
}

// Consumes a `//` or `/* */` comment at a `/`, or the `/` alone when none follows.
static void skip_slash(TSLexer *lexer) {
  advance(lexer);

  if (lexer->lookahead == '/') {
    while (!at_line_end(lexer)) advance(lexer);
  } else if (lexer->lookahead == '*') {
    advance(lexer);

    while (!lexer->eof(lexer)) {
      if (lexer->lookahead == '*') {
        advance(lexer);

        if (lexer->lookahead == '/') {
          advance(lexer);
          return;
        }
      } else {
        advance(lexer);
      }
    }
  }
}

// One lexical unit of code. `brackets` counts ( [ { in code; without it only the braces of a `${` do.
static void step_code(TSLexer *lexer, Nesting *nesting, bool brackets) {
  int32_t c = lexer->lookahead;
  char top = nesting->depth > 0 ? (nesting->depth <= MAX_NESTING ? nesting->stack[nesting->depth - 1] : '{') : 0;

  if (top == '`') {
    if (c == '\\') {
      advance(lexer);
      if (!lexer->eof(lexer)) advance(lexer);
    } else if (c == '`') {
      nesting->depth--;
      advance(lexer);
    } else if (c == '$') {
      advance(lexer);

      if (lexer->lookahead == '{') {
        push(nesting, '{');
        advance(lexer);
      }
    } else {
      advance(lexer);
    }

    return;
  }

  if (c == '"' || c == '\'') {
    skip_string(lexer);
  } else if (c == '`') {
    push(nesting, '`');
    advance(lexer);
  } else if (c == '/') {
    skip_slash(lexer);
  } else if (c == '{' || ((c == '(' || c == '[') && brackets)) {
    if (brackets || nesting->depth > 0) push(nesting, (char)c);
    advance(lexer);
  } else if (c == '}' || ((c == ')' || c == ']') && brackets)) {
    if (nesting->depth > 0) nesting->depth--;
    advance(lexer);
  } else {
    advance(lexer);
  }
}

// Scans up to the closer that nothing opened, left unconsumed.
static bool scan_balanced(TSLexer *lexer, int32_t closer) {
  Nesting nesting = {.depth = 0};
  bool any = false;

  lexer->mark_end(lexer);

  while (!lexer->eof(lexer)) {
    if (nesting.depth == 0 && lexer->lookahead == closer) break;
    if (nesting.depth == 0 && (lexer->lookahead == ')' || lexer->lookahead == ']' || lexer->lookahead == '}')) {
      advance(lexer);
      any = true;
      lexer->mark_end(lexer);

      continue;
    }

    step_code(lexer, &nesting, true);
    any = true;
    lexer->mark_end(lexer);
  }

  return any;
}

typedef enum { CUT_NONE, CUT_AS, CUT_THEN, CUT_KEY } Cut;

// A word and what may follow it decide a cut: ` as name` ends a condition, ` then name` an await and ` key={` a for.
static bool cut_follows(TSLexer *lexer, Cut cut, const char *word, int length) {
  if (cut == CUT_AS && !(length == 2 && strncmp(word, "as", 2) == 0)) return false;
  if (cut == CUT_THEN && !(length == 4 && strncmp(word, "then", 4) == 0)) return false;
  if (cut == CUT_KEY) return length == 3 && strncmp(word, "key", 3) == 0 && lexer->lookahead == '=';

  while (is_space(lexer->lookahead)) advance(lexer);

  if (at_line_end(lexer)) return cut == CUT_THEN;
  if (!is_identifier_start(lexer->lookahead)) return false;
  if (cut == CUT_AS && !(lexer->lookahead >= 'a' && lexer->lookahead <= 'z') && lexer->lookahead != '_' && lexer->lookahead != '$') return false;

  while (is_word(lexer->lookahead) || lexer->lookahead == '$') advance(lexer);
  while (is_space(lexer->lookahead)) advance(lexer);

  return at_line_end(lexer);
}

// Scans the rest of the line, brackets spanning lines included, stopping before the trailing keyword `cut` names.
static bool scan_line(TSLexer *lexer, Cut cut) {
  Nesting nesting = {.depth = 0};
  bool any = false;

  while (is_space(lexer->lookahead)) skip(lexer);
  if (at_line_end(lexer)) return false;

  lexer->mark_end(lexer);

  while (!lexer->eof(lexer)) {
    if (nesting.depth == 0 && at_line_end(lexer)) break;

    if (nesting.depth == 0 && cut != CUT_NONE && is_space(lexer->lookahead)) {
      lexer->mark_end(lexer);
      while (is_space(lexer->lookahead)) advance(lexer);

      if (at_line_end(lexer)) return any;

      char word[8];
      int length = 0;

      while (is_word(lexer->lookahead) && length < 7) {
        word[length++] = (char)lexer->lookahead;
        advance(lexer);
      }

      if (!is_word(lexer->lookahead) && cut_follows(lexer, cut, word, length)) return any;

      continue;
    }

    step_code(lexer, &nesting, true);
    any = true;
    lexer->mark_end(lexer);
  }

  lexer->mark_end(lexer);

  return any;
}

// A `.class`, as src/compiler/class-name.ts reads it: word characters, `:`, `/`, `@`, `!`, `*`, a decimal dot, a `[...]` group and a `(...)` group right after a `-`.
static bool is_plain(int32_t c) { return is_word(c) || c == '-' || c == ':' || c == '/' || c == '@' || c == '!' || c == '*'; }

// Consumes a group opened at the cursor and returns whether it closed before a space.
static bool scan_class_group(TSLexer *lexer) {
  int32_t opener = lexer->lookahead;
  int32_t closer = opener == '[' ? ']' : ')';
  int depth = 0;
  int32_t previous = 0;
  int32_t quote = 0;

  while (!lexer->eof(lexer) && !at_line_end(lexer) && !is_space(lexer->lookahead)) {
    int32_t c = lexer->lookahead;

    if (quote != 0) {
      if (c == quote) quote = 0;
    } else if ((c == '\'' || c == '"') && !is_word(previous)) {
      quote = c;
    } else if (c == opener) {
      depth++;
    } else if (c == closer && --depth == 0) {
      advance(lexer);

      return true;
    }

    previous = c;
    advance(lexer);
  }

  return false;
}

static bool scan_class(TSLexer *lexer) {
  if (lexer->lookahead != '.') return false;

  advance(lexer);

  int32_t previous = '.';
  bool any = false;

  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;

    if (is_plain(c)) {
      advance(lexer);
      previous = c;
      any = true;

      // A trailing `: ` opens a block expansion, so the colon stays out of the class.
      if (c == ':' && (is_space(lexer->lookahead) || at_line_end(lexer))) break;

      lexer->mark_end(lexer);
    } else if (c == '.' && is_digit(previous)) {
      advance(lexer);

      if (!is_digit(lexer->lookahead)) break;

      while (is_digit(lexer->lookahead)) advance(lexer);

      if (is_word(lexer->lookahead)) break;

      previous = '0';
      any = true;
      lexer->mark_end(lexer);
    } else if (c == '[' || (c == '(' && previous == '-')) {
      scan_class_group(lexer);
      previous = ']';
      any = true;
      lexer->mark_end(lexer);
    } else {
      break;
    }
  }

  return any;
}

// A line of three dashes closes a fence, and one with a lowercase word or `<` after them opens the next.
typedef enum { LINE_OTHER, LINE_CLOSE, LINE_OPEN } FenceLine;

static FenceLine read_fence_line(TSLexer *lexer) {
  int dashes = 0;

  while (lexer->lookahead == '-' && dashes < 3) {
    advance(lexer);
    dashes++;
  }

  if (dashes < 3) return LINE_OTHER;

  while (is_space(lexer->lookahead)) advance(lexer);

  if (at_line_end(lexer)) return LINE_CLOSE;
  if ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') || lexer->lookahead == '<') return LINE_OPEN;

  return LINE_OTHER;
}

// Consumes the line break and the blank lines after it, ending the token at the start of the next line with content.
static void consume_blank_lines(TSLexer *lexer) {
  consume_line_break(lexer);
  lexer->mark_end(lexer);

  while (true) {
    while (is_space(lexer->lookahead)) advance(lexer);

    if (lexer->eof(lexer)) {
      lexer->mark_end(lexer);

      return;
    }

    if (lexer->lookahead != '\n' && lexer->lookahead != '\r') return;

    consume_line_break(lexer);
    lexer->mark_end(lexer);
  }
}

// The body of a fence, or the line closing it when the fence has no body left.
static bool scan_fence(TSLexer *lexer, const bool *valid, bool css) {
  Nesting nesting = {.depth = 0};
  bool body = valid[css ? STYLE_BODY : FENCE_BODY];
  bool any = false;

  while (true) {
    bool line_start = lexer->get_column(lexer) == 0;

    if (line_start && (css || nesting.depth == 0)) {
      lexer->mark_end(lexer);

      if (lexer->lookahead == '-') {
        FenceLine kind = read_fence_line(lexer);

        if (kind == LINE_CLOSE && !any && valid[FENCE_CLOSE]) {
          consume_blank_lines(lexer);
          lexer->result_symbol = FENCE_CLOSE;

          return true;
        }

        if (kind != LINE_OTHER) {
          lexer->result_symbol = css ? STYLE_BODY : FENCE_BODY;

          return any && body;
        }

        any = true;

        continue;
      }
    }

    if (!body || lexer->eof(lexer)) break;

    if (css) advance(lexer);
    else step_code(lexer, &nesting, false);

    any = true;
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = css ? STYLE_BODY : FENCE_BODY;

  return any && body;
}

// The lines under `markdown`, up to the first one that is not indented deeper.
static bool scan_markdown(TSLexer *lexer, uint16_t parent, uint16_t first_indent) {
  uint16_t indent = first_indent;

  while (true) {
    while (!at_line_end(lexer)) advance(lexer);

    consume_line_break(lexer);
    lexer->mark_end(lexer);

    while (true) {
      indent = 0;

      while (is_space(lexer->lookahead)) {
        advance(lexer);
        indent++;
      }

      if (lexer->lookahead == '\r' || lexer->lookahead == '\n') {
        consume_line_break(lexer);

        continue;
      }

      break;
    }

    if (lexer->eof(lexer)) {
      lexer->mark_end(lexer);

      return true;
    }

    if (indent <= parent) return true;
  }
}

static bool scan_layout(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  uint16_t top = scanner->indents[scanner->count - 1];
  bool line_start = lexer->get_column(lexer) == 0;
  uint16_t indent = 0;

  // A markdown body keeps the indentation of its first line, any other token starts after it.
  bool keep = valid[MARKDOWN_BODY];

  if (keep) lexer->mark_end(lexer);

  while (is_space(lexer->lookahead)) {
    if (keep) advance(lexer);
    else skip(lexer);

    indent++;
  }

  if (!keep) lexer->mark_end(lexer);

  if (lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r') {
    if (valid[NEWLINE]) {
      if (!lexer->eof(lexer)) consume_blank_lines(lexer);
      else lexer->mark_end(lexer);

      lexer->result_symbol = NEWLINE;

      return true;
    }

    if (!lexer->eof(lexer) || !valid[DEDENT] || top == 0) return false;

    scanner->count--;
    lexer->result_symbol = DEDENT;

    return true;
  }

  if (!line_start) return false;

  if (valid[MARKDOWN_BODY] && indent > top) {
    scan_markdown(lexer, top, indent);
    lexer->result_symbol = MARKDOWN_BODY;

    return true;
  }

  if (indent > top && valid[INDENT] && scanner->count < MAX_INDENTS) {
    scanner->indents[scanner->count++] = indent;
    lexer->result_symbol = INDENT;

    return true;
  }

  if (indent < top && valid[DEDENT]) {
    scanner->count--;
    lexer->result_symbol = DEDENT;

    return true;
  }

  // A line starting with a class, such as `.box`, is an element without a tag.
  if (valid[CLASS_NAME] && lexer->lookahead == '.') {
    lexer->result_symbol = CLASS_NAME;

    return scan_class(lexer);
  }

  return false;
}

void *tree_sitter_kay_external_scanner_create(void) {
  Scanner *scanner = calloc(1, sizeof(Scanner));

  scanner->count = 1;

  return scanner;
}

void tree_sitter_kay_external_scanner_destroy(void *payload) { free(payload); }

unsigned tree_sitter_kay_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = payload;
  unsigned size = 0;

  for (uint16_t i = 1; i < scanner->count; i++) {
    buffer[size++] = (char)(scanner->indents[i] & 0xff);
    buffer[size++] = (char)(scanner->indents[i] >> 8);
  }

  return size;
}

void tree_sitter_kay_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *scanner = payload;

  scanner->count = 1;
  scanner->indents[0] = 0;

  for (unsigned i = 0; i + 1 < length && scanner->count < MAX_INDENTS; i += 2) {
    scanner->indents[scanner->count++] = (uint16_t)((uint8_t)buffer[i] | ((uint8_t)buffer[i + 1] << 8));
  }
}

bool tree_sitter_kay_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid) {
  Scanner *scanner = payload;

  if (valid[ERROR_SENTINEL]) return false;

  if (valid[HOLE_CONTENT]) {
    lexer->result_symbol = HOLE_CONTENT;

    return scan_balanced(lexer, '}');
  }

  if (valid[PAREN_CONTENT]) {
    lexer->result_symbol = PAREN_CONTENT;

    return scan_balanced(lexer, ')');
  }

  if (valid[BRACKET_CONTENT]) {
    lexer->result_symbol = BRACKET_CONTENT;

    return scan_balanced(lexer, ']');
  }

  if (valid[EXPRESSION]) {
    lexer->result_symbol = EXPRESSION;

    return scan_line(lexer, CUT_NONE);
  }

  if (valid[CONDITION]) {
    lexer->result_symbol = CONDITION;

    return scan_line(lexer, CUT_AS);
  }

  if (valid[AWAIT_EXPRESSION]) {
    lexer->result_symbol = AWAIT_EXPRESSION;

    return scan_line(lexer, CUT_THEN);
  }

  if (valid[EACH_EXPRESSION]) {
    lexer->result_symbol = EACH_EXPRESSION;

    return scan_line(lexer, CUT_KEY);
  }

  // A fence that may have a body takes the line before a class can, as the body may start with a dot.
  if ((valid[FENCE_BODY] || valid[STYLE_BODY]) && lexer->get_column(lexer) == 0) return scan_fence(lexer, valid, valid[STYLE_BODY]);

  if (valid[CLASS_NAME] && lexer->lookahead == '.') {
    lexer->result_symbol = CLASS_NAME;

    return scan_class(lexer);
  }

  if (valid[FENCE_CLOSE] && lexer->lookahead == '-' && lexer->get_column(lexer) == 0) return scan_fence(lexer, valid, false);

  if (valid[NEWLINE] || valid[INDENT] || valid[DEDENT] || valid[MARKDOWN_BODY]) return scan_layout(scanner, lexer, valid);

  return false;
}
