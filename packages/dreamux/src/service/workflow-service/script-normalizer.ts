import {
  parse,
  type ArrayExpression,
  type ExportNamedDeclaration,
  type Expression,
  type Literal,
  type ObjectExpression,
  type Program,
  type Property,
  type VariableDeclaration,
} from 'acorn';

import { isRecord } from './run-support.js';

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
  const meta = readUltracodeMeta(metaExport);
  assertWorkflowMeta(meta);

  const body = program.body
    .filter((statement) => statement !== metaExport)
    .map((statement) => source.slice(statement.start, statement.end))
    .join('\n');
  const metaSource = source.slice(metaExport.start, metaExport.end);
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

function findUltracodeMetaExport(program: Program): ExportNamedDeclaration | null {
  let metaExport: ExportNamedDeclaration | null = null;
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      throw new Error('workflow imports are disabled');
    }
    if (
      statement.type !== 'ExportNamedDeclaration' &&
      statement.type !== 'ExportAllDeclaration'
    ) {
      continue;
    }
    const candidate = ultracodeMetaExport(statement);
    if (candidate === null || metaExport !== null) {
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
        (specifier) => exportedName(specifier.exported) === 'default',
      );
    }
    return statement.type === 'ExportAllDeclaration' &&
      statement.exported !== null &&
      exportedName(statement.exported) === 'default';
  });
}

function exportedName(
  exported:
    | { type: string; name?: string; value?: unknown }
    | null
    | undefined,
): string | null {
  if (exported === null || exported === undefined) return null;
  if (exported.type === 'Identifier') return exported.name ?? null;
  return typeof exported.value === 'string' ? exported.value : null;
}

function ultracodeMetaExport(
  statement: ExportNamedDeclaration | {
    type: 'ExportAllDeclaration';
  },
): ExportNamedDeclaration | null {
  if (
    statement.type !== 'ExportNamedDeclaration' ||
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
  const [declarator] = declaration.declarations;
  return declarator?.id.type === 'Identifier' &&
      declarator.id.name === 'meta' &&
      declarator.init !== null
    ? statement
    : null;
}

function readUltracodeMeta(
  statement: ExportNamedDeclaration,
): Record<string, unknown> {
  const declaration = statement.declaration as VariableDeclaration;
  const initializer = declaration.declarations[0]?.init;
  if (initializer === undefined || initializer === null) {
    throw new Error('workflow meta must be a plain literal object');
  }
  const value = readPlainLiteral(initializer);
  if (!isRecord(value)) {
    throw new Error('workflow meta must be a plain literal object');
  }
  return value;
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

function assertWorkflowMeta(
  value: Record<string, unknown>,
): void {
  if (typeof value.name !== 'string' || typeof value.description !== 'string') {
    throw new Error('workflow meta must include string name and description');
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== 'string') {
    throw new Error('workflow meta whenToUse must be a string');
  }
  if (value.phases === undefined) return;
  if (!Array.isArray(value.phases)) {
    throw new Error('workflow meta phases must be an array');
  }
  for (const phase of value.phases) assertWorkflowPhase(phase);
}

function assertWorkflowPhase(phase: unknown): void {
  if (typeof phase === 'string') return;
  if (!isRecord(phase) || typeof phase.title !== 'string') {
    throw new Error(
      'workflow meta phases must contain strings or objects with string title',
    );
  }
  for (const key of ['detail', 'model'] as const) {
    if (phase[key] !== undefined && typeof phase[key] !== 'string') {
      throw new Error(`workflow meta phase ${key} must be a string`);
    }
  }
}
