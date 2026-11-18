import { createRequire } from "node:module";
import { bunBackend } from "./ffi-bun.ts";
import { nodeBackend } from "./ffi-node.ts";
import { txikiBackend } from "./ffi-tjs.ts";
import { pointerFunction, PluginFfiUnsupportedError } from "@tarve/core";

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
export const runtime: "bun" | "node" | "txiki" = typeof globalThis.tjs !== "undefined" || globalThis.__tarveTxikiFfi ? "txiki" : globalThis.process?.versions?.bun ? "bun" : "node";
export class FfiUnsupported extends Error {
  constructor(message = "Raw function pointers are not supported by this FFI backend") { super(message); this.name = "FfiUnsupported"; }
}
export function pointerNumber(value: bigint | number | null): number | null {
  if (value === null || value === 0 || value === 0n) return null;
  // Win32 also returns sign-extended handles (for example HDC), not only addresses.
  const number = Number(typeof value === "bigint" ? BigInt.asIntN(64, value) : value);
  if (!Number.isSafeInteger(number)) throw new RangeError("FFI pointer exceeds the safe integer range");
  return number;
}
const require = createRequire(import.meta.url);
const backend: Backend = runtime === "txiki" ? txikiBackend(globalThis.__tarveTxikiFfi ?? await import("tjs:ffi").catch(error => { throw error; })) : runtime === "bun" ? bunBackend(require("bun:ffi")) : nodeBackend(require("node:ffi"));
const signatureOf = (signature: Signature): Signature => ({ args: (signature.args ?? []).map(type => type === "bool" ? "i32" : type), returns: signature.returns === "bool" ? "i32" : signature.returns ?? "void" });
function input(type: FfiType, value: any): any {
  if (type === "function") {
    const address = value instanceof JSCallback ? value.ptr : value;
    if (address !== null && typeof address !== "number" && typeof address !== "bigint") throw new TypeError("FFI function pointer expects a number, bigint, null or JSCallback");
    return backend.pointer(address);
  }
  if (type === "ptr") return backend.pointer(value);
  if (type === "i64" || type === "u64") return BigInt(value);
  return type === "bool" ? Number(value) : value;
}
function output(type: FfiType, value: any): any {
  if (type === "ptr" || type === "function") return backend.address(value);
  if (type === "i64" || type === "u64") return BigInt(value);
  return value;
}
function wrap(fn: (...args: any[]) => any, signature: Signature) {
  return (...values: any[]) => output(signature.returns ?? "void", fn(...(signature.args ?? []).map((type, index) => input(type, values[index]))));
}
export function dlopen<const S extends Record<string, Signature>>(path: string, symbols: S) {
  const lib = backend.open(path, Object.fromEntries(Object.entries(symbols).map(([name, signature]) => [name, signatureOf(signature)])));
  return { symbols: Object.fromEntries(Object.entries(symbols).map(([name, signature]) => [name, wrap(lib.symbols[name]!, signature)])) as { [K in keyof S]: (...args: any[]) => any }, close: () => lib.close() };
}
export class JSCallback {
  readonly ptr: Pointer | null;
  private readonly handle: ReturnType<Backend["callback"]>;
  private closed = false;
  constructor(fn: (...args: any[]) => any, signature: Signature) {
    this.handle = backend.callback((...values: any[]) => input(signature.returns ?? "void", fn(...(signature.args ?? []).map((type, index) => output(type, values[index])))), signatureOf(signature));
    this.ptr = backend.address(this.handle.ptr);
  }
  close() { if (!this.closed) { this.handle.close(); this.closed = true; } }
}
export interface CFunction extends NativeFunction {}
export const CFunction = class {
  constructor(options: Signature & { ptr: Pointer | bigint }) {
    const typeOf = (type: FfiType) => type === "function" ? "ptr" : type === "bool" ? "i32" : type;
    const args = options.args ?? [];
    const returns = options.returns ?? "void";
    let fn: (...values: any[]) => any;
    try {
      fn = pointerFunction(options.ptr, { args: args.map(typeOf), returns: typeOf(returns) });
    } catch (error) {
      if (error instanceof PluginFfiUnsupportedError) throw new FfiUnsupported(error.message);
      throw error;
    }
    const call = (...values: any[]) => {
      const result = fn(...args.map((type, index) => {
        let value = values[index];
        if (type === "function" && value instanceof JSCallback) value = value.ptr;
        if (type === "ptr") {
          const normalized = normalizePointer(value);
          return normalized instanceof Uint8Array ? ptr(normalized) : normalized;
        }
        if (type === "function") {
          if (value !== null && typeof value !== "number" && typeof value !== "bigint") throw new TypeError("FFI function pointer expects a number, bigint, null or JSCallback");
          return value;
          }
        if (type === "i64" || type === "u64") return BigInt(value);
        return type === "bool" ? Number(value) : value;
      }));
      return returns === "ptr" || returns === "function" ? pointerNumber(result as bigint) : output(returns, result);
    };
    // Tarve owns the call bridge; binding an address allocates no closeable native handle.
    return Object.assign(call, { close() {} });
  }
} as unknown as { new(options: Signature & { ptr: Pointer | bigint }): CFunction };
export function ptr(buffer: ArrayBufferView | ArrayBuffer): Pointer { return backend.address(backend.pointer(buffer))!; }
export function toArrayBuffer(pointer: Pointer | bigint, offset: number, length: number): ArrayBuffer { return backend.buffer(backend.pointer(pointer), offset, length); }
const reader = <T>(type: string) => (pointer: Pointer | bigint, offset = 0): T => output(type as FfiType, backend.read(type, backend.pointer(pointer), offset));
export const read = { i8: reader<number>("i8"), u8: reader<number>("u8"), i16: reader<number>("i16"), u16: reader<number>("u16"), i32: reader<number>("i32"), u32: reader<number>("u32"), i64: reader<bigint>("i64"), u64: reader<bigint>("u64"), f32: reader<number>("f32"), f64: reader<number>("f64"), ptr: reader<Pointer | null>("ptr") };

export type PointerArgument = Pointer | bigint | ArrayBufferView | ArrayBuffer | null;
export function normalizePointer(value: PointerArgument): number | bigint | Uint8Array | null {
  const normalized = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (normalized === null || typeof normalized === "number" || typeof normalized === "bigint" || normalized instanceof Uint8Array) return normalized;
  throw new TypeError("FFI ptr expects a number, bigint, null, ArrayBuffer or ArrayBufferView");
}

