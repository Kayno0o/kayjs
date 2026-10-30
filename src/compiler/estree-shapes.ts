// The node-type groups kay's scope pass reads, named as the oxc AST (ESTree with TypeScript nodes) names the types.
// They follow the groups of the scope rules of `@babel/traverse`, which the scope pass reproduces.

const group = (...types: string[]): ReadonlySet<string> => new Set(types)

// The node types that make a scope.
export const SCOPABLE_TYPES = group('BlockStatement', 'CatchClause', 'DoWhileStatement', 'ForInStatement', 'ForStatement', 'FunctionDeclaration', 'FunctionExpression', 'Program', 'SwitchStatement', 'WhileStatement', 'ArrowFunctionExpression', 'ClassExpression', 'ClassDeclaration', 'ForOfStatement', 'StaticBlock', 'TSModuleBlock')

// The scopes a block scoped declaration can land in.
export const BLOCK_PARENT_TYPES = group('BlockStatement', 'CatchClause', 'DoWhileStatement', 'ForInStatement', 'ForStatement', 'FunctionDeclaration', 'FunctionExpression', 'Program', 'SwitchStatement', 'WhileStatement', 'ArrowFunctionExpression', 'ForOfStatement', 'StaticBlock', 'TSModuleBlock')

// The scopes a `var` can land in.
export const FUNCTION_PARENT_TYPES = group('FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'StaticBlock', 'TSModuleBlock')

export const FUNCTION_TYPES = group('FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression')

export const PATTERN_TYPES = group('AssignmentPattern', 'ArrayPattern', 'ObjectPattern')

export const STATEMENT_TYPES = group('BlockStatement', 'BreakStatement', 'ContinueStatement', 'DebuggerStatement', 'DoWhileStatement', 'EmptyStatement', 'ExpressionStatement', 'ForInStatement', 'ForStatement', 'FunctionDeclaration', 'IfStatement', 'LabeledStatement', 'ReturnStatement', 'SwitchStatement', 'ThrowStatement', 'TryStatement', 'VariableDeclaration', 'WhileStatement', 'WithStatement', 'ClassDeclaration', 'ExportAllDeclaration', 'ExportDefaultDeclaration', 'ExportNamedDeclaration', 'ForOfStatement', 'ImportDeclaration', 'TSDeclareFunction', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSImportEqualsDeclaration', 'TSExportAssignment', 'TSNamespaceExportDeclaration')

export const TS_TYPES = group('TSAnyKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword', 'TSIntrinsicKeyword', 'TSNeverKeyword', 'TSNullKeyword', 'TSNumberKeyword', 'TSObjectKeyword', 'TSStringKeyword', 'TSSymbolKeyword', 'TSUndefinedKeyword', 'TSUnknownKeyword', 'TSVoidKeyword', 'TSThisType', 'TSFunctionType', 'TSConstructorType', 'TSTypeReference', 'TSTypePredicate', 'TSTypeQuery', 'TSTypeLiteral', 'TSArrayType', 'TSTupleType', 'TSOptionalType', 'TSRestType', 'TSUnionType', 'TSIntersectionType', 'TSConditionalType', 'TSInferType', 'TSParenthesizedType', 'TSTypeOperator', 'TSIndexedAccessType', 'TSMappedType', 'TSTemplateLiteralType', 'TSLiteralType', 'TSClassImplements', 'TSInterfaceHeritage', 'TSImportType')

export const LOOP_TYPES = group('DoWhileStatement', 'ForInStatement', 'ForStatement', 'WhileStatement', 'ForOfStatement')

// The names `Scope#hasBinding` takes as declared without a declaration, which are the `Scope.globals` and `Scope.contextVariables` of @babel/traverse.
export const BUILTIN_GLOBALS: ReadonlySet<string> = new Set(['decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape', 'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'arguments'])
