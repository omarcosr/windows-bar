import { createRequire } from "node:module";
import { runtime } from "../native/ffi";

export interface ReadonlyDatabase {
  all<T extends object = Record<string, unknown>>(sql: string): T[];
  close(): void;
}

export async function openReadonly(path: string): Promise<ReadonlyDatabase> {
  if (runtime === "txiki") {
    const { Database } = await import("tjs:sqlite").catch(error => { throw error; });
    const db = new Database(path, { readOnly: true, create: false });
    return {
      all<T extends object>(sql: string): T[] {
        const statement = db.prepare(sql);
        try { return statement.all() as T[]; }
        finally { statement.finalize(); }
      },
      close: () => db.close(),
    };
  }
  const require = createRequire(import.meta.url);
  if (runtime === "bun") {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return { all: <T extends object>(sql: string) => db.query<T, []>(sql).all(), close: () => db.close() };
  }
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return { all: <T extends object>(sql: string) => db.prepare(sql).all() as T[], close: () => db.close() };
}
