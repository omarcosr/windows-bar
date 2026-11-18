import { pointerNumber, type Backend, type Signature, normalizePointer, type PointerArgument } from "./ffi-common.ts";

export function txikiBackend(ffi: typeof import("tjs:ffi")): Backend {
  const integer64 = (signed: boolean) => new ffi.AdvancedType(ffi.types[signed ? "sint64" : "uint64"], {
    name: signed ? "bigint64" : "biguint64",
    toBuffer(value: number | bigint) {
      const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
      if (signed) view.setBigInt64(0, BigInt(value), true); else view.setBigUint64(0, BigInt(value), true);
      return bytes;
    },
    fromBuffer(bytes: Uint8Array) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return signed ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
    },
  });
  const types: Record<string, any> = { void: ffi.types.void, ptr: ffi.types.pointer, function: ffi.types.pointer, i64: integer64(true), u64: integer64(false) };
  for (const [key, name] of Object.entries({ i8: "sint8", u8: "uint8", i16: "sint16", u16: "uint16", i32: "sint32", u32: "uint32", f32: "float", f64: "double" })) types[key] = ffi.types[name];
  const signatureOf = (signature: Signature) => ({ args: (signature.args ?? []).map(type => types[type]), returns: types[signature.returns ?? "void"] });
  const pointer = (input: PointerArgument) => {
      const value = normalizePointer(input);
    // txiki bufferToPointer already respects the view byteOffset (covered by the runtime probe).
      if (value instanceof Uint8Array) return ffi.bufferToPointer(value);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value ?? 0), true);
    return ffi.types.pointer.fromBuffer(bytes);
  };
  const address = (value: any) => {
    if (value == null) return null;
    const bytes = ffi.types.pointer.toBuffer(value);
    return pointerNumber(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
  };
  const buffer = (value: any, offset: number, length: number): ArrayBuffer => {
    const view = value.offset(offset).toArrayBuffer(length);
    try { return new Uint8Array(view).slice().buffer; } finally { view.detach(); }
  };
  return {
    open: (path, symbols) => ffi.dlopen(path, Object.fromEntries(Object.entries(symbols).map(([name, signature]) => [name, signatureOf(signature)]))),
    callback(fn, signature) {
      let callback: any = new ffi.JSCallback(types[signature.returns ?? "void"], (signature.args ?? []).map(type => types[type]), fn);
      return { ptr: callback.addr, close() { callback.close?.(); callback = null; } };
    },
    
    pointer, address, buffer,
    read(type, value, offset) {
      if (type === "ptr") return pointer(new DataView(buffer(value, offset, 8)).getBigUint64(0, true));
      if (type === "i64" || type === "u64") {
        const view = new DataView(buffer(value, offset, 8));
        return type === "i64" ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
      }
      return ffi.read[type]!(value, offset);
    },
  };
}
