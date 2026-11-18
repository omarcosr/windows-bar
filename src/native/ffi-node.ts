import { pointerNumber, type Backend, type Signature, normalizePointer } from "./ffi-common.ts";

export function nodeBackend(ffi: typeof import("node:ffi")): Backend {
  const types: Record<string, string> = { void: "void", ptr: "pointer", function: "function", i8: "int8", u8: "uint8", i16: "int16", u16: "uint16", i32: "int32", u32: "uint32", i64: "int64", u64: "uint64", f32: "float", f64: "double" };
  const signatureOf = (signature: Signature) => ({ arguments: (signature.args ?? []).map(type => types[type]!), return: types[signature.returns ?? "void"]! });
  const readers: Record<string, string> = { i8: "getInt8", u8: "getUint8", i16: "getInt16", u16: "getUint16", i32: "getInt32", u32: "getUint32", i64: "getInt64", u64: "getUint64", f32: "getFloat32", f64: "getFloat64", ptr: "getUint64" };
  return {
    open(path, symbols) {
      const lib = new ffi.DynamicLibrary(path);
      try { return { symbols: Object.fromEntries(Object.entries(symbols).map(([name, signature]) => [name, lib.getFunction(name, signatureOf(signature))])), close: () => lib.close() }; }
      catch (error) { lib.close(); throw error; }
    },
    callback(fn, signature) {
      const lib = new ffi.DynamicLibrary("kernel32.dll");
      try {
        const pointer = lib.registerCallback(signatureOf(signature), fn);
        return { ptr: pointer, close() { lib.unregisterCallback(pointer); lib.close(); } };
      } catch (error) { lib.close(); throw error; }
    },
    pointer: input => {
      const value = normalizePointer(input);
      return value instanceof Uint8Array ? ffi.getRawPointer(value) : BigInt.asUintN(64, BigInt(value ?? 0));
      },
    address: pointerNumber,
    read: (type, pointer, offset) => (ffi as any)[readers[type]!](pointer, offset),
    buffer: (pointer, offset, length) => ffi.toArrayBuffer(pointer + BigInt(offset), length),
  };
}
