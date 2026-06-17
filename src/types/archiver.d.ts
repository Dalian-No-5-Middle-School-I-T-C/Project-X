/** Minimal type declaration for archiver v8 ESM exports */
declare module "archiver" {
  interface ArchiverOptions {
    zlib?: { level?: number };
    statConcurrency?: number;
    store?: boolean;
  }

  class Archiver {
    constructor(options?: ArchiverOptions);
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    file(filePath: string, options: { name: string }): this;
    directory(dirPath: string, destPath: string | false): this;
    append(source: Buffer | string, options: { name: string }): this;
    finalize(): Promise<void>;
    on(event: "error", handler: (err: Error) => void): this;
    on(event: "warning" | "entry" | "progress" | "end" | "close" | "drain" | "finish" | "pipe" | "unpipe", handler: (...args: any[]) => void): this;
  }

  class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  class TarArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  class JsonArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  export { Archiver, ZipArchive, TarArchive, JsonArchive };
}
