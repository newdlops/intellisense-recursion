// VS Code replaces everything after 100,000 UTF-16 code units in one Markdown
// item with an ellipsis. Split only at delivery time so caches, source locations
// and navigation history retain the original Markdown.
export const NATIVE_HOVER_MARKDOWN_LIMIT = 100_000;
const CHUNK_LENGTH = 64_000;

export function splitNativeHoverMarkdown(value: string): string[] {
  if (value.length <= NATIVE_HOVER_MARKDOWN_LIMIT) { return [value]; }
  const chunks: string[] = [];
  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
  let nextFence = fences.exec(value);
  let openFence: { marker: string; header: string } | undefined;
  let start = 0;
  while (start < value.length) {
    const prefix = openFence ? openFence.header + '\n' : '';
    let end = Math.min(value.length, start + CHUNK_LENGTH);
    if (end < value.length) {
      const newline = value.lastIndexOf('\n', end - 1);
      if (newline >= start) { end = newline + 1; }
      // A long source line can continue in the next block without dropping a
      // character or breaking a UTF-16 surrogate pair.
      if (end > start && /[\uD800-\uDBFF]/.test(value[end - 1])) { end--; }
    }
    while (nextFence && nextFence.index < end) {
      const marker = nextFence[1];
      if (!openFence) {
        openFence = { marker, header: nextFence[0] };
      } else if (marker[0] === openFence.marker[0]
        && marker.length >= openFence.marker.length && !nextFence[2].trim()) {
        openFence = undefined;
      }
      nextFence = fences.exec(value);
    }
    const suffix = openFence && end < value.length
      ? (value[end - 1] === '\n' ? '' : '\n') + openFence.marker : '';
    chunks.push(prefix + value.slice(start, end) + suffix);
    start = end;
  }
  return chunks;
}

/** Preserve provider metadata/range and leave ordinary hover results untouched. */
export function withCompleteHoverContents<T extends { contents?: any[] } | null | undefined>(result: T): T {
  if (!result?.contents?.some(content => typeof content?.value === 'string'
    && content.value.length > NATIVE_HOVER_MARKDOWN_LIMIT)) { return result; }
  return {
    ...result,
    contents: result.contents.flatMap(content => typeof content?.value === 'string'
      ? splitNativeHoverMarkdown(content.value).map(value => ({ ...content, value }))
      : [content]),
  };
}
