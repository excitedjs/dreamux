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

interface WorkflowMetaExport {
  statement: ExportNamedDeclaration;
  initializer: Expression;
}

/**
 * Compile the single public Workflow dialect into one private async closure.
 * The metadata source range is replaced with syntax + whitespace that preserves
 * every executable body line number from the submitted source.
 */
export function compileWorkflowScript(source: string): string {
  const program = parseWorkflowScript(source);
  rejectImports(program);
  const metaExport = workflowMetaExport(program.body[0]);
  if (metaExport === null) {
    throw new Error(
      'workflow script must start with export const meta',
    );
  }
  validateWorkflowMeta(readPlainLiteralObject(metaExport.initializer));
  rejectBodyExports(program);

  const removedMeta = source.slice(0, metaExport.statement.end);
  const paddedPrefix = privateClosurePrefix(removedMeta);
  return `${paddedPrefix}${source.slice(metaExport.statement.end)}\n})()`;
}

function privateClosurePrefix(removedMeta: string): string {
  const lines = removedMeta.split(/(\r\n|\r|\n)/);
  const strictOpening = 'async function(){"use strict";';
  const contentIndexes = lines
    .map((_line, index) => index)
    .filter((index) => index % 2 === 0);
  const firstContentIndex = contentIndexes[0]!;
  const lastContentIndex = contentIndexes.at(-1)!;
  if (firstContentIndex === lastContentIndex) {
    const line = lines[firstContentIndex]!;
    const prefix = `(${strictOpening}`;
    return prefix + ' '.repeat(line.length - prefix.length);
  }
  return lines.map((line, index) => {
    if (index % 2 === 1) return line;
    if (index === firstContentIndex) {
      return `(${' '.repeat(Math.max(0, line.length - 1))}`;
    }
    if (index === lastContentIndex) return strictOpening;
    return ' '.repeat(line.length);
  }).join('');
}

function parseWorkflowScript(source: string): Program {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
}

function rejectImports(program: Program): void {
  if (program.body.some((statement) => statement.type === 'ImportDeclaration')) {
    throw new Error('workflow imports are disabled');
  }
}

function rejectBodyExports(program: Program): void {
  for (const statement of program.body.slice(1)) {
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration' ||
      statement.type === 'ExportAllDeclaration'
    ) {
      throw new Error('workflow scripts may only export const meta');
    }
  }
}

function workflowMetaExport(
  statement: Program['body'][number] | undefined,
): WorkflowMetaExport | null {
  if (
    statement?.type !== 'ExportNamedDeclaration' ||
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
  const declarator = declaration.declarations[0]!;
  if (
    declarator.id.type !== 'Identifier' ||
    declarator.id.name !== 'meta'
  ) {
    return null;
  }
  return { statement, initializer: declarator.init! };
}

function readPlainLiteralObject(
  initializer: Expression,
): Record<string, unknown> {
  if (initializer.type !== 'ObjectExpression') {
    readPlainLiteral(initializer);
    throw new Error('workflow meta must be a plain literal object');
  }
  return readObjectLiteral(initializer);
}

function readPlainLiteral(expression: Expression): unknown {
  switch (expression.type) {
    case 'Literal':
      return readPrimitiveLiteral(expression);
    case 'ArrayExpression':
      return readArrayLiteral(expression);
    case 'ObjectExpression':
      return readObjectLiteral(expression);
    default:
      throw new Error('workflow meta must be a recursively plain literal tree');
  }
}

function readPrimitiveLiteral(literal: Literal): unknown {
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
  return literal.value;
}

function readArrayLiteral(array: ArrayExpression): unknown[] {
  return array.elements.map((element) => {
    if (element === null || element.type === 'SpreadElement') {
      throw new Error(
        'workflow meta must be a recursively plain literal tree',
      );
    }
    return readPlainLiteral(element);
  });
}

function readObjectLiteral(object: ObjectExpression): Record<string, unknown> {
  const value: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const entry of object.properties) {
    if (entry.type === 'SpreadElement' || !isPlainProperty(entry)) {
      throw new Error(
        'workflow meta must be a recursively plain literal tree',
      );
    }
    value[plainPropertyName(entry)] = readPlainLiteral(entry.value);
  }
  return value;
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

function plainPropertyName(property: Property): string {
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') {
    const key = readPrimitiveLiteral(property.key);
    if (typeof key === 'string' || typeof key === 'number') return String(key);
  }
  throw new Error('workflow meta object keys must be non-computed literals');
}

function validateWorkflowMeta(meta: Record<string, unknown>): void {
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new Error('workflow meta must include string name and description');
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
    throw new Error('workflow meta whenToUse must be a string');
  }
  if (meta.phases === undefined) return;
  if (!Array.isArray(meta.phases)) {
    throw new Error('workflow meta phases must be an array of objects');
  }
  for (const phase of meta.phases) validateWorkflowPhase(phase);
}

function validateWorkflowPhase(phase: unknown): void {
  if (
    typeof phase !== 'object' ||
    phase === null ||
    Array.isArray(phase)
  ) {
    throw new Error('workflow meta phases must contain objects with string title');
  }
  const record = phase as Record<string, unknown>;
  if (typeof record.title !== 'string') {
    throw new Error('workflow meta phases must contain objects with string title');
  }
  for (const key of ['detail', 'model'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new Error(`workflow meta phase ${key} must be a string`);
    }
  }
}
