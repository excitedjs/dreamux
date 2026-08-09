import {
  parse,
  type ArrayExpression,
  type ExportNamedDeclaration,
  type Expression,
  type Literal,
  type ObjectExpression,
  type Program,
  type Property,
} from 'acorn';

interface UltracodeMetaExport {
  statement: ExportNamedDeclaration;
  initializer: Expression;
}

/**
 * Normalize both supported workflow entry dialects to one default-exported
 * async entry function. Legacy modules already carrying a default export are
 * returned byte-for-byte unchanged.
 */
export function normalizeWorkflowScript(source: string): string {
  const program = parseWorkflowScript(source);
  if (hasDefaultExport(program)) return source;

  const metaExport = findUltracodeMetaExport(program);
  if (metaExport === null) {
    throw new Error('workflow script must export const meta');
  }
  validateUltracodeMeta(metaExport.initializer);

  const body = program.body
    .filter((statement) => statement !== metaExport.statement)
    .map((statement) => source.slice(statement.start, statement.end))
    .join('\n');
  const metaSource = source.slice(
    metaExport.statement.start,
    metaExport.statement.end,
  );
  return `${metaSource}\nexport default async function run() {\n${body}\n}\n`;
}

function parseWorkflowScript(source: string): Program {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
}

function findUltracodeMetaExport(program: Program): UltracodeMetaExport | null {
  let metaExport: UltracodeMetaExport | null = null;
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      throw new Error('workflow imports are disabled');
    }
    if (statement.type === 'ExportAllDeclaration') {
      throw new Error(
        'ultracode workflow scripts may only export const meta',
      );
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const candidate = ultracodeMetaExport(statement);
    if (candidate === null) {
      throw new Error(
        'ultracode workflow scripts may only export const meta',
      );
    }
    metaExport = candidate;
  }
  return metaExport;
}

function hasDefaultExport(program: Program): boolean {
  return program.body.some((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') return true;
    if (statement.type === 'ExportNamedDeclaration') {
      return statement.specifiers.some(
        (specifier) =>
          specifier.exported.type === 'Identifier'
            ? specifier.exported.name === 'default'
            : specifier.exported.value === 'default',
      );
    }
    return false;
  });
}

function ultracodeMetaExport(
  statement: ExportNamedDeclaration,
): UltracodeMetaExport | null {
  if (
    statement.specifiers.length !== 0 ||
    statement.source !== null ||
    statement.declaration?.type !== 'VariableDeclaration'
  ) {
    return null;
  }
  const declaration = statement.declaration;
  if (
    declaration.kind !== 'const' ||
    declaration.declarations.length !== 1
  ) {
    return null;
  }
  const declarator = declaration.declarations[0];
  if (
    declarator === undefined ||
    declarator.id.type !== 'Identifier' ||
    declarator.id.name !== 'meta' ||
    declarator.init === undefined ||
    declarator.init === null
  ) return null;
  return { statement, initializer: declarator.init };
}

function validateUltracodeMeta(
  initializer: Expression,
): void {
  if (initializer.type !== 'ObjectExpression') {
    validatePlainLiteral(initializer);
    throw new Error('workflow meta must be a plain literal object');
  }
  validateObjectLiteral(initializer);
}

function validatePlainLiteral(expression: Expression): void {
  switch (expression.type) {
    case 'Literal':
      validatePrimitiveLiteral(expression);
      return;
    case 'ArrayExpression':
      validateArrayLiteral(expression);
      return;
    case 'ObjectExpression':
      validateObjectLiteral(expression);
      return;
    default:
      throw new Error('workflow meta must be a recursively plain literal tree');
  }
}

function validatePrimitiveLiteral(literal: Literal): void {
  if (
    literal.regex !== undefined ||
    literal.bigint !== undefined ||
    !(
      literal.value === null ||
      typeof literal.value === 'string' ||
      typeof literal.value === 'number' ||
      typeof literal.value === 'boolean'
    )
  ) {
    throw new Error('workflow meta must be a recursively plain literal tree');
  }
}

function validateArrayLiteral(array: ArrayExpression): void {
  for (const element of array.elements) {
    if (element === null || element.type === 'SpreadElement') {
      throw new Error(
        'workflow meta must be a recursively plain literal tree',
      );
    }
    validatePlainLiteral(element);
  }
}

function validateObjectLiteral(object: ObjectExpression): void {
  for (const entry of object.properties) {
    if (entry.type === 'SpreadElement' || !isPlainProperty(entry)) {
      throw new Error(
        'workflow meta must be a recursively plain literal tree',
      );
    }
    validatePlainPropertyName(entry);
    validatePlainLiteral(entry.value);
  }
}

function isPlainProperty(entry: Property): entry is Property & {
  value: Expression;
} {
  return (
    entry.kind === 'init' &&
    !entry.method &&
    !entry.shorthand &&
    !entry.computed
  );
}

function validatePlainPropertyName(property: Property): void {
  if (property.key.type === 'Identifier') return;
  if (property.key.type === 'Literal') {
    validatePrimitiveLiteral(property.key);
    if (
      typeof property.key.value === 'string' ||
      typeof property.key.value === 'number'
    ) return;
  }
  throw new Error('workflow meta object keys must be non-computed literals');
}
