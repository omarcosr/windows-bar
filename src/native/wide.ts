export function encodeWide(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
  return bytes;
}

export function decodeWide(buffer: ArrayBufferLike, offset: number, length: number): string {
  const view = new DataView(buffer, offset, length);
  let text = "";
  for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(i, true));
  return text;
}
