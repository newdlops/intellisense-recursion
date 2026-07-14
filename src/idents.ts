// Identifier-shape helpers extracted from extension.ts (Phase 3a).
//
// Three exports:
//   * SKIP_WORDS — pure data, the noise filter for hover token extraction
//   * declarationIdentifiersInLine — pattern-matches the symbol name(s)
//     defined on a single source line (class/def/function/const decl,
//     plus an ALL_CAPS = value heuristic)
//   * decoratorIdentifiersInLine — pulls every identifier out of a
//     decorator expression on a single line
//   * addNavigableName — appends an identifier to an out-array if it
//     passes the SKIP_WORDS + shape filter (the original helper lives
//     near findTypeNames, but it only uses SKIP_WORDS + TYPE_SHAPED_NAME
//     so it travels with this module).
//
// No external state. All functions are pure modulo SKIP_WORDS.

import { TYPE_SHAPED_NAME } from './util';

// Only language keywords and documentation words — NOT type/variable names
export const SKIP_WORDS = new Set([
  // Language keywords (not navigable)
  'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'super', 'extends', 'implements',
  'import', 'export', 'default', 'from', 'as', 'of', 'in',
  'async', 'await', 'yield', 'throw', 'try', 'catch', 'finally',
  'def', 'self', 'pass', 'with', 'isinstance', 'property',
  'public', 'private', 'protected', 'static', 'abstract',
  'struct', 'union', 'typedef', 'extern', 'register',
  'virtual', 'inline', 'constexpr', 'namespace', 'using', 'template',
  // Documentation/markup words
  'the', 'The', 'that', 'will', 'are', 'was', 'has', 'have', 'can',
  'should', 'may', 'must', 'been', 'being', 'does', 'did', 'its',
  'also', 'than', 'then', 'when', 'where', 'which', 'what', 'how', 'who',
  'all', 'each', 'every', 'some', 'any', 'Returns', 'Raises', 'Args',
  'Parameters', 'Note', 'Example', 'param', 'throws', 'since', 'see',
  'deprecated', 'alias', 'overload', 'module', 'variable',
  // Common Python typing helpers are useful in signatures but noisy as
  // recursive previews; resolving them often points into stdlib/typeshed.
  'Any', 'None', 'Optional', 'Union', 'Callable', 'Type', 'Self',
  'List', 'Dict', 'Set', 'Tuple', 'Iterable', 'Iterator', 'Sequence', 'Mapping',
  // Modal verbs / common doc prose capitalized at sentence start
  'Cannot', 'Could', 'Would', 'Should',
  // Pronouns / demonstratives
  'This', 'That', 'These', 'Those', 'Here', 'There',
  // Temporal / hedging adverbs
  'Now', 'Then', 'Usually', 'Sometimes', 'Always', 'Never',
  'Often', 'Rarely', 'Initially', 'Finally',
  // Docstring headers we missed the first time
  'Warning', 'Warnings', 'See', 'Also', 'More', 'Given',
  'Available', 'Required', 'Reference', 'Examples',
  // Review / logging words
  'Copy', 'Wrap', 'Multiple', 'Make', 'Please', 'Raise',
  'Private', 'Subclasses', 'Implementation', 'Root',
  'Filesystem', 'Human', 'Last',
  // Linter codes that show up in comments
  'F401',
]);

export function addNavigableName(out: string[], seen: Set<string>, id: string, allowLowercaseDeclaration = false) {
  if (!id || seen.has(id) || SKIP_WORDS.has(id) || id.length <= 2) { return; }
  if (!allowLowercaseDeclaration && !TYPE_SHAPED_NAME.test(id)) { return; }
  seen.add(id);
  out.push(id);
}

export function declarationIdentifiersInLine(line: string): Array<{ id: string; index: number }> {
  const out: Array<{ id: string; index: number }> = [];
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) { return out; }

  const declarationPatterns = [
    /^(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:async\s+)?def\s+([A-Za-z_]\w*)\b/,
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
    /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/,
  ];

  for (const pattern of declarationPatterns) {
    const match = pattern.exec(trimmed);
    if (!match?.[1]) { continue; }
    const index = line.indexOf(match[1]);
    if (index >= 0) { out.push({ id: match[1], index }); }
    return out;
  }

  if (/^(?:if|elif|else|for|while|switch|case|return|throw|raise|yield|await|with|try|except|finally|from|import|new)\b/.test(trimmed)) {
    return out;
  }

  // A bare `foo()` line is a call, not a declaration. Requiring an explicit
  // declaration suffix keeps call sites from being promoted into definition
  // previews while still covering class/interface methods (`foo(): T`,
  // `foo() {`, and expression-bodied `foo() => ...`). Keyword-led functions
  // (`def`, `function`, ...) are handled by the patterns above.
  const methodMatch = /^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\([^=;{}]*\)\s*(?::|=>|\{)/.exec(trimmed);
  if (methodMatch?.[1]) {
    const index = line.indexOf(methodMatch[1]);
    if (index >= 0) { out.push({ id: methodMatch[1], index }); }
  }
  return out;
}

export function decoratorIdentifiersInLine(line: string): Array<{ id: string; index: number }> {
  const out: Array<{ id: string; index: number }> = [];
  if (!/^\s*@/.test(line)) { return out; }
  const expr = line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, match => ' '.repeat(match.length));
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(expr)) !== null) {
    const id = match[0];
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    out.push({ id, index: match.index });
  }
  return out;
}
