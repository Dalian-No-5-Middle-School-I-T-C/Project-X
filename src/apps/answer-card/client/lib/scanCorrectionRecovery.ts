import type { CorrectionDocument } from "../../../../shared/scanCorrection";

type Request = (url:string,init?:RequestInit)=>Promise<Response>;
/** Recognition runs on Ubuntu and returns an unsaved draft. */
export async function recoverCorrectionDocument(document:CorrectionDocument,url:string,request:Request):Promise<CorrectionDocument> {
  const missing = document.pages.filter(page=>page.recovery && !page.recognition.geometry);
  if (!missing.length) return document;
  const response = await request(`${url}/recognize`,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({version:document.version,pages:missing.map(p=>({sourceId:p.sourceId,fingerprint:p.recovery!.fingerprint}))})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "旧卷重新识别失败");
  const next = data as CorrectionDocument;
  if (next.version !== document.version || missing.some(p=>!next.pages.find(n=>n.sourceId===p.sourceId)?.recognition.geometry)) throw new Error("重新识别结果缺少坐标或版式不匹配");
  // Preserve edits on pages which already had alignment.
  return {...document,pages:document.pages.map(p=>missing.some(m=>m.sourceId===p.sourceId)?next.pages.find(n=>n.sourceId===p.sourceId)!:p)};
}
