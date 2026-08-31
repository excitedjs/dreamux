/**
 * Structural (AST) queries over this package's own source.
 *
 * A handful of architectural contracts are *absences* or *single-owner* claims
 * that no runtime value can express: "this capability has exactly one call
 * site", "this layer never imports that one". Those need a static check — but a
 * static check on the parsed program, not on the file's text. Text matching
 * fires on comments and string literals, misses a renamed import, and breaks on
 * behavior-preserving reformatting; the queries below read the real TypeScript
 * AST, so they mean what they say.
 *
 * Everything here is read-only and test-scoped. Nothing in `src/**` depends on
 * it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export async function parseSource(source: URL): Promise<ts.SourceFile> {
  const path = fileURLToPath(source);
  return ts.createSourceFile(
    path,
    await readFile(path, 'utf8'),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** Every `.ts` file directly inside `dir`, parsed. */
export async function parseDirectory(dir: URL): Promise<ts.SourceFile[]> {
  const entries = await readdir(dir);
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => parseSource(new URL(entry, dir))),
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

export function collect<T extends ts.Node>(
  root: ts.Node,
  match: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  walk(root, (node) => {
    if (match(node)) found.push(node);
  });
  return found;
}

/**
 * The member name a call expression invokes, for calls of the form `x.name(…)`
 * (including `this.name(…)` and optional-chained `x?.name(…)`). A bare
 * `name(…)` call yields the identifier itself.
 */
export function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return null;
}

/** Every member/function name called anywhere under `root`. */
export function calledNames(root: ts.Node): string[] {
  return collect(root, ts.isCallExpression)
    .map(calleeName)
    .filter((name): name is string => name !== null);
}

/** The named method of the (single) class declared in `source`. */
export function classMethod(
  source: ts.SourceFile,
  methodName: string,
): ts.MethodDeclaration {
  const found = collect(source, ts.isMethodDeclaration).find(
    (method) => ts.isIdentifier(method.name) && method.name.text === methodName,
  );
  if (found === undefined) {
    throw new Error(`no method named ${methodName} in ${source.fileName}`);
  }
  return found;
}

/**
 * The name of the nearest enclosing named declaration — the method, function,
 * property, or variable a node is written inside.
 *
 * This is what makes a "single call site" claim total: scanning methods alone
 * would let the same call escape into a bare function or an arrow property, so
 * the query starts from the call and asks who contains it.
 */
export function enclosingMemberName(node: ts.Node): string | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isVariableDeclaration(current)
    ) {
      const name = current.name;
      if (name !== undefined && ts.isIdentifier(name)) return name.text;
      return null;
    }
  }
  return null;
}

/** Whether `source` declares a class member with this name (method or property). */
export function hasClassMember(
  source: ts.SourceFile,
  memberName: string,
): boolean {
  return collect(source, ts.isClassDeclaration).some((declaration) =>
    declaration.members.some(
      (member) =>
        member.name !== undefined &&
        ts.isIdentifier(member.name) &&
        member.name.text === memberName,
    ),
  );
}

/**
 * Every module specifier `source` depends on: static imports, re-exports, and
 * dynamic `import(...)` calls with a literal specifier. This is the whole
 * static dependency edge set of one file.
 */
export function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
  });
  return specifiers;
}
