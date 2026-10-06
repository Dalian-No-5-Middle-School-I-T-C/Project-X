/** Minimal type declaration for adm-zip */
declare module "adm-zip" {
  interface IZipEntryHeader {
    /** ZIP 头部声明的**解压后**字节数——不可信输入，只做预拒（安全 R43），实际体积以读出的 Buffer 长度为准 */
    size: number;
    compressedSize: number;
    method: number;
  }
  interface IZipEntry {
    entryName: string;
    isDirectory: boolean;
    header: IZipEntryHeader;
    getData(): Buffer;
  }
  class AdmZip {
    constructor(filePathOrBuffer?: string | Buffer);
    getEntries(): IZipEntry[];
    addFile(entryName: string, content: Buffer | string, comment?: string): void;
    toBuffer(): Buffer;
    extractAllTo(targetPath: string, overwrite: boolean): void;
    extractEntryTo(entry: IZipEntry | string, targetPath: string, maintainEntryPath?: boolean, overwrite?: boolean): void;
  }
  export = AdmZip;
}
