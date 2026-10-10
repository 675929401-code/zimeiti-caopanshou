import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ProviderAdmissionBusyError,
  ProviderAdmissionController,
  ProviderAdmissionUnavailableError,
  holdProviderAdmissionUntilResponseEnds,
} from "../src/lib/provider-admission-control";

const workerMode = process.argv.includes("--worker");
const rootIndex = process.argv.indexOf("--root");
const workerRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : "";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type FunctionWithBlock = ts.FunctionLikeDeclaration & { body: ts.Block };

type TypeScriptAnalysis = {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
};

type CallableTarget = {
  canonical: Set<string>;
  functions: Set<FunctionWithBlock>;
  unknown: boolean;
};

const PINNED_IMAGE_CONTRACT_DIGESTS = {
  runImageExactlyOnce: "61b298a4b1d1157516c957b9c090ed67534a4fb3334060a37e7e94fce3c9971e",
  fetchAuditedImageProviderPost: "152db51d9272f3bd8ca43050eaa8ade772c511b39e36cb0a45d4d807bbc93c96",
  fetchImageUpstream: "5a5c7f69b8db384a559ee1fa95bcdf4d104708aa4e0c6638a0a0f4ab17d41f42",
  generateLocalImageCandidate: "db690efc0b48e4e6eff663ce337cf617d3b04053f378441799dc3e21ced49777",
  submitOnce: "fb4d8575dd08c6a00facdde241a4ff5fe4f93e04a36c95f05158df3f87dd2b3c",
} as const;

// These values are intentionally reviewed and updated by hand. They pin the complete
// executable/type AST of both protected files; this verifier must never derive an
// expected value from the file it is currently auditing.
const PINNED_FULL_FILE_AST_DIGESTS = {
  imageGenerateRoute: "500415d5e6c764a51f49bcc007fa02b9ded1097a093e399f9d60753b1df808b5",
  imageExactlyOnce: "3c0e6b36588c1ffdf77f3770ee979cc709ea0cf4bbcd88682398897891dcab36",
} as const;

type FullFileAstPin = {
  current: string;
  expected: string;
};

function normalizedFullFileAst(source: string, fileName: string) {
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parsedDiagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  assert.equal(parsedDiagnostics.length, 0, `${fileName} must parse before full-file AST pinning`);
  const firstPrint = printer.printFile(parsed);
  const reparsed = ts.createSourceFile(fileName, firstPrint, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reparsedDiagnostics = (reparsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  assert.equal(reparsedDiagnostics.length, 0, `${fileName} normalized AST must parse`);
  const normalized = printer.printFile(reparsed);
  assert.equal(normalized, firstPrint, `${fileName} normalized AST printer must be idempotent`);
  return normalized;
}

function assertFullFileAstPin(
  source: string,
  fileName: string,
  expected: string,
  label: string,
): FullFileAstPin {
  const current = createHash("sha256")
    .update(normalizedFullFileAst(source, fileName))
    .digest("hex");
  assert.equal(
    current,
    expected,
    `FULL_FILE_AST_DRIFT ${label} current=${current} expected=${expected}`,
  );
  return { current, expected };
}

function assertProtectedImageFullFilePins(imageRoute: string, imageExactlyOnce: string) {
  return {
    imageRoute: assertFullFileAstPin(
      imageRoute,
      "src/app/api/image/generate/route.ts",
      PINNED_FULL_FILE_AST_DIGESTS.imageGenerateRoute,
      "image-generate-route",
    ),
    imageExactlyOnce: assertFullFileAstPin(
      imageExactlyOnce,
      "src/lib/image-exactly-once.ts",
      PINNED_FULL_FILE_AST_DIGESTS.imageExactlyOnce,
      "image-exactly-once",
    ),
  };
}

function analyzeTypeScript(source: string, fileName: string): TypeScriptAnalysis {
  const absoluteName = path.resolve(".provider-admission-fixtures", fileName);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    noResolve: true,
    skipLibCheck: true,
    strict: true,
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const normalizedVirtualName = path.normalize(absoluteName);
  host.fileExists = candidate => path.normalize(candidate) === normalizedVirtualName || originalFileExists(candidate);
  host.readFile = candidate => path.normalize(candidate) === normalizedVirtualName ? source : originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.normalize(candidate) === normalizedVirtualName
      ? ts.createSourceFile(candidate, source, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([absoluteName], options, host);
  const sourceFile = program.getSourceFile(absoluteName);
  assert.ok(sourceFile, `${fileName} must be available to the TypeScript Program`);
  assert.equal(program.getSyntacticDiagnostics(sourceFile).length, 0,
    `${fileName} must parse without TypeScript syntax errors`);
  return { sourceFile, checker: program.getTypeChecker() };
}

function executableAstDigest(node: ts.Node, sourceFile: ts.SourceFile) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    sourceFile.text.slice(node.getStart(sourceFile, false), node.getEnd()),
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(`${ts.SyntaxKind[token]}:${scanner.getTokenText()}`);
  }
  return createHash("sha256").update(tokens.join("\n")).digest("hex");
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node) {
  return checker.getSymbolAtLocation(node);
}

function functionFromDeclaration(declaration: ts.Declaration): FunctionWithBlock | null {
  if (ts.isFunctionLike(declaration)) {
    const functionLike = declaration as ts.FunctionLikeDeclaration;
    if (functionLike.body && ts.isBlock(functionLike.body)) return declaration as FunctionWithBlock;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer
    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
    && ts.isBlock(declaration.initializer.body)) {
    return declaration.initializer as FunctionWithBlock;
  }
  if (ts.isPropertyAssignment(declaration)
    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
    && ts.isBlock(declaration.initializer.body)) {
    return declaration.initializer as FunctionWithBlock;
  }
  return null;
}

const IMAGE_CANONICAL_CALLS = new Set([
  "acquireProviderAdmission",
  "fetchAuditedImageProviderPost",
  "generateLocalImageCandidate",
  "runImageExactlyOnce",
  "fetch",
  "safeFetch",
  "fetchImageUpstream",
]);

const RAW_NETWORK_CALLS = new Set(["fetch", "safeFetch", "fetchImageUpstream"]);

function emptyCallableTarget(): CallableTarget {
  return { canonical: new Set(), functions: new Set(), unknown: false };
}

function mergeCallableTarget(target: CallableTarget, incoming: CallableTarget) {
  for (const value of incoming.canonical) target.canonical.add(value);
  for (const value of incoming.functions) target.functions.add(value);
  target.unknown ||= incoming.unknown;
  return target;
}

function namedImportSymbol(analysis: TypeScriptAnalysis, name: string, moduleName?: string) {
  const matches: ts.Symbol[] = [];
  for (const statement of analysis.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (moduleName && statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name || (element.propertyName && element.propertyName.text !== name)) continue;
      const symbol = symbolAt(analysis.checker, element.name);
      if (symbol) matches.push(symbol);
    }
  }
  assert.equal(matches.length, 1, `${name} must have one exact named-import symbol`);
  return matches[0];
}

function topLevelFunctionSymbol(analysis: TypeScriptAnalysis, name: string) {
  const node = topLevelFunction(analysis.sourceFile, name);
  let nameNode: ts.Identifier | undefined;
  if (ts.isFunctionDeclaration(node)) nameNode = node.name;
  if (!nameNode && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
    const declaration = node.parent;
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) nameNode = declaration.name;
  }
  assert.ok(nameNode, `${name} must expose a lexical symbol`);
  const symbol = symbolAt(analysis.checker, nameNode);
  assert.ok(symbol, `${name} lexical symbol must resolve`);
  return { node, symbol };
}

function buildCallableResolver(
  analysis: TypeScriptAnalysis,
  canonicalSymbols: Map<ts.Symbol, string>,
) {
  const sources = new Map<ts.Symbol, ts.Expression[]>();
  const addSource = (symbol: ts.Symbol | undefined, expression: ts.Expression) => {
    if (!symbol) return;
    const values = sources.get(symbol) || [];
    values.push(expression);
    sources.set(symbol, values);
  };
  walkAll(analysis.sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      addSource(symbolAt(analysis.checker, node.name), node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrapExpression(node.left))) {
      const left = unwrapExpression(node.left) as ts.Identifier;
      addSource(symbolAt(analysis.checker, left), node.right);
    }
  });

  const cache = new Map<ts.Symbol, CallableTarget>();
  const resolving = new Set<ts.Symbol>();
  const resolveExpression = (expression: ts.Expression): CallableTarget => {
    const current = unwrapExpression(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const target = emptyCallableTarget();
      if (ts.isBlock(current.body)) target.functions.add(current as FunctionWithBlock);
      else target.unknown = true;
      return target;
    }
    if (ts.isIdentifier(current)) {
      const symbol = symbolAt(analysis.checker, current);
      return symbol ? resolveSymbol(symbol) : { ...emptyCallableTarget(), unknown: true };
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (ts.isIdentifier(current.expression) && current.expression.text === "globalThis"
        && IMAGE_CANONICAL_CALLS.has(current.name.text)) {
        const target = emptyCallableTarget();
        target.canonical.add(current.name.text);
        return target;
      }
      const symbol = symbolAt(analysis.checker, current.name) || symbolAt(analysis.checker, current);
      return symbol ? resolveSymbol(symbol) : { ...emptyCallableTarget(), unknown: true };
    }
    if (ts.isElementAccessExpression(current)) {
      const terminal = protectedTerminalName(current);
      if (terminal && IMAGE_CANONICAL_CALLS.has(terminal)) {
        const target = emptyCallableTarget();
        target.canonical.add(terminal);
        target.unknown = true;
        return target;
      }
      const symbol = symbolAt(analysis.checker, current);
      return symbol ? resolveSymbol(symbol) : { ...emptyCallableTarget(), unknown: true };
    }
    if (ts.isConditionalExpression(current)) {
      return mergeCallableTarget(resolveExpression(current.whenTrue), resolveExpression(current.whenFalse));
    }
    return { ...emptyCallableTarget(), unknown: true };
  };
  const resolveSymbol = (symbol: ts.Symbol): CallableTarget => {
    const cached = cache.get(symbol);
    if (cached) return cached;
    if (resolving.has(symbol)) return { ...emptyCallableTarget(), unknown: true };
    resolving.add(symbol);
    const target = emptyCallableTarget();
    const canonical = canonicalSymbols.get(symbol);
    if (canonical) target.canonical.add(canonical);
    for (const declaration of symbol.declarations || []) {
      const fn = functionFromDeclaration(declaration);
      if (fn) target.functions.add(fn);
    }
    const symbolSources = sources.get(symbol) || [];
    for (const source of symbolSources) mergeCallableTarget(target, resolveExpression(source));
    if (!canonical && target.functions.size === 0 && symbolSources.length === 0) target.unknown = true;
    resolving.delete(symbol);
    cache.set(symbol, target);
    return target;
  };
  return {
    resolveCall(call: ts.CallExpression) {
      return resolveExpression(call.expression);
    },
    sources,
  };
}

type BindingModel = {
  aliases: Map<string, string>;
  ambiguous: Set<string>;
};

function walkAll(root: ts.Node, visit: (node: ts.Node) => void) {
  const walker = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, walker);
  };
  walker(root);
}

function isNestedExecutionBoundary(node: ts.Node) {
  return ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

function walkExecutionScope(root: ts.Node, visit: (node: ts.Node) => void) {
  const walker = (node: ts.Node) => {
    if (node !== root && isNestedExecutionBoundary(node)) return;
    visit(node);
    ts.forEachChild(node, walker);
  };
  walker(root);
}

function nodeContains(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  let matched = false;
  walkAll(root, node => {
    if (!matched && predicate(node)) matched = true;
  });
  return matched;
}

function protectedTerminalName(expression: ts.Expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return "";
}

function buildBindingModel(sourceFile: ts.SourceFile): BindingModel {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  walkAll(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer;
      if (!initializer || !ts.isIdentifier(initializer) || !ts.isIdentifier(declaration.name)) continue;
      const target = IMAGE_CANONICAL_CALLS.has(initializer.text)
        ? initializer.text
        : aliases.get(initializer.text);
      if (!target) continue;
      const alias = declaration.name.text;
      const existing = aliases.get(alias);
      if (existing && existing !== target) ambiguous.add(alias);
      if (!existing) {
        aliases.set(alias, target);
        changed = true;
      }
    }
  }
  return { aliases, ambiguous };
}

function resolvedCanonicalCall(call: ts.CallExpression, bindings: BindingModel) {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    assert.ok(!bindings.ambiguous.has(expression.text), `ambiguous protected-call alias ${expression.text} must fail closed`);
    if (IMAGE_CANONICAL_CALLS.has(expression.text)) return expression.text;
    return bindings.aliases.get(expression.text) || null;
  }
  const terminal = protectedTerminalName(expression);
  assert.ok(!IMAGE_CANONICAL_CALLS.has(terminal),
    `protected call ${terminal} must use its direct lexical identifier, not a receiver or element alias`);
  return null;
}

function allCalls(root: ts.Node) {
  const calls: ts.CallExpression[] = [];
  walkAll(root, node => {
    if (ts.isCallExpression(node)) calls.push(node);
  });
  return calls;
}

function scopeCalls(root: ts.Node) {
  const calls: ts.CallExpression[] = [];
  walkExecutionScope(root, node => {
    if (ts.isCallExpression(node)) calls.push(node);
  });
  return calls;
}

function topLevelFunction(sourceFile: ts.SourceFile, name: string): FunctionWithBlock {
  const matches: FunctionWithBlock[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      matches.push(statement as FunctionWithBlock);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          && ts.isBlock(declaration.initializer.body)) matches.push(declaration.initializer as FunctionWithBlock);
      }
    }
  }
  assert.equal(matches.length, 1, `${name} must have exactly one top-level executable function binding`);
  return matches[0];
}

function assertNamedImport(sourceFile: ts.SourceFile, name: string, moduleName: string) {
  const bindings = sourceFile.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) return [];
    const named = statement.importClause?.namedBindings;
    return named && ts.isNamedImports(named)
      ? named.elements.filter(element => element.name.text === name && (!element.propertyName || element.propertyName.text === name))
      : [];
  });
  assert.equal(bindings.length, 1, `${name} must be a direct named import from ${moduleName}`);
}

function directAwaitedStatement(call: ts.CallExpression, boundary: ts.Node, allowPinnedOptional = false) {
  if (!allowPinnedOptional && (call.questionDotToken
    || (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken)
    || (ts.isElementAccessExpression(call.expression) && call.expression.questionDotToken))) return null;
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return null;
  let statement: ts.Statement | null = null;
  if (ts.isExpressionStatement(awaited.parent) && awaited.parent.expression === awaited) {
    statement = awaited.parent;
  } else if (ts.isBinaryExpression(awaited.parent) && awaited.parent.right === awaited
    && awaited.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isExpressionStatement(awaited.parent.parent)) {
    statement = awaited.parent.parent;
  } else if (ts.isVariableDeclaration(awaited.parent) && awaited.parent.initializer === awaited
    && ts.isVariableDeclarationList(awaited.parent.parent) && awaited.parent.parent.declarations.length === 1
    && ts.isVariableStatement(awaited.parent.parent.parent)) {
    statement = awaited.parent.parent.parent;
  }
  if (!statement || !ts.isBlock(statement.parent)) return null;
  let ancestor: ts.Node | undefined = statement.parent;
  while (ancestor && ancestor !== boundary) ancestor = ancestor.parent;
  if (ancestor !== boundary && statement.parent !== boundary) return null;
  return { block: statement.parent, statement, index: statement.parent.statements.indexOf(statement) };
}

function statementContainsAbruptExit(statement: ts.Statement) {
  let abrupt = false;
  walkExecutionScope(statement, node => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)
      || ts.isBreakStatement(node) || ts.isContinueStatement(node)) abrupt = true;
  });
  return abrupt;
}

function assertNoAbruptExitBeforeOrBetween(
  first: NonNullable<ReturnType<typeof directAwaitedStatement>>,
  second: NonNullable<ReturnType<typeof directAwaitedStatement>>,
  label: string,
) {
  assert.equal(first.block, second.block, `${label} protected calls must share one block`);
  const inspected = first.block.statements.slice(0, second.index);
  assert.ok(!inspected.some(statementContainsAbruptExit),
    `${label} must not contain return/throw/break/continue before or between admission and dispatch`);
}

function directIdentifierCall(call: ts.CallExpression, name: string) {
  return ts.isIdentifier(call.expression) && call.expression.text === name;
}

function exactOptionsHookCall(
  call: ts.CallExpression,
  property: string,
  analysis: TypeScriptAnalysis,
  optionsSymbol: ts.Symbol,
  allowPinnedOptional: boolean,
) {
  if (!allowPinnedOptional && (call.questionDotToken
    || (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken))) return false;
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && symbolAt(analysis.checker, call.expression.expression) === optionsSymbol
    && call.expression.name.text === property;
}

function orderedDirectAwaitedPair(
  root: ts.Node,
  firstName: string,
  secondName: string,
  label: string,
) {
  const calls = scopeCalls(root);
  for (const call of calls) {
    const terminal = protectedTerminalName(call.expression);
    assert.ok(![firstName, secondName].includes(terminal),
      `${label} protected calls must reject arbitrary receivers and element access`);
  }
  const secondCalls = calls.filter(call => directIdentifierCall(call, secondName));
  assert.equal(secondCalls.length, 1, `${label} must contain exactly one direct ${secondName} call`);
  const second = secondCalls[0];
  const secondLocation = directAwaitedStatement(second, root);
  assert.ok(secondLocation, `${label} ${secondName} must be a top-level unconditional awaited statement`);
  const firstCalls = calls.filter(call => directIdentifierCall(call, firstName));
  const sameBlockFirst = firstCalls.filter(call => directAwaitedStatement(call, root)?.block === secondLocation.block);
  assert.equal(sameBlockFirst.length, 1, `${label} must contain one direct same-block unconditional ${firstName}`);
  const first = sameBlockFirst[0];
  const firstLocation = directAwaitedStatement(first, root);
  assert.ok(firstLocation && firstLocation.index < secondLocation.index,
    `${label} must unconditionally await ${firstName} before ${secondName}`);
  assertNoAbruptExitBeforeOrBetween(firstLocation, secondLocation, label);
  return second;
}

function assertWhitelistedRoutePairAncestry(call: ts.CallExpression, kind: "workflow" | "candidate", sourceFile: ts.SourceFile) {
  const location = directAwaitedStatement(call, sourceFile);
  assert.ok(location && ts.isTryStatement(location.block.parent) && location.block.parent.tryBlock === location.block,
    `${kind} protected pair must be direct statements in one whitelisted try body`);
  const tryStatement = location.block.parent;
  assert.ok(ts.isBlock(tryStatement.parent), `${kind} admission try must be a direct branch-body statement`);
  const branchBody = tryStatement.parent;
  assert.ok(branchBody.statements.includes(tryStatement), `${kind} admission try must not be nested under another control node`);
  if (kind === "workflow") {
    assert.ok(ts.isIfStatement(branchBody.parent) && branchBody.parent.thenStatement === branchBody,
      "workflow admission try must be directly guarded by the workflow-mode branch");
    const condition = branchBody.parent.expression;
    assert.ok(ts.isBinaryExpression(condition)
      && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isIdentifier(condition.left) && condition.left.text === "effectiveMode"
      && ts.isStringLiteral(condition.right) && condition.right.text === "workflow",
    "workflow admission branch must be exactly effectiveMode === workflow");
  } else {
    assert.ok(ts.isForStatement(branchBody.parent) && branchBody.parent.statement === branchBody,
      "candidate admission try must be directly inside the candidate for-loop body");
  }
}

function assertExactlyOnceBillingBeforeSubmit(source: string, requirePinnedContract = false) {
  const analysis = analyzeTypeScript(source, "image-exactly-once.contract.ts");
  const { sourceFile } = analysis;
  const runner = topLevelFunction(sourceFile, "runImageExactlyOnce");
  const runnerDigest = executableAstDigest(runner, sourceFile);
  if (requirePinnedContract) {
    assert.equal(runnerDigest, PINNED_IMAGE_CONTRACT_DIGESTS.runImageExactlyOnce,
      "runImageExactlyOnce executable AST changed; fail closed until its billing/provider proof is re-audited");
  }
  // Production currently keeps beforeSubmitOnce optional in the public type. The only
  // accepted optional call is the exact pinned runner AST, while the route verifier
  // independently proves that its sole runImageExactlyOnce call supplies the direct
  // reserveImageBudgetOnce symbol. Any runner edit loses this narrow exception.
  const allowPinnedOptional = runnerDigest === PINNED_IMAGE_CONTRACT_DIGESTS.runImageExactlyOnce;
  assert.equal(runner.parameters.length, 1, "runImageExactlyOnce must expose exactly one options parameter");
  const optionsParameter = runner.parameters[0];
  assert.ok(ts.isIdentifier(optionsParameter.name) && optionsParameter.name.text === "options",
    "runImageExactlyOnce options parameter must remain a direct lexical identifier");
  const optionsSymbol = symbolAt(analysis.checker, optionsParameter.name);
  assert.ok(optionsSymbol, "runImageExactlyOnce options parameter symbol must resolve");

  const optionBindingViolations: string[] = [];
  walkAll(runner.body, node => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === "options"
      && symbolAt(analysis.checker, node.name) !== optionsSymbol) {
      optionBindingViolations.push("options-shadow");
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isIdentifier(initializer) && symbolAt(analysis.checker, initializer) === optionsSymbol) {
        optionBindingViolations.push("options-alias");
      }
      if (!ts.isIdentifier(node.name) && nodeContains(initializer, candidate => (
        ts.isIdentifier(candidate) && symbolAt(analysis.checker, candidate) === optionsSymbol
      ))) optionBindingViolations.push("options-destructure");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrapExpression(node.left);
      if (ts.isIdentifier(left) && symbolAt(analysis.checker, left) === optionsSymbol) {
        optionBindingViolations.push("options-write");
      }
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
        && symbolAt(analysis.checker, left.expression) === optionsSymbol
        && ["beforeSubmitOnce", "submitOnce"].includes(left.name.text)) {
        optionBindingViolations.push(`hook-write:${left.name.text}`);
      }
    }
    if (ts.isBindingElement(node)) {
      const property = node.propertyName?.getText(sourceFile).replaceAll(/[\[\]'" ]/gu, "") || "";
      const bound = ts.isIdentifier(node.name) ? node.name.text : "";
      if ([property, bound].some(name => ["options", "beforeSubmitOnce", "submitOnce"].includes(name))) {
        optionBindingViolations.push(`hook-destructure:${property || bound}`);
      }
    }
  });
  assert.deepEqual(optionBindingViolations, [],
    "runImageExactlyOnce options/hooks must not be rewritten, aliased, shadowed, or destructured");

  const calls = scopeCalls(runner.body);
  const beforeCalls = calls.filter(call => exactOptionsHookCall(
    call, "beforeSubmitOnce", analysis, optionsSymbol, allowPinnedOptional,
  ));
  const submitCalls = calls.filter(call => exactOptionsHookCall(
    call, "submitOnce", analysis, optionsSymbol, false,
  ));
  assert.equal(beforeCalls.length, 2, "image exactly-once must have two direct beforeSubmitOnce paths");
  assert.equal(submitCalls.length, 2, "image exactly-once must have two direct submitOnce paths");
  for (const [index, submit] of submitCalls.entries()) {
    const submitLocation = directAwaitedStatement(submit, runner.body);
    assert.ok(submitLocation, "submitOnce must be a top-level unconditional awaited statement in its branch block");
    const sameBlockBefore = beforeCalls.filter(call => (
      directAwaitedStatement(call, runner.body, allowPinnedOptional)?.block === submitLocation.block
    ));
    assert.equal(sameBlockBefore.length, 1, "each submitOnce branch must have one same-block unconditional beforeSubmitOnce hook");
    const beforeLocation = directAwaitedStatement(sameBlockBefore[0], runner.body, allowPinnedOptional);
    assert.ok(beforeLocation && beforeLocation.index < submitLocation.index,
      "beforeSubmitOnce must be unconditionally awaited before submitOnce in each branch");
    assertNoAbruptExitBeforeOrBetween(beforeLocation, submitLocation, "exactly-once hook pair");
    assert.ok(ts.isTryStatement(submitLocation.block.parent) && submitLocation.block.parent.tryBlock === submitLocation.block,
      "exactly-once hook pairs must be direct statements in a whitelisted try body");
    const tryStatement = submitLocation.block.parent;
    if (index === 0) {
      assert.ok(ts.isBlock(tryStatement.parent) && ts.isIfStatement(tryStatement.parent.parent)
        && tryStatement.parent.parent.thenStatement === tryStatement.parent
        && ts.isPropertyAccessExpression(tryStatement.parent.parent.expression)
        && ts.isIdentifier(tryStatement.parent.parent.expression.expression)
        && tryStatement.parent.parent.expression.expression.text === "options"
        && tryStatement.parent.parent.expression.name.text === "persistProviderResult",
      "checkpoint exactly-once hook pair must be directly inside options.persistProviderResult");
    } else {
      assert.ok(tryStatement.parent === runner.body,
        "non-checkpoint exactly-once hook pair must be a direct runner-body try statement");
    }
  }
}

function findRunImageSubmitCallback(sourceFile: ts.SourceFile, bindings: BindingModel) {
  const runCalls = allCalls(sourceFile).filter(call => resolvedCanonicalCall(call, bindings) === "runImageExactlyOnce");
  assert.equal(runCalls.length, 1, "image route must contain exactly one lexically bound runImageExactlyOnce call");
  assert.ok(directIdentifierCall(runCalls[0], "runImageExactlyOnce"), "runImageExactlyOnce aliases are not allowed");
  const options = runCalls[0].arguments[0];
  assert.ok(options && ts.isObjectLiteralExpression(options), "runImageExactlyOnce must receive an object literal contract");
  const beforeMatches = options.properties.filter(property => property.name?.getText(sourceFile) === "beforeSubmitOnce");
  const submitMatches = options.properties.filter(property => property.name?.getText(sourceFile) === "submitOnce");
  assert.equal(beforeMatches.length, 1, "runImageExactlyOnce must have exactly one beforeSubmitOnce property");
  assert.equal(submitMatches.length, 1, "runImageExactlyOnce must have exactly one submitOnce property");
  const beforeSubmit = beforeMatches[0];
  const submit = submitMatches[0];
  const protectedPropertyStart = Math.min(options.properties.indexOf(beforeSubmit), options.properties.indexOf(submit));
  assert.equal(options.properties.slice(protectedPropertyStart).filter(ts.isSpreadAssignment).length, 0,
    "runImageExactlyOnce spreads must not override protected submit hooks");
  assert.ok(beforeSubmit && ts.isPropertyAssignment(beforeSubmit)
    && ts.isIdentifier(beforeSubmit.initializer) && beforeSubmit.initializer.text === "reserveImageBudgetOnce",
  "runImageExactlyOnce must bind beforeSubmitOnce directly to reserveImageBudgetOnce");
  assert.ok(submit && ts.isPropertyAssignment(submit)
    && (ts.isArrowFunction(submit.initializer) || ts.isFunctionExpression(submit.initializer))
    && ts.isBlock(submit.initializer.body), "runImageExactlyOnce must define an executable submitOnce block");
  return submit.initializer.body;
}

function staticallyProvenGet(call: ts.CallExpression, sourceFile: ts.SourceFile) {
  const init = call.arguments[1];
  if (!init) return true;
  if (!ts.isObjectLiteralExpression(init)) return false;
  if (init.properties.some(ts.isSpreadAssignment)) return false;
  const methods = init.properties.filter(property => property.name?.getText(sourceFile) === "method");
  if (methods.length === 0) return true;
  return methods.length === 1 && ts.isPropertyAssignment(methods[0])
    && ts.isStringLiteralLike(methods[0].initializer) && methods[0].initializer.text.toUpperCase() === "GET";
}

function routeCanonicalSymbols(analysis: TypeScriptAnalysis) {
  const canonical = new Map<ts.Symbol, string>();
  canonical.set(namedImportSymbol(analysis, "acquireProviderAdmission", "@/lib/provider-admission-control"),
    "acquireProviderAdmission");
  canonical.set(namedImportSymbol(analysis, "runImageExactlyOnce", "@/lib/image-exactly-once"),
    "runImageExactlyOnce");
  for (const imported of ["safeFetch"]) {
    const candidates: ts.Symbol[] = [];
    for (const statement of analysis.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (element.name.text !== imported) continue;
        const symbol = symbolAt(analysis.checker, element.name);
        if (symbol) candidates.push(symbol);
      }
    }
    if (candidates.length === 1) canonical.set(candidates[0], imported);
  }
  for (const name of ["fetchAuditedImageProviderPost", "generateLocalImageCandidate", "fetchImageUpstream"]) {
    const binding = topLevelFunctionSymbol(analysis, name);
    canonical.set(binding.symbol, name);
  }
  walkAll(analysis.sourceFile, node => {
    if (!ts.isIdentifier(node) || node.text !== "fetch") return;
    const symbol = symbolAt(analysis.checker, node);
    if (!symbol) return;
    const declarations = symbol.declarations || [];
    if (declarations.some(declaration => declaration.getSourceFile() !== analysis.sourceFile)) {
      canonical.set(symbol, "fetch");
    }
  });
  return canonical;
}

function protectedBindingName(name: ts.BindingName, sourceFile: ts.SourceFile) {
  if (ts.isIdentifier(name)) return IMAGE_CANONICAL_CALLS.has(name.text) ? name.text : "";
  let protectedName = "";
  walkAll(name, node => {
    if (!ts.isBindingElement(node)) return;
    const bound = ts.isIdentifier(node.name) ? node.name.text : "";
    let property = node.propertyName?.getText(sourceFile).replaceAll(/[\[\]'" ]/gu, "") || "";
    if (node.propertyName && ts.isComputedPropertyName(node.propertyName)
      && ts.isStringLiteralLike(node.propertyName.expression)) property = node.propertyName.expression.text;
    if (IMAGE_CANONICAL_CALLS.has(bound)) protectedName = bound;
    if (IMAGE_CANONICAL_CALLS.has(property)) protectedName = property;
  });
  return protectedName;
}

function assertNoProtectedMutationInScopes(
  analysis: TypeScriptAnalysis,
  scopes: Iterable<ts.Node>,
  canonicalSymbols: Map<ts.Symbol, string>,
) {
  const violations: string[] = [];
  for (const scope of scopes) {
    walkExecutionScope(scope, node => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && protectedBindingName(node.name, analysis.sourceFile)) {
        violations.push(`shadow:${protectedBindingName(node.name, analysis.sourceFile)}`);
      }
      if (ts.isBindingElement(node)) {
        const owner = node.parent.parent;
        if ((ts.isVariableDeclaration(owner) || ts.isParameter(owner))
          && protectedBindingName(owner.name, analysis.sourceFile)) {
          violations.push("protected-destructure");
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrapExpression(node.left);
        if (ts.isIdentifier(left)) {
          const symbol = symbolAt(analysis.checker, left);
          if ((symbol && canonicalSymbols.has(symbol)) || IMAGE_CANONICAL_CALLS.has(left.text)) {
            violations.push(`protected-write:${left.text}`);
          }
        } else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
          violations.push("dynamic-assignment-pattern");
        }
      }
    });
  }
  assert.deepEqual(violations, [],
    "protected imports/helpers/network bindings must not be assigned, shadowed, or destructured in reachable execution");
}

function assertNoProtectedCallableEscapeInScopes(
  analysis: TypeScriptAnalysis,
  scopes: Iterable<ts.Node>,
  canonicalSymbols: Map<ts.Symbol, string>,
) {
  const violations: string[] = [];
  const directCallExpression = (node: ts.Node) => {
    if (ts.isExpression(node) && ts.isCallExpression(node.parent) && node.parent.expression === node) return true;
    if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)
      && node.parent.name === node && IMAGE_CANONICAL_CALLS.has(node.text)
      && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent) return true;
    if (ts.isIdentifier(node) && ts.isElementAccessExpression(node.parent)
      && node.parent.argumentExpression === node && IMAGE_CANONICAL_CALLS.has(node.text)
      && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent) return true;
    return false;
  };
  const declarationName = (node: ts.Identifier) => {
    const parent = node.parent;
    return (ts.isImportSpecifier(parent) && parent.name === node)
      || (ts.isFunctionDeclaration(parent) && parent.name === node)
      || (ts.isVariableDeclaration(parent) && parent.name === node)
      || (ts.isParameter(parent) && parent.name === node);
  };
  for (const scope of scopes) {
    walkExecutionScope(scope, node => {
      if (ts.isIdentifier(node)) {
        const symbol = symbolAt(analysis.checker, node);
        if (!symbol || !canonicalSymbols.has(symbol) || declarationName(node) || directCallExpression(node)) return;
        violations.push(`${canonicalSymbols.get(symbol)}:${node.parent.kind}`);
        return;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const terminal = protectedTerminalName(node);
        if (!terminal || !IMAGE_CANONICAL_CALLS.has(terminal) || directCallExpression(node)) return;
        violations.push(`${terminal}:${node.parent.kind}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    "protected provider/network callable values must not escape direct lexical calls through arguments, containers, bindings, returns, properties, call/apply/bind, or dynamic computed access");
}

const DYNAMIC_GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "process"]);

function staticPropertyKey(expression: ts.Expression | undefined) {
  if (!expression) return null;
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current)
    || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  return null;
}

function assertNoDynamicCallableAccessInScopes(
  analysis: TypeScriptAnalysis,
  scopes: Iterable<ts.Node>,
) {
  const violations: string[] = [];
  const globalObject = (expression: ts.Expression) => {
    const current = unwrapExpression(expression);
    return ts.isIdentifier(current) && DYNAMIC_GLOBAL_OBJECTS.has(current.text);
  };
  for (const scope of scopes) {
    walkExecutionScope(scope, node => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isPropertyAccessExpression(callee)
          && ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect"
          && callee.name.text === "get") violations.push("Reflect.get");
        if (ts.isElementAccessExpression(callee)
          && ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect"
          && staticPropertyKey(callee.argumentExpression) === "get") violations.push("Reflect[get]");
      }
      if (ts.isElementAccessExpression(node)) {
        const key = staticPropertyKey(node.argumentExpression);
        const usedAsCallable = ts.isCallExpression(node.parent) && node.parent.expression === node;
        const assignmentTarget = ts.isBinaryExpression(node.parent) && node.parent.left === node
          && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (globalObject(node.expression) && (key === null || IMAGE_CANONICAL_CALLS.has(key))) {
          violations.push(`dynamic-global:${key || "unknown"}`);
        }
        if (usedAsCallable) {
          violations.push(key === null ? "dynamic-callable-property" : `computed-callable-not-whitelisted:${key}`);
        }
        if (assignmentTarget && key === null) {
          violations.push("dynamic-property-write");
        }
      }
      if (ts.isComputedPropertyName(node) && staticPropertyKey(node.expression) === null) {
        violations.push("dynamic-computed-key");
      }
      if (ts.isSpreadAssignment(node)) {
        const expression = unwrapExpression(node.expression);
        const type = analysis.checker.getTypeAtLocation(expression);
        if (globalObject(expression) || Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
          violations.push(globalObject(expression) ? "global-object-spread" : "unknown-object-spread");
        }
      }
    });
  }
  assert.deepEqual(violations, [],
    "reachable dynamic global/computed callable access, Reflect.get, unknown object spread, and dynamic property writes must fail closed");
}

function collectReachableProviderCalls(
  analysis: TypeScriptAnalysis,
  roots: FunctionWithBlock[],
  canonicalSymbols: Map<ts.Symbol, string>,
) {
  const resolver = buildCallableResolver(analysis, canonicalSymbols);
  assertNoProtectedMutationInScopes(analysis, [analysis.sourceFile], canonicalSymbols);
  const queued = [...roots];
  const functions = new Set<FunctionWithBlock>();
  const classes = new Set<ts.ClassLikeDeclaration>();
  const auditedCalls = new Set<ts.CallExpression>();
  const rawCalls = new Set<ts.CallExpression>();
  const addClassDeclarations = (node: ts.Node) => {
    const symbol = symbolAt(analysis.checker, node);
    for (const declaration of symbol?.declarations || []) {
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) classes.add(declaration);
      if (ts.isPropertyDeclaration(declaration)
        && (ts.isClassDeclaration(declaration.parent) || ts.isClassExpression(declaration.parent))) {
        classes.add(declaration.parent);
      }
    }
  };
  while (queued.length > 0) {
    const fn = queued.shift()!;
    if (functions.has(fn)) continue;
    functions.add(fn);
    walkExecutionScope(fn.body, node => {
      if (ts.isNewExpression(node)) addClassDeclarations(node.expression);
      if (ts.isPropertyAccessExpression(node)) addClassDeclarations(node.name);
      if (ts.isElementAccessExpression(node)) addClassDeclarations(node);
      if (!ts.isCallExpression(node)) return;
      const target = resolver.resolveCall(node);
      const terminal = protectedTerminalName(node.expression);
      const protectedTerminal = Boolean(terminal && IMAGE_CANONICAL_CALLS.has(terminal));
      const optional = Boolean(node.questionDotToken
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.questionDotToken)
        || (ts.isElementAccessExpression(node.expression) && node.expression.questionDotToken));
      if (terminal && IMAGE_CANONICAL_CALLS.has(terminal)) {
        const globalFetch = terminal === "fetch" && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "globalThis";
        assert.ok(globalFetch,
          `reachable protected call ${terminal} must bind to an approved lexical symbol, not an arbitrary receiver/element`);
      }
      assert.ok(!(optional && (protectedTerminal || [...target.canonical].some(name => IMAGE_CANONICAL_CALLS.has(name)))),
        "reachable protected provider/network calls must not use optional call chains");
      if (target.unknown && (protectedTerminal || nodeContains(node.expression, candidate => (
        ts.isIdentifier(candidate) && IMAGE_CANONICAL_CALLS.has(candidate.text)
      )))) {
        assert.fail(`reachable protected callable could not be resolved to its lexical symbol: ${node.expression.getText(analysis.sourceFile)}`);
      }
      for (const name of target.canonical) {
        if (name === "fetchAuditedImageProviderPost") auditedCalls.add(node);
        if (!RAW_NETWORK_CALLS.has(name)) continue;
        rawCalls.add(node);
        assert.ok(staticallyProvenGet(node, analysis.sourceFile),
          `reachable raw network call ${name} must be a statically proven spread-free GET; provider POST must use the audited wrapper`);
      }
      const canonicalSink = [...target.canonical].some(name => (
        name === "fetchAuditedImageProviderPost" || name === "fetchImageUpstream"
      ));
      if (!canonicalSink) {
        for (const reachable of target.functions) queued.push(reachable);
      }
    });
  }
  assertNoProtectedMutationInScopes(analysis, [...functions].map(fn => fn.body), canonicalSymbols);
  return { resolver, functions, classes, auditedCalls, rawCalls };
}

function assertPinnedImageRouteContracts(
  sourceFile: ts.SourceFile,
  submitCallback: FunctionWithBlock,
) {
  const audited = topLevelFunction(sourceFile, "fetchAuditedImageProviderPost");
  const transport = topLevelFunction(sourceFile, "fetchImageUpstream");
  const helper = topLevelFunction(sourceFile, "generateLocalImageCandidate");
  assert.equal(executableAstDigest(audited, sourceFile), PINNED_IMAGE_CONTRACT_DIGESTS.fetchAuditedImageProviderPost,
    "audited image POST wrapper AST changed; fail closed until durable receipt ordering is re-audited");
  assert.equal(executableAstDigest(transport, sourceFile), PINNED_IMAGE_CONTRACT_DIGESTS.fetchImageUpstream,
    "image upstream transport AST changed; fail closed until its network boundary is re-audited");
  assert.equal(executableAstDigest(helper, sourceFile), PINNED_IMAGE_CONTRACT_DIGESTS.generateLocalImageCandidate,
    "image candidate helper AST changed; fail closed until all provider network paths are re-audited");
  assert.equal(executableAstDigest(submitCallback, sourceFile), PINNED_IMAGE_CONTRACT_DIGESTS.submitOnce,
    "image submitOnce callback AST changed; fail closed until admission/control-flow ordering is re-audited");
}

function assertImageRouteAdmissionStructure(source: string, checkBillingResponse = true) {
  const analysis = analyzeTypeScript(source, "image-generate-route.contract.ts");
  const { sourceFile } = analysis;
  assertNamedImport(sourceFile, "acquireProviderAdmission", "@/lib/provider-admission-control");
  assertNamedImport(sourceFile, "runImageExactlyOnce", "@/lib/image-exactly-once");
  topLevelFunction(sourceFile, "fetchAuditedImageProviderPost");
  const helper = topLevelFunction(sourceFile, "generateLocalImageCandidate");
  const bindings = buildBindingModel(sourceFile);
  const submitCallback = findRunImageSubmitCallback(sourceFile, bindings);
  assert.ok(ts.isFunctionLike(submitCallback.parent)
    && Boolean((submitCallback.parent as ts.FunctionLikeDeclaration).body)
    && ts.isBlock((submitCallback.parent as ts.FunctionLikeDeclaration).body!),
    "submitOnce callback must resolve to one block-bodied function symbol");
  const submitCallbackFunction = submitCallback.parent as FunctionWithBlock;
  if (checkBillingResponse) assertPinnedImageRouteContracts(sourceFile, submitCallbackFunction);
  const workflowDispatch = orderedDirectAwaitedPair(
    submitCallback, "acquireProviderAdmission", "fetchAuditedImageProviderPost", "image workflow callback",
  );
  const candidateHelperCall = orderedDirectAwaitedPair(
    submitCallback, "acquireProviderAdmission", "generateLocalImageCandidate", "image candidate callback",
  );
  assertWhitelistedRoutePairAncestry(workflowDispatch, "workflow", sourceFile);
  assertWhitelistedRoutePairAncestry(candidateHelperCall, "candidate", sourceFile);

  const helperCalls = scopeCalls(helper.body);
  const helperAuditedCalls = helperCalls.filter(call => resolvedCanonicalCall(call, bindings) === "fetchAuditedImageProviderPost");
  assert.equal(helperAuditedCalls.length, 1, "generateLocalImageCandidate must have exactly one audited provider POST");
  assert.ok(directIdentifierCall(helperAuditedCalls[0], "fetchAuditedImageProviderPost"),
    "generateLocalImageCandidate must call the audited POST through its direct lexical binding");
  assert.ok(directAwaitedStatement(helperAuditedCalls[0], helper.body),
    "generateLocalImageCandidate audited provider POST must be a direct awaited statement");

  const earlyReturns: ts.ReturnStatement[] = [];
  walkExecutionScope(helper.body, node => {
    if (ts.isReturnStatement(node) && node.getStart(sourceFile) < helperAuditedCalls[0].getStart(sourceFile)) earlyReturns.push(node);
  });
  assert.equal(earlyReturns.length, 0, "generateLocalImageCandidate must not return before its audited provider POST");

  const canonicalSymbols = routeCanonicalSymbols(analysis);
  const reachable = collectReachableProviderCalls(analysis, [submitCallbackFunction], canonicalSymbols);
  const allAuditedCalls = allCalls(sourceFile).filter(call => (
    reachable.resolver.resolveCall(call).canonical.has("fetchAuditedImageProviderPost")
  ));
  assert.equal(allAuditedCalls.length, 2, "image route must expose exactly two direct-or-aliased audited provider POST call sites");
  assert.deepEqual(new Set(allAuditedCalls), new Set([workflowDispatch, helperAuditedCalls[0]]),
    "every audited provider POST alias or direct call must be covered by workflow or candidate admission");
  assert.deepEqual(reachable.auditedCalls, new Set([workflowDispatch, helperAuditedCalls[0]]),
    "submitOnce reachable call graph must contain only the two admission-covered audited POST dispatches");
  assertNoProtectedCallableEscapeInScopes(
    analysis,
    [analysis.sourceFile, ...[...reachable.functions].map(fn => fn.body), ...reachable.classes],
    canonicalSymbols,
  );
  assertNoDynamicCallableAccessInScopes(
    analysis,
    [analysis.sourceFile, ...[...reachable.functions].map(fn => fn.body), ...reachable.classes],
  );
  assert.ok(candidateHelperCall.getStart(sourceFile) > workflowDispatch.getStart(sourceFile),
    "candidate and workflow dispatch contracts must remain distinct executable branches");

  if (!checkBillingResponse) return;
  const variables: ts.VariableDeclaration[] = [];
  const properties: ts.PropertyAssignment[] = [];
  walkAll(sourceFile, node => {
    if (ts.isVariableDeclaration(node)) variables.push(node);
    if (ts.isPropertyAssignment(node)) properties.push(node);
  });
  assert.ok(variables.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "definiteNoResult"
    && variable.initializer && nodeContains(variable.initializer, node => ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && ts.isIdentifier(node.right) && node.right.text === "ImageRequestRejectedError")),
  "billing release must treat ImageRequestRejectedError as a definite no-result outcome");
  assert.ok(variables.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "admissionRejected"
    && variable.initializer && ["IMAGE_PROVIDER_ADMISSION_BUSY", "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE"].every(code => (
      nodeContains(variable.initializer!, node => ts.isStringLiteralLike(node) && node.text === code)
    ))), "admission response must classify busy and unavailable rejection codes");
  assert.ok(properties.some(property => property.name.getText(sourceFile).replaceAll(/['"]/gu, "") === "Retry-After"
    && nodeContains(property.initializer, node => ts.isPropertyAccessExpression(node) && node.name.text === "retryAfterSeconds")),
  "busy admission response must expose Retry-After seconds");
}

function imageRouteFixture(options: { workflow: string; candidate: string; helper: string; extra?: string }) {
  return `
    import { acquireProviderAdmission } from "@/lib/provider-admission-control";
    import { runImageExactlyOnce } from "@/lib/image-exactly-once";
    async function fetchImageUpstream(input: unknown, init?: RequestInit) { return await fetch(input, init); }
    async function fetchAuditedImageProviderPost(input: unknown) { return input; }
    async function generateLocalImageCandidate() { ${options.helper} }
    async function fixtureRoute() {
      await runImageExactlyOnce({
        beforeSubmitOnce: reserveImageBudgetOnce,
        submitOnce: async () => {
          if (effectiveMode === "workflow") { try { ${options.workflow} } catch {} }
          for (let index = 0; index < candidates.length; index += 1) { const candidate = candidates[index]; try { ${options.candidate} } finally {} }
        },
      });
    }
    ${options.extra || ""}
  `;
}

function exactlyOnceFixture(first: string, second: string) {
  return `export async function runImageExactlyOnce(options: any) {
    if (options.persistProviderResult) { try { ${first} } catch {} }
    try { ${second} } catch {}
  }`;
}

function verifyMaliciousImageRouteFixtures() {
  const valid = {
    workflow: "const lease = await acquireProviderAdmission({}); const submitted = await fetchAuditedImageProviderPost({ init: { method: 'POST' } });",
    candidate: "const lease = await acquireProviderAdmission({}); const image = await generateLocalImageCandidate();",
    helper: "const submitted = await fetchAuditedImageProviderPost({ init: { method: 'POST' } }); return submitted;",
  };
  assert.doesNotThrow(() => assertImageRouteAdmissionStructure(imageRouteFixture(valid), false));
  const mustReject = (fixture: string, pattern: RegExp, message: string) => {
    assert.throws(() => assertImageRouteAdmissionStructure(fixture, false), pattern, message);
  };
  mustReject(imageRouteFixture({ ...valid,
    workflow: "async function dead() { await acquireProviderAdmission({}); } const submitted = await fetchAuditedImageProviderPost({});",
  }), /same-block|unconditional/u, "dead nested admission must not guard dispatch");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await fake.acquireProviderAdmission({}); const submitted = await fake.fetchAuditedImageProviderPost({});",
  }), /receiver|direct/u, "fake receivers must not satisfy protected bindings");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await fake['acquireProviderAdmission']({}); const submitted = await fake['fetchAuditedImageProviderPost']({});",
  }), /receiver|element|direct/u, "element-access aliases must not satisfy protected bindings");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const f = fetch; await f(url, { method: 'POST' }); return submitted;",
  }), /raw network|audited wrapper|network call/u, "aliased direct POST must be blocked");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); let a; a = fetch; const b = a; await b(url, { method: 'POST' }); return submitted;",
  }), /raw network|audited wrapper/u, "assignment-based multi-hop raw POST alias must be blocked");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const { ['fetch']: post } = globalThis; await post(url, { method: 'POST' }); return submitted;",
  }), /destructured|destructure|shadowed/u, "computed fetch destructuring must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); Reflect.apply(fetch, null, [url, { method: 'POST' }]); return submitted;",
  }), /callable values|escape|direct lexical/u, "Reflect.apply raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const [post] = [fetch]; await post(url, { method: 'POST' }); return submitted;",
  }), /callable values|escape|direct lexical/u, "array-contained and destructured raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const bag = { post: fetch }; const { post } = bag; await post(url, { method: 'POST' }); return submitted;",
  }), /callable values|escape|direct lexical/u, "object-contained and destructured raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const bag = { post: fetch }; await bag.post(url, { method: 'POST' }); return submitted;",
  }), /callable values|escape|direct lexical/u, "object property raw POST dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; await globalThis[k](url, { method: 'POST' }); return submitted;",
  }), /dynamic global|computed callable|fail closed/u, "computed global fetch key must fail closed even when constant-foldable");
  for (const globalName of ["window", "global", "process"]) {
    mustReject(imageRouteFixture({ ...valid,
      helper: `const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; await ${globalName}[k](url, { method: 'POST' }); return submitted;`,
    }), /dynamic global|computed callable|fail closed/u, `${globalName} dynamic callable lookup must fail closed`);
  }
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; const { [k]: post } = globalThis; await post(url, { method: 'POST' }); return submitted;",
  }), /dynamic global|computed|fail closed/u, "computed variable global destructuring must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; const post = Reflect.get(globalThis, k); await post(url, { method: 'POST' }); return submitted;",
  }), /Reflect\.get|dynamic global|computed|fail closed/u, "Reflect.get of a dynamic global callable must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; const bag = { ...globalThis }; await bag[k](url, { method: 'POST' }); return submitted;",
  }), /object spread|dynamic global|computed|fail closed/u, "global object spread followed by dynamic dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'post'; await spreadUnknown(unknownSource, k); return submitted;",
    extra: "async function spreadUnknown(source: any, key: string) { const bag = { ...source }; await bag[key](url, { method: 'POST' }); }",
  }), /object spread|unknown-object-spread|computed|fail closed/u, "unknown object spread followed by dynamic dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; const bag: Record<string, unknown> = {}; bag[k] = globalThis[k]; await (bag[k] as typeof fetch)(url, { method: 'POST' }); return submitted;",
  }), /dynamic global|computed|property writes|fail closed|protected callable|lexical symbol/u, "computed callable property write and dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const k = 'fe' + 'tch'; const post = globalThis[k]; const bag = { post }; await invokeDynamic(bag.post); return submitted;",
    extra: "async function invokeDynamic(post: unknown) { Reflect.apply(post as Function, null, [url, { method: 'POST' }]); }",
  }), /dynamic global|Reflect\.get|computed|fail closed/u, "multi-layer computed lookup, container, parameter and Reflect.apply must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); const post = await makePost(); await post(url, { method: 'POST' }); const submitted = await fetchAuditedImageProviderPost({});",
    extra: "async function makePost() { return fetch; }",
  }), /callable values|escape|direct lexical/u, "factory-returned raw POST callable must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const carrier = new InstanceCarrier(); await carrier.post(url, { method: 'POST' }); return submitted;",
    extra: "class InstanceCarrier { post = fetch; }",
  }), /callable values|escape|direct lexical/u, "reachable class instance field containing fetch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); await StaticCarrier.post(url, { method: 'POST' }); return submitted;",
    extra: "class StaticCarrier { static post = fetch; }",
  }), /callable values|escape|direct lexical/u, "reachable static class field containing fetch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: `${valid.workflow} const d = fetchAuditedImageProviderPost; await d({ init: { method: 'POST' } });`,
  }), /exactly two|covered/u, "aliased third audited dispatch must be counted and blocked");
  mustReject(imageRouteFixture({ ...valid,
    workflow: `${valid.workflow} let d; d = fetchAuditedImageProviderPost; const e = d; await e({ init: { method: 'POST' } });`,
  }), /exactly two|covered/u, "assignment-aliased third audited dispatch must be counted and blocked");
  mustReject(imageRouteFixture({ ...valid,
    workflow: `${valid.workflow} Reflect.apply(fetchAuditedImageProviderPost, null, [{ init: { method: 'POST' } }]);`,
  }), /callable values|escape|direct lexical/u, "Reflect.apply third audited dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: `${valid.workflow} await AuditedCarrier.post({ init: { method: 'POST' } });`,
    extra: "class AuditedCarrier { static post = fetchAuditedImageProviderPost; }",
  }), /callable values|escape|direct lexical/u, "reachable class field containing audited dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); await invoke(fetch); return submitted;",
    extra: "async function invoke(post: typeof fetch) { await post(url, { method: 'POST' }); }",
  }), /callable values|escape|direct lexical/u, "protected raw callable passed as a parameter must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); await fetch.call(null, url, { method: 'POST' }); return submitted;",
  }), /callable values|escape|direct lexical|protected callable|lexical symbol/u, "Function.call raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); const post = fetch.bind(null); await post(url, { method: 'POST' }); return submitted;",
  }), /callable values|escape|direct lexical|protected callable|lexical symbol/u, "Function.bind raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    helper: "const submitted = await fetchAuditedImageProviderPost({}); await fetchImageUpstream(url, { method: 'GET', ...postOverride }); return submitted;",
  }), /spread-free|raw network|audited wrapper/u, "GET followed by a spread override must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "if (flag) { await acquireProviderAdmission({}); } const submitted = await fetchAuditedImageProviderPost({});",
  }), /same-block|unconditional/u, "dynamic conditional admission must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "if (flag) { const lease = await acquireProviderAdmission({}); const submitted = await fetchAuditedImageProviderPost({}); }",
  }), /whitelisted|workflow admission/u, "a conditionally guarded admission and dispatch pair must not bypass the route whitelist");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "try { await acquireProviderAdmission({}); } finally { await fetchAuditedImageProviderPost({}); }",
  }), /direct|same-block|unconditional/u, "try/finally split admission must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    candidate: "const lease = await acquireProviderAdmission({}); await generateLocalImageCandidateSevered();",
  }), /generateLocalImageCandidate/u, "severed helper calls must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); async function nestedPost() { await fetch(url, { method: 'POST' }); } await nestedPost(); const submitted = await fetchAuditedImageProviderPost({});",
  }), /raw network|audited wrapper/u, "actually called nested raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); await topLevelPost(); const submitted = await fetchAuditedImageProviderPost({});",
    extra: "async function topLevelPost() { await fetch(url, { method: 'POST' }); }",
  }), /raw network|audited wrapper/u, "actually called top-level raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); const sender = new RawSender(); await sender.send(); const submitted = await fetchAuditedImageProviderPost({});",
    extra: "class RawSender { async send() { await fetch(url, { method: 'POST' }); } }",
  }), /raw network|audited wrapper/u, "actually called class method raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); await rawSender.send(); const submitted = await fetchAuditedImageProviderPost({});",
    extra: "const rawSender = { async send() { await fetch(url, { method: 'POST' }); } };",
  }), /raw network|audited wrapper/u, "actually called object method raw POST must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    extra: "generateLocalImageCandidate = async () => await fetch(url, { method: 'POST' });",
  }), /assigned|protected-write|must not be|raw network|audited wrapper/u, "helper reassignment must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "return early; const lease = await acquireProviderAdmission({}); const submitted = await fetchAuditedImageProviderPost({});",
  }), /return\/throw|abrupt|unconditional/u, "early return before admission must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission({}); if (flag) return early; const submitted = await fetchAuditedImageProviderPost({});",
  }), /return\/throw|abrupt/u, "conditional early return between admission and dispatch must fail closed");
  mustReject(imageRouteFixture({ ...valid,
    workflow: "const lease = await acquireProviderAdmission?.({}); const submitted = await fetchAuditedImageProviderPost({});",
  }), /optional|unconditional|same-block/u, "optional admission calls must fail closed");
  assert.doesNotThrow(() => assertImageRouteAdmissionStructure(imageRouteFixture({ ...valid,
    extra: "class DeadDecoy { async send() { await fetch(url, { method: 'POST' }); } }",
  }), false), "unreachable dead class raw POST decoys must not be treated as executable provider paths");

  const directHooks = "await options.beforeSubmitOnce(record); await options.submitOnce(context);";
  assert.doesNotThrow(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(directHooks, directHooks)));
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "if (flag) await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /same-block|unconditional/u, "dynamic conditional billing hook must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "try { await options.beforeSubmitOnce(record); } finally { await options.submitOnce(context); }", directHooks,
  )), /same-block|unconditional/u, "try/finally split billing hook must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "options.beforeSubmitOnce = async () => {}; await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /rewritten|aliased|shadowed/u, "options hook rewrites must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "async function decoy(options: any) { return options; } await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /rewritten|aliased|shadowed/u, "options shadowing must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "const guardedOptions = options; await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /rewritten|aliased|shadowed/u, "options aliases must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "const { beforeSubmitOnce } = options; await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /rewritten|aliased|shadowed|destructured/u, "options hook destructuring must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "return early; await options.beforeSubmitOnce(record); await options.submitOnce(context);", directHooks,
  )), /return\/throw|abrupt/u, "early return before billing reservation must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "await options.beforeSubmitOnce(record); if (flag) return early; await options.submitOnce(context);", directHooks,
  )), /return\/throw|abrupt/u, "early return between billing reservation and submit must fail closed");
  assert.throws(() => assertExactlyOnceBillingBeforeSubmit(exactlyOnceFixture(
    "await options.beforeSubmitOnce?.(record); await options.submitOnce(context);", directHooks,
  )), /beforeSubmitOnce|unconditional|optional/u, "optional exactly-once hooks must fail closed outside the pinned production contract");
}

function verifyFullFileAstPinFixtures(imageRoute: string, imageExactlyOnce: string) {
  const mustRejectRouteDrift = (suffix: string, label: string) => {
    assert.throws(
      () => assertFullFileAstPin(
        `${imageRoute}\n${suffix}\n`,
        "src/app/api/image/generate/route.ts",
        PINNED_FULL_FILE_AST_DIGESTS.imageGenerateRoute,
        "image-generate-route",
      ),
      /FULL_FILE_AST_DRIFT image-generate-route current=[0-9a-f]{64} expected=[0-9a-f]{64}/u,
      label,
    );
  };

  const routeDriftFixtures = [
    {
      label: "namespace-aliased raw POST appended to the real route must trip the full-file pin",
      source: "namespace FullFileNamespaceAlias { export const post = fetch; export async function run() { await post('https://invalid.example', { method: 'POST' }); } }",
    },
    {
      label: "class static raw POST appended to the real route must trip the full-file pin",
      source: "class FullFileStaticRaw { static post = fetch; static async run() { await this.post('https://invalid.example', { method: 'POST' }); } }",
    },
    {
      label: "class static audited dispatch appended to the real route must trip the full-file pin",
      source: "class FullFileStaticAudited { static post = fetchAuditedImageProviderPost; static async run() { await this.post({ init: { method: 'POST' } }); } }",
    },
    {
      label: "Function constructor appended to the real route must trip the full-file pin",
      source: "const fullFileFunctionConstructor = Function(\"return fetch('https://invalid.example', { method: 'POST' })\");",
    },
    {
      label: "new Function appended to the real route must trip the full-file pin",
      source: "const fullFileNewFunction = new Function(\"return fetch('https://invalid.example', { method: 'POST' })\");",
    },
    {
      label: "Object.assign callable carrier appended to the real route must trip the full-file pin",
      source: "const fullFileAssignedCarrier = Object.assign({}, { post: fetch }); void fullFileAssignedCarrier;",
    },
    {
      label: "Proxy callable carrier appended to the real route must trip the full-file pin",
      source: "const fullFileProxyCarrier = new Proxy({ post: fetch }, {}); void fullFileProxyCarrier;",
    },
    {
      label: "unrelated top-level executable code appended to the real route must trip the full-file pin",
      source: "const FULL_FILE_NONCRITICAL_DRIFT = 'changed'; void FULL_FILE_NONCRITICAL_DRIFT;",
    },
  ] as const;
  for (const fixture of routeDriftFixtures) mustRejectRouteDrift(fixture.source, fixture.label);

  assert.throws(
    () => assertFullFileAstPin(
      `${imageExactlyOnce}\nconst FULL_FILE_EXACTLY_ONCE_NONCRITICAL_DRIFT = 'changed';\n`,
      "src/lib/image-exactly-once.ts",
      PINNED_FULL_FILE_AST_DIGESTS.imageExactlyOnce,
      "image-exactly-once",
    ),
    /FULL_FILE_AST_DRIFT image-exactly-once current=[0-9a-f]{64} expected=[0-9a-f]{64}/u,
    "unrelated top-level executable code appended to exactly-once must trip the full-file pin",
  );

  assert.doesNotThrow(() => assertFullFileAstPin(
    `// full-file AST pin deliberately ignores trivia\n${imageRoute}\n/* trailing comment only */\n`,
    "src/app/api/image/generate/route.ts",
    PINNED_FULL_FILE_AST_DIGESTS.imageGenerateRoute,
    "image-generate-route",
  ), "comment-only route changes must be allowed by the trivia-insensitive full-file AST pin");
  assert.doesNotThrow(() => assertFullFileAstPin(
    `\n\n${imageExactlyOnce}\n\n`,
    "src/lib/image-exactly-once.ts",
    PINNED_FULL_FILE_AST_DIGESTS.imageExactlyOnce,
    "image-exactly-once",
  ), "whitespace-only exactly-once changes must be allowed by the trivia-insensitive full-file AST pin");
  assert.throws(() => assertProtectedImageFullFilePins(
    `${imageRoute}\nconst WORKER_BRANCH_BYPASS_FIXTURE = true;\n`,
    imageExactlyOnce,
  ), /FULL_FILE_AST_DRIFT image-generate-route/u,
  "the same helper used before worker branching must reject injected route drift");
}

function assertFullFilePinGatePrecedesWorkerBranch(verifierSource: string) {
  const sourceFile = ts.createSourceFile(
    "scripts/verify-provider-admission-control-zero-cost.ts",
    verifierSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const main = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "main" && Boolean(statement.body)
  ));
  assert.ok(main?.body, "verifier must declare main with a block body");

  const statements = main.body.statements;
  const protectedSourceReadIndex = statements.findIndex((statement) => {
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.some((declaration) => {
      if (!ts.isArrayBindingPattern(declaration.name)) return false;
      const names = declaration.name.elements
        .filter(ts.isBindingElement)
        .map(element => ts.isIdentifier(element.name) ? element.name.text : "");
      return names.includes("imageRoute") && names.includes("imageExactlyOnce");
    });
  });
  const protectedPinIndex = statements.findIndex((statement) => (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name)
      && declaration.name.text === "protectedImageFullFilePins"
      && declaration.initializer !== undefined
      && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression)
      && declaration.initializer.expression.text === "assertProtectedImageFullFilePins"
    ))
  ));
  const workerBranchIndex = statements.findIndex((statement) => (
    ts.isIfStatement(statement)
    && ts.isIdentifier(unwrapExpression(statement.expression))
    && (unwrapExpression(statement.expression) as ts.Identifier).text === "workerMode"
  ));

  assert.ok(protectedSourceReadIndex >= 0, "main must read both protected image sources");
  assert.ok(protectedPinIndex > protectedSourceReadIndex,
    "main must pin protected image sources immediately after reading them");
  assert.ok(workerBranchIndex > protectedPinIndex,
    "main must enforce full-file AST pins before the workerMode branch");
  const sourceReadText = statements[protectedSourceReadIndex].getText(sourceFile);
  assert.match(sourceReadText, /projectRoot/u,
    "protected source reads must use the verifier-derived projectRoot");
  assert.doesNotMatch(sourceReadText, /workerRoot/u,
    "--root admission state must not influence protected source reads");
}

async function main() {
  // This gate deliberately precedes every CLI/worker branch. projectRoot is derived
  // from this verifier's own location; --root is reserved for admission state only.
  const [imageRoute, imageExactlyOnce] = await Promise.all([
    readFile(path.join(projectRoot, "src/app/api/image/generate/route.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/lib/image-exactly-once.ts"), "utf8"),
  ]);
  const protectedImageFullFilePins = assertProtectedImageFullFilePins(imageRoute, imageExactlyOnce);

  const syntheticOwnerToken = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  if (workerMode) {
  const controller = new ProviderAdmissionController({ rootDir: workerRoot });
  try {
    const lease = await controller.acquire({
      provider: "relay-a",
      channel: "channel-a",
      model: "model-a",
      globalLimit: 2,
      providerLimit: 2,
      channelLimit: 1,
      modelLimit: 1,
      ttlMs: 5_000,
    });
    await lease.release();
    process.stdout.write("acquired");
  } catch (error) {
    if (error instanceof ProviderAdmissionBusyError) {
      process.stdout.write(`busy:${error.scope}:${error.retryAfterSeconds}`);
      process.exitCode = 23;
    } else {
      throw error;
    }
  }
} else {
  const [llmRoute, videoRoute, verifierSource] = await Promise.all([
    readFile(path.join(projectRoot, "src/app/api/llm/route.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/app/api/video/generate/route.ts"), "utf8"),
    readFile(fileURLToPath(import.meta.url), "utf8"),
  ]);
  verifyFullFileAstPinFixtures(imageRoute, imageExactlyOnce);
  assertFullFilePinGatePrecedesWorkerBranch(verifierSource);

  const rootDir = await mkdtemp(path.join(os.tmpdir(), "provider-admission-zero-cost-"));
  try {
    const mutexFile = path.join(rootDir, "leases.lock");
    const activeToken = syntheticOwnerToken("1");
    await writeFile(mutexFile, JSON.stringify({
      schemaVersion: "provider_admission_mutex.v1",
      ownerToken: activeToken,
      pid: process.pid,
      acquiredAt: Date.now() - 60_000,
    }));
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(mutexFile, oldTime, oldTime);
    const activeController = new ProviderAdmissionController({ rootDir });
    await assert.rejects(() => activeController.acquire({
      provider: "active", channel: "active", model: "active", ttlMs: 5_000,
    }), ProviderAdmissionUnavailableError);
    const activeOwner = JSON.parse(await readFile(mutexFile, "utf8")) as { ownerToken: string };
    assert.equal(activeOwner.ownerToken, activeToken, "active old mutex was stolen after stale timeout");

    const replacementToken = syntheticOwnerToken("2");
    await writeFile(mutexFile, JSON.stringify({
      schemaVersion: "provider_admission_mutex.v1",
      ownerToken: replacementToken,
      pid: process.pid,
      acquiredAt: Date.now(),
    }));
    const privateController = activeController as unknown as {
      removeMutexOwnedBy(token: string, reason: "release" | "stale"): Promise<boolean>;
    };
    assert.equal(await privateController.removeMutexOwnedBy(activeToken, "release"), false);
    const replacementOwner = JSON.parse(await readFile(mutexFile, "utf8")) as { ownerToken: string };
    assert.equal(replacementOwner.ownerToken, replacementToken, "old mutex owner deleted replacement lock");
    await unlink(mutexFile);

    await writeFile(mutexFile, JSON.stringify({
      schemaVersion: "provider_admission_mutex.v1",
      ownerToken: syntheticOwnerToken("3"),
      pid: 999_999,
      acquiredAt: Date.now() - 60_000,
    }));
    await utimes(mutexFile, oldTime, oldTime);
    const recoveredMutexLease = await activeController.acquire({
      provider: "dead-owner", channel: "dead-owner", model: "dead-owner", ttlMs: 5_000,
    });
    await recoveredMutexLease.release();
    await assert.rejects(() => readFile(mutexFile, "utf8"), (error: unknown) => (
      (error as NodeJS.ErrnoException)?.code === "ENOENT"
    ));

    const controller = new ProviderAdmissionController({ rootDir });
    const first = await controller.acquire({
      provider: "relay-a",
      channel: "channel-a",
      model: "model-a",
      globalLimit: 2,
      providerLimit: 2,
      channelLimit: 1,
      modelLimit: 1,
      ttlMs: 5_000,
    });

    const runner = path.resolve("scripts/run-node-maintenance-tsx.mjs");
    const script = "scripts/verify-provider-admission-control-zero-cost.ts";
    const childResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [runner, script, "--worker", "--root", rootDir], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(childResult.code, 23, childResult.stderr);
    assert.match(childResult.stdout, /^busy:(?:channel|model):[1-9]\d*$/u);

    await first.release();
    const second = await controller.acquire({
      provider: "relay-a",
      channel: "channel-a",
      model: "model-a",
      globalLimit: 1,
      providerLimit: 1,
      channelLimit: 1,
      modelLimit: 1,
      ttlMs: 5_000,
    });

    let releaseObserved = false;
    const trackedLease = {
      ...second,
      async release() {
        releaseObserved = true;
        await second.release();
      },
    };
    const response = await holdProviderAdmissionUntilResponseEnds(new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("one"));
        setTimeout(() => {
          stream.enqueue(new TextEncoder().encode("two"));
          stream.close();
        }, 20);
      },
    })), trackedLease);
    assert.equal(releaseObserved, false, "stream lease released before response completion");
    assert.equal(await response.text(), "onetwo");
    assert.equal(releaseObserved, true, "stream lease was not released at response completion");

    let responseReleaseAttempts = 0;
    const failedReleaseResponse = await holdProviderAdmissionUntilResponseEnds(new Response("done"), {
      leaseId: "observable-release-failure",
      expiresAt: Date.now() + 5_000,
      release: async () => {
        responseReleaseAttempts += 1;
        throw new Error("INJECTED_RESPONSE_RELEASE_FAILURE");
      },
    });
    await assert.rejects(() => failedReleaseResponse.text(), /INJECTED_RESPONSE_RELEASE_FAILURE/u);
    assert.ok(responseReleaseAttempts >= 1, "response-end release failure was not observed");

    let injectedReleaseFailure = true;
    const retryRoot = await mkdtemp(path.join(os.tmpdir(), "provider-admission-release-retry-"));
    try {
      const retryController = new ProviderAdmissionController({
        rootDir: retryRoot,
        releaseRetryLimit: 1,
        beforeStateWrite(state) {
          if (injectedReleaseFailure && state.leases.length === 0) {
            injectedReleaseFailure = false;
            throw new Error("INJECTED_RELEASE_WRITE_FAILURE");
          }
        },
      });
      const retryLease = await retryController.acquire({
        provider: "retry", channel: "retry", model: "retry", ttlMs: 5_000,
      });
      const firstRelease = retryLease.release();
      assert.strictEqual(retryLease.release(), firstRelease, "concurrent release did not reuse one in-flight promise");
      await assert.rejects(firstRelease, ProviderAdmissionUnavailableError);
      const heldState = JSON.parse(await readFile(path.join(retryRoot, "leases.json"), "utf8")) as { leases: unknown[] };
      assert.equal(heldState.leases.length, 1, "failed durable release was silently marked successful");
      await retryLease.release();
      const clearedState = JSON.parse(await readFile(path.join(retryRoot, "leases.json"), "utf8")) as { leases: unknown[] };
      assert.equal(clearedState.leases.length, 0, "release retry did not clear durable lease");
    } finally {
      await rm(retryRoot, { recursive: true, force: true });
    }

    const stateFile = path.join(rootDir, "leases.json");
    const current = JSON.parse(await readFile(stateFile, "utf8")) as { leases: unknown[] };
    assert.equal(current.leases.length, 0);
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: "provider_admission_control.v1",
      leases: [{
        leaseId: "expired",
        providerKey: "provider:expired",
        channelKey: "channel:expired",
        modelKey: "model:expired",
        ownerPid: 999_999,
        acquiredAt: 1,
        expiresAt: 2,
      }],
    }));
    const recovered = await controller.acquire({
      provider: "relay-b",
      channel: "channel-b",
      model: "model-b",
      globalLimit: 1,
      providerLimit: 1,
      channelLimit: 1,
      modelLimit: 1,
      ttlMs: 5_000,
    });
    await recovered.release();
    const recoveredState = JSON.parse(await readFile(stateFile, "utf8")) as { leases: unknown[] };
    assert.equal(recoveredState.leases.length, 0, "expired crash lease was not reclaimed");

    assert.ok(llmRoute.indexOf("llmRequestAttemptStore.claim") < llmRoute.indexOf("providerAdmissionLease = await acquireProviderAdmission({"), "LLM admission must follow durable claim");
    assert.match(llmRoute, /reserveLlmStreamCredits[\s\S]*?await acquireLlmProviderAdmission\(\);[\s\S]*?await markLlmProviderStarted\(\);/u);
    assert.match(llmRoute, /holdProviderAdmissionUntilResponseEnds\(response, lease\)/u);
    assert.ok(videoRoute.indexOf("reserveVideoGenerationTask({") < videoRoute.indexOf("providerAdmissionLease = await acquireProviderAdmission({"), "video admission must follow durable reservation");
    assert.match(videoRoute, /providerAdmissionError[\s\S]*?markVideoSubmissionFailed\([\s\S]*?Retry-After/u);
    assertExactlyOnceBillingBeforeSubmit(imageExactlyOnce, true);
    assertImageRouteAdmissionStructure(imageRoute);
    verifyMaliciousImageRouteFixtures();

    console.log("provider admission control zero-cost verifier: PASS");
    console.log(`- image route full-file AST: current=${protectedImageFullFilePins.imageRoute.current} expected=${protectedImageFullFilePins.imageRoute.expected}`);
    console.log(`- image exactly-once full-file AST: current=${protectedImageFullFilePins.imageExactlyOnce.current} expected=${protectedImageFullFilePins.imageExactlyOnce.expected}`);
    console.log("- full-file AST policy: comments/whitespace are trivia and allowed; all parsed AST drift is rejected");
    console.log("- cross-process channel/model limit: PASS");
    console.log("- global and dimension leases are file-backed and atomic: PASS");
    console.log("- response lifetime release and expired crash recovery: PASS");
    console.log("- response-end release failures are observable: PASS");
    console.log("- active mutex fencing, owner-token release and retryable durable release: PASS");
    console.log("- image symbol-bound reachable call graph, pinned AST contracts and malicious fail-closed fixtures: PASS");
    console.log("- LLM/video/image durable ordering and billing-safe admission rejection: PASS");
    console.log("- network calls: 0; provider calls: 0; production writes: 0");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
