(comment) @comment

[
  "#include"
  "#using_animtree"
  "#animtree"
] @keyword.directive

[
  "if"
  "else"
  "switch"
  "case"
  "default"
  "while"
  "do"
  "for"
  "return"
  "break"
  "continue"
  "wait"
  "waittillframeend"
  "thread"
] @keyword

(function_definition name: (identifier) @function)
(call_expression function: (identifier) @function.call)
(qualified_identifier name: (identifier) @function.call)
(function_reference name: (identifier) @function)
(parameter_list (identifier) @variable.parameter)
(member_expression property: (identifier) @property)

(identifier) @variable
(path) @module
(number) @number
(string) @string
(localized_string) @string.special
(cvar_string) @string.special
(animation) @string.special
(boolean) @constant.builtin
(undefined) @constant.builtin

[
  "=" "+=" "-=" "*=" "/=" "%=" "|=" "&=" "^=" "<<=" ">>="
  "||" "&&" "|" "^" "&" "==" "!=" "<" "<=" ">" ">=" "<<" ">>"
  "+" "-" "*" "/" "%" "!" "~" "++" "--" "?" ":"
] @operator

