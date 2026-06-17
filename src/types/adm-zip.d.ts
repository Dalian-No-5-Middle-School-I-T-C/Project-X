/** Minimal type declaration for adm-zip */
declare module "adm-zip" {
  interface IZipEntry {
    entryName: string;
    isDirectory: boolean;
    getData(): Buffer;
  }
  class AdmZip {
    constructor(filePathOrBuffer?: string | Buffer);
    getEntries(): IZipEntry[];
    extractAllTo(targetPath: string, overwrite: boolean): void;
    extractEntryTo(entry: IZipEntry | string, targetPath: string, maintainEntryPath?: boolean, overwrite?: boolean): void;
  }
  export = AdmZip;
}
