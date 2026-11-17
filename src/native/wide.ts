export function encodeWide(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return bytes;
}

/** UTF-16LE text at `offset` (`length` bytes; a trailing odd byte is dropped). */
export function decodeWide(buffer: ArrayBufferLike, offset: number, length: number): string {
  const count = length >> 1;
  if (offset % 2 !== 0) {
    // A Uint16Array view needs an even offset: copy the bytes out first (rare).
    return decodeWide(new Uint8Array(buffer, offset, count * 2).slice().buffer, 0, count * 2);
  }
  // Whole chunks at once instead of one string concatenation per character (~2x faster, measured);
  // chunked so a long text stays under the engines' argument count limit.
  const units = new Uint16Array(buffer, offset, count);
  if (count <= 4096) return String.fromCharCode.apply(null, units as unknown as number[]);
  let text = "";
  for (let i = 0; i < count; i += 4096) text += String.fromCharCode.apply(null, units.subarray(i, i + 4096) as unknown as number[]);
  return text;
}
