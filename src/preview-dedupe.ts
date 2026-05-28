// Hover preview deduplication helpers extracted from extension.ts (Phase 8).
//
// Scope:
//   * IR_DIRECT_HOVER_MARKER — sentinel HTML comment we embed in our own
//     direct-hover output so the wrap pipeline can recognise it.
//   * HOVER_PREVIEW_SEPARATOR — the `\n\n---\n` markdown rule between
//     preview blocks we append.
//   * normalizeHoverMarkdownForDedupe — collapse whitespace + strip our
//     own marker so two semantically-identical blocks hash the same.
//   * splitHoverPreviewBlocks — break a multi-block markdown body on the
//     separator into individual blocks.
//   * hoverMarkdownCodeFenceKeys — pull out the code-fence bodies of a
//     block as dedupe keys.
//   * hoverPreviewDedupeKeys — combine whole-block + code-fence keys for
//     a single block.
//   * dedupeHoverPreviewBlocks — keep the first occurrence of each
//     dedupe-key family.
//
// All pure string functions. No external state.

export const IR_DIRECT_HOVER_MARKER = '<!--ir-direct-hover-->';
export const HOVER_PREVIEW_SEPARATOR = '\n\n---\n';

export function normalizeHoverMarkdownForDedupe(text: string): string {
  return text
    .split(IR_DIRECT_HOVER_MARKER).join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitHoverPreviewBlocks(markdown: string): string[] {
  return markdown
    .split(/\n\s*---\s*\n/g)
    .map(part => part.trim())
    .filter(Boolean);
}

export function hoverMarkdownCodeFenceKeys(markdown: string): string[] {
  const out: string[] = [];
  const fenceRe = /```[\w-]*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    const key = normalizeHoverMarkdownForDedupe(match[1] ?? '');
    if (key) { out.push(`fence:${key}`); }
  }
  return out;
}

export function hoverPreviewDedupeKeys(block: string): string[] {
  const keys: string[] = [];
  const blockKey = normalizeHoverMarkdownForDedupe(block);
  if (blockKey) { keys.push(`block:${blockKey}`); }
  keys.push(...hoverMarkdownCodeFenceKeys(block));
  return keys;
}

export function dedupeHoverPreviewBlocks(blocks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const keys = hoverPreviewDedupeKeys(block);
    if (!keys.length || keys.some(key => seen.has(key))) { continue; }
    for (const key of keys) { seen.add(key); }
    out.push(block);
  }
  return out;
}
