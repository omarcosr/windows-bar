declare module "*.ps1" {
  const text: string;
  export default text;
}

declare module "node:ffi" {
  export interface Signature { arguments: string[]; return: string }
  export class DynamicLibrary {
    constructor(path: string);
    getFunction(name: string, signature: Signature): (...args: any[]) => any;
    registerCallback(signature: Signature, callback: (...args: any[]) => any): bigint;
    unregisterCallback(pointer: bigint): void;
    close(): void;
  }
  export function getRawPointer(buffer: Uint8Array): bigint;
  export function toArrayBuffer(pointer: bigint, length: number): ArrayBuffer;
}

declare module "tjs:ffi" {
  export const types: Record<string, any>;
  export const read: Record<string, (pointer: any, offset: number) => any>;
  export class AdvancedType {
    constructor(type: any, options: { name: string; toBuffer(value: any): Uint8Array; fromBuffer(buffer: Uint8Array): any });
  }
  export class JSCallback {
    constructor(returns: any, args: any[], callback: (...args: any[]) => any);
    readonly addr: any;
  }
  export function bufferToPointer(buffer: Uint8Array): any;
  export function dlopen(path: string, symbols: Record<string, { args: any[]; returns: any }>): { symbols: Record<string, (...args: any[]) => any>; close(): void };
}

declare module "tjs:sqlite" {
export class Database {
    constructor(path: string, options?: { readOnly?: boolean; create?: boolean });
    prepare(sql: string): { all(...params: any[]): Record<string, any>[]; run(...params: any[]): any; finalize(): void };
    close(): void;
  }
}

declare var __tarveTxikiFfi: typeof import("tjs:ffi") | undefined;
declare var tjs: { version: string; writeFile(path: string, data: Uint8Array): Promise<void>; exit(code?: number): never } | undefined;
