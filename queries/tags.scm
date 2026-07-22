(function_definition
  name: (identifier) @name) @definition.function

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (qualified_identifier
    name: (identifier) @name)) @reference.call

