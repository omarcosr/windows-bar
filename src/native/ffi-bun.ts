import { pointerNumber, type Backend, normalizePointer } from "./ffi.ts";

export function bunBackend(ffi: typeof import("bun:ffi")): Backend {
  return {
    open: (path, symbols) => ffi.dlopen(path, symbols as any) as any,
    callback: (fn, signature) => new ffi.JSCallback(fn, signature as any),
    pointer: input => {
      const value = normalizePointer(input);
      if (value instanceof Uint8Array) {
        // Materialize Bun inline storage before exposing an address; .buffer can relocate it.
        void value.buffer;
        return ffi.ptr(value);
      }
      return value === null ? null : pointerNumber(value);
    },
    address: pointerNumber,
    read: (type, pointer, offset) => (ffi.read as any)[type](pointer, offset),
    buffer: (pointer, offset, length) => ffi.toArrayBuffer(pointer, offset, length),
  };
}
