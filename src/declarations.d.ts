declare module "sql.js" {
  export type BindParams = unknown[] | Record<string, unknown>;

  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export class Database {
    run(sql: string, params?: BindParams): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: BindParams): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    get(): unknown[];
    free(): boolean;
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
