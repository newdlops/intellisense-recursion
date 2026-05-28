// Definition-preview structural helpers extracted from extension.ts
// (Phase 3b).
//
// Scope:
//   * The three shape interfaces (DefinitionPreview, TextLikeDocument,
//     RawFileSnapshot) used by every preview builder.
//   * The rawDefFileCache (LRU, max 24) — backing store for off-document
//     definition reads.
//   * Pure functions that locate a definition's enclosing source block:
//     header end (Python `def ... :`), block end (indentation or `}`),
//     value-definition end (multi-line const/let/var or Python `x = ...`),
//     decorator inclusion, decorator normalisation, refinement of an
//     LSP-reported line to the actual identifier-declaring line.
//
// All functions are pure and side-effect-free apart from the LRU mutation
// on the raw file cache. Dependencies are limited to ./util (preview
// length constants) and ./idents (declaration identifier matcher).

import {
  DEFINITION_PREVIEW_VALUE_MAX_LINES,
} from './util';
import { declarationIdentifiersInLine } from './idents';

export interface DefinitionPreview {
  previewStartLine: number;
  definitionLine: number;
  endLine: number;
  code: string;
}

export interface TextLikeDocument {
  languageId?: string;
  uri: { fsPath: string };
  lineCount: number;
  lineAt(line: number): { text: string };
}

export interface RawFileSnapshot extends TextLikeDocument {
  languageId: string;
  lines: string[];
}

export const RAW_DEF_FILE_CACHE_MAX = 24;
export const rawDefFileCache = new Map<string, {
  mtimeMs: number;
  size: number;
  snapshot: RawFileSnapshot;
}>();

/** Drop every cached raw file snapshot. Used on hard rebuild. */
export function clearRawDefFileCache(): void {
  rawDefFileCache.clear();
}
/** Drop a single raw file snapshot, e.g. after the user saves the file. */
export function evictRawDefFileCacheEntry(fsPath: string): void {
  rawDefFileCache.delete(fsPath);
}

export function isPythonLikeDoc(doc: TextLikeDocument): boolean {
  return doc.languageId === 'python' || doc.uri.fsPath.endsWith('.py') || doc.uri.fsPath.endsWith('.pyi');
}

export function indentationWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') { width++; }
    else if (ch === '\t') { width += 4; }
    else { break; }
  }
  return width;
}

export function includeLeadingDefinitionDecorators(doc: TextLikeDocument, line: number): number {
  let start = line;
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = doc.lineAt(i).text.trim();
    if (!trimmed) { break; }
    if (trimmed.startsWith('@') || trimmed.startsWith('#[')) { start = i; continue; }
    break;
  }
  return start;
}

export function normalizePythonDecoratedDefinitionLine(doc: TextLikeDocument, line: number): number {
  if (!isPythonLikeDoc(doc)) { return line; }
  const clamped = Math.max(0, Math.min(line, Math.max(0, doc.lineCount - 1)));
  const initial = doc.lineAt(clamped).text.trim();
  if (!initial.startsWith('@')) { return clamped; }

  for (let i = clamped + 1; i < doc.lineCount; i++) {
    const trimmed = doc.lineAt(i).text.trim();
    if (!trimmed) { continue; }
    if (trimmed.startsWith('@')) { continue; }
    if (/^(class|def|async\s+def)\b/.test(trimmed)) { return i; }
    return clamped;
  }
  return clamped;
}

export function textLikeLineDeclaresIdentifier(doc: TextLikeDocument, line: number, identifier: string): boolean {
  if (line < 0 || line >= doc.lineCount) { return false; }
  return declarationIdentifiersInLine(doc.lineAt(line).text).some(decl => decl.id === identifier);
}

export function refineDefinitionLineForIdentifier(
  doc: TextLikeDocument,
  identifier: string,
  preferredLine: number,
): number {
  const clamped = Math.max(0, Math.min(preferredLine, Math.max(0, doc.lineCount - 1)));
  if (!identifier || textLikeLineDeclaresIdentifier(doc, clamped, identifier)) { return clamped; }

  const normalizedDecoratedLine = normalizePythonDecoratedDefinitionLine(doc, clamped);
  if (normalizedDecoratedLine !== clamped && textLikeLineDeclaresIdentifier(doc, normalizedDecoratedLine, identifier)) {
    return normalizedDecoratedLine;
  }

  const searchRadius = 120;
  for (let offset = 1; offset <= searchRadius; offset++) {
    const before = clamped - offset;
    if (textLikeLineDeclaresIdentifier(doc, before, identifier)) { return before; }
    const after = clamped + offset;
    if (textLikeLineDeclaresIdentifier(doc, after, identifier)) { return after; }
  }

  for (let i = 0; i < doc.lineCount; i++) {
    if (textLikeLineDeclaresIdentifier(doc, i, identifier)) { return i; }
  }

  return clamped;
}

export function isPythonValueDefinitionLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) { return false; }
  if (/^(class|def|async\s+def|import|from|for|while|if|elif|else|try|except|finally|with|return|raise|yield|assert|del|global|nonlocal)\b/.test(trimmed)) {
    return false;
  }
  return /^\s*[A-Za-z_]\w*(?:\s*:\s*[^=]+)?\s*=/.test(text);
}

export function isBraceValueDefinitionLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) { return false; }
  if (/^(export\s+)?(default\s+)?(class|interface|enum|type|function)\b/.test(trimmed)) { return false; }
  return /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\b/.test(text)
    || /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|abstract\s+)*[A-Za-z_$][\w$]*\s*(?:[:=])/.test(text);
}

export function valueLineContinues(text: string, pythonLike: boolean): boolean {
  const trimmed = text.trim().replace(/\/\/.*$/, '');
  if (!trimmed) { return false; }
  if (pythonLike && trimmed.endsWith('\\')) { return true; }
  if (!pythonLike && /;\s*$/.test(trimmed)) { return false; }
  return /(?:[,=:+\-*/%&|^?.]|\b(?:and|or|is|in|as|extends|satisfies))$/.test(trimmed);
}

export function findValueDefinitionEndLine(doc: TextLikeDocument, definitionLine: number): number | null {
  const pythonLike = isPythonLikeDoc(doc);
  const firstLine = doc.lineAt(definitionLine).text;
  if (pythonLike ? !isPythonValueDefinitionLine(firstLine) : !isBraceValueDefinitionLine(firstLine)) {
    return null;
  }

  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let blockComment = false;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  const scanEnd = Math.min(doc.lineCount, definitionLine + DEFINITION_PREVIEW_VALUE_MAX_LINES);

  for (let i = definitionLine; i < scanEnd; i++) {
    const line = doc.lineAt(i).text;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      if (blockComment) {
        if (ch === '*' && next === '/') { blockComment = false; j++; }
        continue;
      }

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (pythonLike && ch === '#') { break; }
      if (!pythonLike && ch === '/' && next === '/') { break; }
      if (!pythonLike && ch === '/' && next === '*') { blockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || (!pythonLike && ch === '`')) { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
      if (!pythonLike && ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return i + 1;
      }
    }

    if (quote || blockComment || parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) { continue; }
    if (!valueLineContinues(line, pythonLike)) { return i + 1; }
  }

  return scanEnd;
}

export function findPythonHeaderEndLine(doc: TextLikeDocument, definitionLine: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = definitionLine; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (ch === '#') { break; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
      if (ch === ':' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return i;
      }
    }
  }

  return definitionLine;
}

export function findPythonBlockEndLine(doc: TextLikeDocument, definitionLine: number): number {
  const baseIndent = indentationWidth(doc.lineAt(definitionLine).text);
  const headerEndLine = findPythonHeaderEndLine(doc, definitionLine);
  for (let i = headerEndLine + 1; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.trim()) { continue; }
    if (indentationWidth(text) <= baseIndent) { return i; }
  }
  return doc.lineCount;
}

export function findBraceBlockEndLine(doc: TextLikeDocument, definitionLine: number): number | null {
  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let started = false;
  let blockComment = false;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = definitionLine; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      if (blockComment) {
        if (ch === '*' && next === '/') { blockComment = false; j++; }
        continue;
      }

      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }

      if (ch === '/' && next === '/') { break; }
      if (ch === '/' && next === '*') { blockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }

      if (ch === '{') {
        started = true;
        depth++;
        continue;
      }
      if (ch === '}' && started) {
        depth--;
        if (depth <= 0) { return i + 1; }
        continue;
      }
      if (!started && ch === ';' && parenDepth === 0 && bracketDepth === 0) {
        return i + 1;
      }
    }
  }

  return started ? doc.lineCount : null;
}
