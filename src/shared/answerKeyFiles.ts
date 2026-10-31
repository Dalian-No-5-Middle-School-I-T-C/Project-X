/** OCR 与教师预览用的派生 JPEG。学生直发只读数据库登记的原文件，不读这个名字。 */
export const ANSWER_KEY_PREVIEW_SUFFIX = ".preview.jpg";

export function answerKeyPreviewFilename(baseName: string): string {
  return `${baseName}${ANSWER_KEY_PREVIEW_SUFFIX}`;
}
