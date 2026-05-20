#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/Users/lky/project/captain';
const sampleSize = Number(process.env.SNIPPET_SAMPLE_SIZE || process.argv[3] || 10_000);
const seedText = String(process.env.SNIPPET_SEED || process.argv[4] || '20260520');
const reportDir = process.env.SNIPPET_REPORT_DIR || path.resolve('reports/snippet-capture-random');

const DEFINITION_PREVIEW_FALLBACK_LINES = 120;
const DEFINITION_PREVIEW_SAFETY_MAX_LINES = 10_000;

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(items, n, rand) {
  const arr = items.slice();
  const limit = Math.min(n, arr.length);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, limit);
}

function indentationWidth(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

function includeLeadingDefinitionDecorators(lines, line) {
  let start = line;
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) break;
    if (trimmed.startsWith('@') || trimmed.startsWith('#[')) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

function findPythonHeaderEndLine(lines, definitionLine) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let escaped = false;

  for (let i = definitionLine; i < lines.length; i++) {
    const text = lines[i];
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = null; }
        continue;
      }
      if (ch === '#') break;
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}' && braceDepth > 0) { braceDepth--; continue; }
      if (ch === ':' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return i;
    }
  }
  return definitionLine;
}

function findPythonBlockEndLine(lines, definitionLine) {
  const baseIndent = indentationWidth(lines[definitionLine]);
  const headerEndLine = findPythonHeaderEndLine(lines, definitionLine);
  for (let i = headerEndLine + 1; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim()) continue;
    if (indentationWidth(text) <= baseIndent) return i;
  }
  return lines.length;
}

function findBraceBlockEndLine(lines, definitionLine) {
  let depth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let started = false;
  let blockComment = false;
  let quote = null;
  let escaped = false;

  for (let i = definitionLine; i < lines.length; i++) {
    const line = lines[i];
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
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { blockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')' && parenDepth > 0) { parenDepth--; continue; }
      if (ch === '[') { bracketDepth++; continue; }
      if (ch === ']' && bracketDepth > 0) { bracketDepth--; continue; }
      if (ch === '{') { started = true; depth++; continue; }
      if (ch === '}' && started) {
        depth--;
        if (depth <= 0) return i + 1;
        continue;
      }
      if (!started && ch === ';' && parenDepth === 0 && bracketDepth === 0) return i + 1;
    }
  }
  return started ? lines.length : null;
}

function collectDefinitionPreview(file, lines, requestedStartLine) {
  const definitionLine = Math.max(0, Math.min(requestedStartLine, Math.max(0, lines.length - 1)));
  const previewStartLine = includeLeadingDefinitionDecorators(lines, definitionLine);
  const isPythonLike = file.endsWith('.py') || file.endsWith('.pyi');
  const structuralEndLine = isPythonLike
    ? findPythonBlockEndLine(lines, definitionLine)
    : (findBraceBlockEndLine(lines, definitionLine)
      ?? Math.min(definitionLine + DEFINITION_PREVIEW_FALLBACK_LINES, lines.length));
  let endLine = structuralEndLine;
  if (endLine <= previewStartLine) {
    endLine = Math.min(previewStartLine + DEFINITION_PREVIEW_FALLBACK_LINES, lines.length);
  }
  const uncappedEndLine = endLine;
  endLine = Math.min(endLine, previewStartLine + DEFINITION_PREVIEW_SAFETY_MAX_LINES);
  const codeLines = lines.slice(previewStartLine, endLine);
  if (endLine < uncappedEndLine) codeLines.push(`... (${uncappedEndLine - endLine} more lines)`);
  return {
    previewStartLine,
    definitionLine,
    endLine,
    uncappedEndLine,
    lineCount: Math.max(0, endLine - previewStartLine),
    code: codeLines.join('\n'),
  };
}

const candidateRe = /^\s*(?:(async\s+def|def|class)\s+([A-Za-z_]\w*)\b|(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)\b|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b)/;

function enumerateCandidates() {
  const rg = spawnSync('rg', [
    '--json',
    '-n',
    '^\\s*(?:(?:async\\s+def|def|class)\\s+[A-Za-z_]\\w*\\b|(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|type|enum|function)\\s+[A-Za-z_$][\\w$]*\\b|(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\b)',
    root,
    '-g', '*.py',
    '-g', '*.pyi',
    '-g', '*.ts',
    '-g', '*.tsx',
    '-g', '*.js',
    '-g', '*.jsx',
    '-g', '!**/.venv/**',
    '-g', '!**/venv/**',
    '-g', '!**/node_modules/**',
    '-g', '!**/.git/**',
    '-g', '!**/.next/**',
    '-g', '!**/dist/**',
    '-g', '!**/build/**',
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  if (rg.error) throw rg.error;
  if (rg.status !== 0 && rg.status !== 1) {
    throw new Error(`rg failed with ${rg.status}: ${rg.stderr}`);
  }

  const candidates = [];
  for (const line of rg.stdout.split('\n')) {
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type !== 'match') continue;
    const file = item.data.path.text;
    const text = item.data.lines.text.replace(/\n$/, '');
    const match = candidateRe.exec(text);
    if (!match) continue;
    const pyKind = match[1];
    const pyName = match[2];
    const tsKind = match[3];
    const tsName = match[4];
    const varName = match[5];
    const kind = pyKind || tsKind || 'var';
    const name = pyName || tsName || varName;
    candidates.push({ file, line: item.data.line_number - 1, text, kind, name });
  }
  return candidates;
}

const fileCache = new Map();
function readLines(file) {
  let lines = fileCache.get(file);
  if (!lines) {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
    fileCache.set(file, lines);
  }
  return lines;
}

function firstBodyLine(lines, definitionLine) {
  const headerEnd = findPythonHeaderEndLine(lines, definitionLine);
  const baseIndent = indentationWidth(lines[definitionLine]);
  for (let i = headerEnd + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentationWidth(lines[i]) <= baseIndent) return null;
    return i;
  }
  return null;
}

function validateCandidate(candidate) {
  const lines = readLines(candidate.file);
  const preview = collectDefinitionPreview(candidate.file, lines, candidate.line);
  const failures = [];
  const warnings = [];
  const defText = lines[candidate.line] || '';
  const previewLines = preview.code.split('\n');
  const expectedStartText = lines[preview.previewStartLine] || '';

  if (!preview.code.includes(defText.trim())) {
    failures.push('definition-line-not-contained');
  }
  if (previewLines[0] !== expectedStartText) {
    failures.push('preview-start-mismatch');
  }

  if (candidate.file.endsWith('.py') || candidate.file.endsWith('.pyi')) {
    const expectedEnd = findPythonBlockEndLine(lines, candidate.line);
    const bodyLine = firstBodyLine(lines, candidate.line);
    if (bodyLine !== null && preview.endLine <= bodyLine) {
      failures.push(`body-line-not-included:${bodyLine + 1}`);
    }
    if (expectedEnd !== preview.uncappedEndLine) {
      failures.push(`python-end-mismatch:expected=${expectedEnd + 1}:actual=${preview.uncappedEndLine + 1}`);
    }
  } else {
    const braceEnd = findBraceBlockEndLine(lines, candidate.line);
    if (braceEnd === null) {
      warnings.push('brace-end-unverified-fallback');
    } else if (braceEnd !== preview.uncappedEndLine) {
      failures.push(`brace-end-mismatch:expected=${braceEnd + 1}:actual=${preview.uncappedEndLine + 1}`);
    }
  }

  if (preview.lineCount === 0) failures.push('empty-preview');
  if (preview.lineCount > DEFINITION_PREVIEW_SAFETY_MAX_LINES) failures.push('over-safety-cap');

  return {
    ...candidate,
    line: candidate.line + 1,
    previewStartLine: preview.previewStartLine + 1,
    endLine: preview.endLine,
    uncappedEndLine: preview.uncappedEndLine,
    lineCount: preview.lineCount,
    charCount: preview.code.length,
    failures,
    warnings,
    firstLine: defText.trim().slice(0, 180),
  };
}

function summarize(results, allCandidateCount) {
  const byExt = {};
  const byKind = {};
  const failureReasons = {};
  const warningReasons = {};
  let ok = 0;
  let failed = 0;
  let warned = 0;
  let capped = 0;
  let maxLines = 0;
  let maxChars = 0;
  for (const r of results) {
    const ext = path.extname(r.file) || '<none>';
    byExt[ext] = byExt[ext] || { total: 0, ok: 0, failed: 0, warned: 0 };
    byKind[r.kind] = byKind[r.kind] || { total: 0, ok: 0, failed: 0, warned: 0 };
    byExt[ext].total++;
    byKind[r.kind].total++;
    maxLines = Math.max(maxLines, r.lineCount);
    maxChars = Math.max(maxChars, r.charCount);
    if (r.lineCount >= DEFINITION_PREVIEW_SAFETY_MAX_LINES) capped++;
    if (r.failures.length) {
      failed++;
      byExt[ext].failed++;
      byKind[r.kind].failed++;
      for (const f of r.failures) failureReasons[f] = (failureReasons[f] || 0) + 1;
    } else {
      ok++;
      byExt[ext].ok++;
      byKind[r.kind].ok++;
    }
    if (r.warnings.length) {
      warned++;
      byExt[ext].warned++;
      byKind[r.kind].warned++;
      for (const w of r.warnings) warningReasons[w] = (warningReasons[w] || 0) + 1;
    }
  }
  return {
    root,
    seed: seedText,
    requestedSampleSize: sampleSize,
    allCandidateCount,
    tested: results.length,
    ok,
    failed,
    warned,
    capped,
    maxLines,
    maxChars,
    byExt,
    byKind,
    failureReasons,
    warningReasons,
  };
}

mkdirSync(reportDir, { recursive: true });
const candidates = enumerateCandidates();
const rand = mulberry32(hashSeed(seedText));
const sampled = sampleWithoutReplacement(candidates, sampleSize, rand);
const results = sampled.map(validateCandidate);
const summary = summarize(results, candidates.length);
const failures = results.filter(r => r.failures.length);
const warnings = results.filter(r => r.warnings.length);
const largest = results.slice().sort((a, b) => b.lineCount - a.lineCount).slice(0, 25);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(reportDir, `snippet-capture-${stamp}.json`);
const failPath = path.join(reportDir, `snippet-capture-failures-${stamp}.jsonl`);
const mdPath = path.join(reportDir, `snippet-capture-${stamp}.md`);

writeFileSync(jsonPath, JSON.stringify({ summary, largest, failures: failures.slice(0, 200), warnings: warnings.slice(0, 200) }, null, 2));
writeFileSync(failPath, failures.map(f => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''));
writeFileSync(mdPath, [
  '# Snippet Capture Random Test',
  '',
  `- root: \`${root}\``,
  `- seed: \`${seedText}\``,
  `- candidates from rg: ${candidates.length}`,
  `- tested: ${results.length}`,
  `- ok: ${summary.ok}`,
  `- failed: ${summary.failed}`,
  `- warned: ${summary.warned}`,
  `- capped: ${summary.capped}`,
  `- max lines: ${summary.maxLines}`,
  `- max chars: ${summary.maxChars}`,
  '',
  '## Failure Reasons',
  '```json',
  JSON.stringify(summary.failureReasons, null, 2),
  '```',
  '',
  '## Warning Reasons',
  '```json',
  JSON.stringify(summary.warningReasons, null, 2),
  '```',
  '',
  '## Largest Captures',
  ...largest.map(r => `- ${r.lineCount} lines ${path.relative(root, r.file)}:${r.line} ${r.kind} ${r.name}`),
  '',
  '## First Failures',
  ...failures.slice(0, 25).map(r => `- ${path.relative(root, r.file)}:${r.line} ${r.kind} ${r.name} ${r.failures.join(', ')}`),
  '',
].join('\n'));

console.log(JSON.stringify(summary, null, 2));
console.log(`json: ${jsonPath}`);
console.log(`failures: ${failPath}`);
console.log(`markdown: ${mdPath}`);
process.exit(failures.length ? 1 : 0);
