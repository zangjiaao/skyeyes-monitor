import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) db.exec(readFileSync(`migrations/${name}`, "utf8"));
  return db;
}

export function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql.replace(/\?(\d+)/g, "?"));
      const bound = (binds: unknown[]) => {
        const args = binds.map((value) => (value === undefined ? null : value)) as SQLInputValue[];
        return {
          all: async () => ({ results: args.length === 0 ? statement.all() : statement.all(...args) }),
          first: async () => (args.length === 0 ? statement.get() : statement.get(...args)) ?? null,
          run: async () => {
            const info = args.length === 0 ? statement.run() : statement.run(...args);
            return { meta: { changes: Number(info.changes ?? 0) }, results: [] };
          },
        };
      };
      return { bind: (...binds: unknown[]) => bound(binds), ...bound([]) };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}
