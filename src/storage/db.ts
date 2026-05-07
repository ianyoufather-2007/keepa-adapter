import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import initSqlJs from "sql.js";

type SqlValue = number | string | Uint8Array | null;

interface SqlJsStatement {
  bind(values?: SqlValue[]): boolean;
  free(): boolean;
  get(): SqlValue[];
  getAsObject(): Record<string, SqlValue>;
  step(): boolean;
}

interface SqlJsDatabase {
  close(): void;
  exec(sql: string): unknown[];
  export(): Uint8Array;
  getRowsModified(): number;
  prepare(sql: string): SqlJsStatement;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | null) => SqlJsDatabase;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface StatementLike {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface DatabaseLike {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): StatementLike;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export async function initDb(dbPath?: string): Promise<DatabaseLike> {
  const SQL = await loadSqlJs();
  const resolvedPath = resolveDbPath(dbPath);
  const fileData =
    resolvedPath && existsSync(resolvedPath)
      ? new Uint8Array(readFileSync(resolvedPath))
      : undefined;
  const db = new SqlJsDatabaseAdapter(new SQL.Database(fileData), resolvedPath);

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_asins (
      asin TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'com',
      label TEXT,
      parent_asin_expected TEXT,
      priority TEXT NOT NULL DEFAULT 'standard',
      active INTEGER NOT NULL DEFAULT 1,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (asin, domain)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'com',
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
      amazon_price REAL,
      new_price REAL,
      sales_rank INTEGER,
      rating REAL,
      review_count INTEGER,
      buy_box_seller_id TEXT,
      buy_box_is_amazon INTEGER,
      buy_box_price REAL,
      title TEXT,
      images_json TEXT,
      features_json TEXT,
      description TEXT,
      parent_asin TEXT,
      child_asins_json TEXT,
      variation_attributes_json TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_asin_domain
      ON snapshots (asin, domain, snapshot_at DESC);

    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'com',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_changes_asin_domain
      ON changes (asin, domain, detected_at DESC);

    CREATE TABLE IF NOT EXISTS promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'com',
      promo_type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_promos_asin
      ON promos (asin, domain);

    CREATE TABLE IF NOT EXISTS approved_variation_values (
      asin TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'com',
      attribute_name TEXT NOT NULL,
      approved_value TEXT NOT NULL,
      PRIMARY KEY (asin, domain, attribute_name)
    );
  `);

  // Migrations for existing databases
  const columns = db.prepare("PRAGMA table_info(snapshots)").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));
  if (!columnNames.has("subcategory_ranks_json")) {
    db.exec("ALTER TABLE snapshots ADD COLUMN subcategory_ranks_json TEXT");
  }

  // Phase 2 migrations
  const phase2Columns: [string, string][] = [
    ["monthly_sold", "INTEGER"],
    ["list_price", "REAL"],
    ["offer_count_new", "INTEGER"],
    ["offer_count_used", "INTEGER"],
    ["offer_count_fba", "INTEGER"],
    ["offer_count_fbm", "INTEGER"],
    ["out_of_stock_percentage_30", "INTEGER"],
    ["out_of_stock_percentage_90", "INTEGER"],
    ["is_sns", "INTEGER"],
    ["frequently_bought_together_json", "TEXT"],
  ];
  for (const [col, type] of phase2Columns) {
    if (!columnNames.has(col)) {
      db.exec(`ALTER TABLE snapshots ADD COLUMN ${col} ${type}`);
    }
  }

  return db;
}

function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({
    locateFile(file) {
      if (file.endsWith(".wasm")) {
        const require = createRequire(import.meta.url);
        return require.resolve(`sql.js/dist/${file}`);
      }
      return file;
    },
  }) as Promise<SqlJsStatic>;
  return sqlJsPromise;
}

function resolveDbPath(dbPath?: string): string | undefined {
  const configured = dbPath ?? process.env.KEEPA_DB_PATH;
  if (configured === ":memory:") return undefined;

  const rawPath = configured ?? join(homedir(), ".keepa-adapter", "keepa.db");
  const expandedPath = rawPath.startsWith("~/")
    ? join(homedir(), rawPath.slice(2))
    : rawPath;

  return isAbsolute(expandedPath) ? expandedPath : resolve(expandedPath);
}

class SqlJsDatabaseAdapter implements DatabaseLike {
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath?: string
  ) {}

  close(): void {
    this.persist();
    this.db.close();
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.persist();
  }

  pragma(sql: string): unknown {
    const statement = sql.trim().toUpperCase().startsWith("PRAGMA")
      ? sql
      : `PRAGMA ${sql}`;

    try {
      const result = this.db.exec(statement);
      this.persist();
      return result;
    } catch (err) {
      if (/journal_mode/i.test(statement)) return undefined;
      throw err;
    }
  }

  prepare(sql: string): StatementLike {
    return new SqlJsStatementAdapter(this, sql);
  }

  runStatement(sql: string, params: unknown[]): RunResult {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(normalizeParams(params));
      while (stmt.step()) {
        // Exhaust the statement so SQLite records row modifications.
      }
      const result = {
        changes: this.db.getRowsModified(),
        lastInsertRowid: this.scalarNumber("SELECT last_insert_rowid()"),
      };
      this.persist();
      return result;
    } finally {
      stmt.free();
    }
  }

  getStatement(
    sql: string,
    params: unknown[]
  ): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(normalizeParams(params));
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  allStatement(sql: string, params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(normalizeParams(params));
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private scalarNumber(sql: string): number {
    const stmt = this.db.prepare(sql);
    try {
      if (!stmt.step()) return 0;
      const value = stmt.get()[0];
      return typeof value === "number" ? value : Number(value ?? 0);
    } finally {
      stmt.free();
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, Buffer.from(this.db.export()));
  }
}

class SqlJsStatementAdapter implements StatementLike {
  constructor(
    private readonly db: SqlJsDatabaseAdapter,
    private readonly sql: string
  ) {}

  run(...params: unknown[]): RunResult {
    return this.db.runStatement(this.sql, params);
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.db.getStatement(this.sql, params);
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.db.allStatement(this.sql, params);
  }
}

function normalizeParams(params: unknown[]): SqlValue[] {
  return params.map((param) => {
    if (param === undefined) return null;
    if (param === null) return null;
    if (typeof param === "string" || typeof param === "number") return param;
    if (typeof param === "boolean") return param ? 1 : 0;
    if (typeof param === "bigint") return Number(param);
    if (param instanceof Uint8Array) return param;
    throw new TypeError(`Unsupported SQLite parameter type: ${typeof param}`);
  });
}
