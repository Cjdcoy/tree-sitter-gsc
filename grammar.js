/**
 * @file Tree-sitter grammar for Call of Duty GSC
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  ASSIGNMENT: 1,
  TERNARY: 2,
  OR: 3,
  AND: 4,
  BIT_OR: 5,
  BIT_XOR: 6,
  BIT_AND: 7,
  EQUALITY: 8,
  RELATIONAL: 9,
  SHIFT: 10,
  ADD: 11,
  MULTIPLY: 12,
  UNARY: 13,
  CALL: 14,
  MEMBER: 15,
  UPDATE: 16,
};

module.exports = grammar({
  name: 'gsc',

  word: $ => $.identifier,

  extras: $ => [
    /\s/,
    $.comment,
  ],

  supertypes: $ => [
    $._statement,
    $._expression,
  ],

  conflicts: $ => [
    [$.function_definition, $._callable],
  ],

  rules: {
    source_file: $ => repeat($._top_level_item),

    _top_level_item: $ => choice(
      $.preproc_include,
      $.preproc_using_animtree,
      $.preproc_animtree,
      $.function_definition,
      $.developer_block,
    ),

    preproc_include: $ => seq(
      '#include',
      field('path', choice($.path, $.identifier)),
      ';',
    ),

    preproc_using_animtree: $ => seq(
      '#using_animtree',
      field('arguments', $.argument_list),
      ';',
    ),

    preproc_animtree: $ => seq(
      '#animtree',
      optional(field('value', choice($.identifier, $.string))),
      ';',
    ),

    developer_block: $ => seq(
      '/#',
      repeat(choice(
        $.preproc_include,
        $.preproc_using_animtree,
        $.preproc_animtree,
        $.function_definition,
        $._statement,
      )),
      '#/',
    ),

    function_definition: $ => seq(
      field('name', $.identifier),
      field('parameters', $.parameter_list),
      field('body', $.block),
    ),

    parameter_list: $ => seq(
      '(',
      optional(seq(
        $.identifier,
        repeat(seq(',', $.identifier)),
        optional(','),
      )),
      ')',
    ),

    block: $ => seq(
      '{',
      repeat($._statement),
      '}',
    ),

    _statement: $ => choice(
      $.block,
      $.empty_statement,
      $.expression_statement,
      $.if_statement,
      $.switch_statement,
      $.while_statement,
      $.do_statement,
      $.for_statement,
      $.return_statement,
      $.break_statement,
      $.continue_statement,
      $.wait_statement,
      $.waittillframeend_statement,
      $.developer_block,
    ),

    empty_statement: _ => ';',

    expression_statement: $ => seq($._expression, ';'),

    if_statement: $ => prec.right(seq(
      'if',
      field('condition', $.parenthesized_expression),
      field('consequence', $._statement),
      optional(seq('else', field('alternative', $._statement))),
    )),

    switch_statement: $ => seq(
      'switch',
      field('value', $.parenthesized_expression),
      '{',
      repeat(choice($.case_clause, $.default_clause)),
      '}',
    ),

    case_clause: $ => seq(
      'case',
      field('value', $._expression),
      ':',
      repeat($._statement),
    ),

    default_clause: $ => seq(
      'default',
      ':',
      repeat($._statement),
    ),

    while_statement: $ => seq(
      'while',
      field('condition', $.parenthesized_expression),
      field('body', $._statement),
    ),

    do_statement: $ => seq(
      'do',
      field('body', $._statement),
      'while',
      field('condition', $.parenthesized_expression),
      ';',
    ),

    for_statement: $ => seq(
      'for',
      '(',
      field('initializer', optional($._expression)),
      ';',
      field('condition', optional($._expression)),
      ';',
      field('update', optional($._expression)),
      ')',
      field('body', $._statement),
    ),

    return_statement: $ => seq('return', optional($._expression), ';'),
    break_statement: _ => seq('break', ';'),
    continue_statement: _ => seq('continue', ';'),
    wait_statement: $ => seq('wait', field('duration', $._expression), ';'),
    waittillframeend_statement: _ => seq('waittillframeend', ';'),

    _expression: $ => choice(
      $.assignment_expression,
      $.ternary_expression,
      $.binary_expression,
      $.unary_expression,
      $.update_expression,
      $.call_expression,
      $.member_expression,
      $.subscript_expression,
      $.parenthesized_expression,
      $.vector,
      $.array,
      $.function_reference,
      $.identifier,
      $.number,
      $.string,
      $.localized_string,
      $.cvar_string,
      $.animation,
      $.boolean,
      $.undefined,
    ),

    assignment_expression: $ => prec.right(PREC.ASSIGNMENT, seq(
      field('left', choice(
        $.identifier,
        $.member_expression,
        $.subscript_expression,
      )),
      field('operator', choice(
        '=', '+=', '-=', '*=', '/=', '%=',
        '|=', '&=', '^=', '<<=', '>>=',
      )),
      field('right', $._expression),
    )),

    ternary_expression: $ => prec.right(PREC.TERNARY, seq(
      field('condition', $._expression),
      '?',
      field('consequence', $._expression),
      ':',
      field('alternative', $._expression),
    )),

    binary_expression: $ => choice(
      ...[
        ['||', PREC.OR],
        ['&&', PREC.AND],
        ['|', PREC.BIT_OR],
        ['^', PREC.BIT_XOR],
        ['&', PREC.BIT_AND],
        ['==', PREC.EQUALITY],
        ['!=', PREC.EQUALITY],
        ['<', PREC.RELATIONAL],
        ['<=', PREC.RELATIONAL],
        ['>', PREC.RELATIONAL],
        ['>=', PREC.RELATIONAL],
        ['<<', PREC.SHIFT],
        ['>>', PREC.SHIFT],
        ['+', PREC.ADD],
        ['-', PREC.ADD],
        ['*', PREC.MULTIPLY],
        ['/', PREC.MULTIPLY],
        ['%', PREC.MULTIPLY],
      ].map(([operator, precedence]) =>
        prec.left(precedence, seq(
          field('left', $._expression),
          field('operator', operator),
          field('right', $._expression),
        )),
      ),
    ),

    unary_expression: $ => prec.right(PREC.UNARY, seq(
      field('operator', choice('!', '~', '+', '-')),
      field('argument', $._expression),
    )),

    update_expression: $ => choice(
      prec(PREC.UPDATE, seq(
        field('argument', choice($.identifier, $.member_expression, $.subscript_expression)),
        field('operator', choice('++', '--')),
      )),
      prec(PREC.UPDATE, seq(
        field('operator', choice('++', '--')),
        field('argument', choice($.identifier, $.member_expression, $.subscript_expression)),
      )),
    ),

    call_expression: $ => choice(
      prec(PREC.CALL, seq(
        optional(field('thread', 'thread')),
        field('function', $._callable),
        field('arguments', $.argument_list),
      )),
      prec.left(PREC.CALL, seq(
        field('object', $._receiver_expression),
        optional(field('thread', 'thread')),
        field('function', $._callable),
        field('arguments', $.argument_list),
      )),
    ),

    _receiver_expression: $ => choice(
      $.identifier,
      $.member_expression,
      $.subscript_expression,
      $.parenthesized_expression,
      $.call_expression,
    ),

    _callable: $ => choice(
      $.identifier,
      $.qualified_identifier,
      $.function_pointer,
    ),

    argument_list: $ => seq(
      '(',
      optional(seq(
        $._expression,
        repeat(seq(',', $._expression)),
        optional(','),
      )),
      ')',
    ),

    member_expression: $ => prec.left(PREC.MEMBER, seq(
      field('object', $._expression),
      '.',
      field('property', $.identifier),
    )),

    subscript_expression: $ => prec.left(PREC.MEMBER, seq(
      field('object', $._expression),
      '[',
      field('index', $._expression),
      ']',
    )),

    parenthesized_expression: $ => seq('(', $._expression, ')'),

    vector: $ => seq(
      '(',
      field('x', $._expression),
      ',',
      field('y', $._expression),
      ',',
      field('z', $._expression),
      ')',
    ),

    array: $ => seq(
      '[',
      optional(seq(
        $._expression,
        repeat(seq(',', $._expression)),
        optional(','),
      )),
      ']',
    ),

    function_reference: $ => seq(
      optional(field('path', choice($.path, $.identifier))),
      '::',
      field('name', $.identifier),
    ),

    qualified_identifier: $ => seq(
      field('path', choice($.path, $.identifier)),
      '::',
      field('name', $.identifier),
    ),

    function_pointer: $ => seq(
      '[[',
      field('value', $._expression),
      ']]',
    ),

    path: $ => seq(
      $.identifier,
      repeat1(seq('\\', $.identifier)),
    ),

    boolean: _ => choice('true', 'false'),
    undefined: _ => 'undefined',

    number: _ => token(choice(
      /0[xX][0-9a-fA-F]+/,
      /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?/,
      /\d+[eE][+-]?\d+/,
      /\d+/,
    )),

    string: _ => token(seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),
    localized_string: _ => token(seq('&"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),
    cvar_string: _ => token(seq('#"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),
    animation: _ => token(/%[A-Za-z_][A-Za-z0-9_]*/),

    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    comment: _ => token(choice(
      seq('//', /[^\n]*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),
  },
});
