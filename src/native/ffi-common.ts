/** Types and helpers the FFI backends share, kept apart from ffi.ts so the backends do not import it back (a cycle with its backend selection). */
export type Pointer = number;
export type FfiType = "void" | "ptr" | "function" | "bool" | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "f32" | "f64";
export interface Signature { args?: readonly FfiType[]; returns?: FfiType }
export type NativeFunction = ((...args: any[]) => any) & { close(): void };
export interface Backend {
  open(path: string, symbols: Record<string, Signature>): { symbols: Record<string, (...args: any[]) => any>; close(): void };
  callback(fn: (...args: any[]) => any, signature: Signature): { ptr: any; close(): void };
  pointer(value: PointerArgument): any;
  address(value: any): number | null;
  read(type: string, pointer: any, offset: number): any;
  buffer(pointer: any, offset: number, length: number): ArrayBuffer;
}
export type PointerArgument = Pointer | bigint | ArrayBufferView | ArrayBuffer | null;
export function normalizePointer(value: PointerArgument): number | bigint | Uint8Array | null {
  const normalized = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (normalized === null || typeof normalized === "number" || typeof normalized === "bigint" || normalized instanceof Uint8Array) return normalized;
  throw new TypeError("FFI ptr expects a number, bigint, null, ArrayBuffer or ArrayBufferView");
}
export function pointerNumber(value: bigint | number | null): number | null {
  if (value === null || value === 0 || value === 0n) return null;
  // Win32 also returns sign-extended handles (for example HDC), not only addresses.
  const number = Number(typeof value === "bigint" ? BigInt.asIntN(64, value) : value);
  if (!Number.isSafeInteger(number)) throw new RangeError("FFI pointer exceeds the safe integer range");
  return number;
}
