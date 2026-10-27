import { recoverCorrectionDocument } from "../lib/scanCorrectionRecovery";
import { useEffect, useState } from "react";
import { authFetch } from "../auth/api";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, Tip } from "./ui/v2";
import { correctionState, isUnconfirmedCorrectionCell, toggleCorrectionCell, type CorrectionDocument, type CorrectionEdit } from "../../../../shared/scanCorrection";
import { CorrectionCanvas } from "./scanner-postprocess/CorrectionCanvas";
import { RotationButtons, type ImageRotation } from "./RotatedCardImage";

type Request = (url: string, init?: RequestInit) => Promise<Response>;
export function CardCorrectionButton({ url, request = authFetch, onSaved, disabled = false, disabledReason, allowUnchangedSave = false }: {
  url: string; request?: Request; onSaved?: () => void | Promise<void>; disabled?: boolean; disabledReason?: string; allowUnchangedSave?: boolean;
}) {
  const [open,setOpen] = useState(false);
  const trigger = <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>整卡改分</Button>;
  return <>{disabled && disabledReason ? <Tip label={disabledReason}>{trigger}</Tip> : trigger}
    {open && <CardCorrectionEditor url={url} request={request} onClose={() => setOpen(false)} onSaved={onSaved} allowUnchangedSave={allowUnchangedSave} />}</>;
}
export function CardCorrectionEditor({url,request = authFetch,onClose,onSaved,allowUnchangedSave=false}: {
  url:string; request?:Request; onClose:()=>void; onSaved?:()=>void|Promise<void>; allowUnchangedSave?:boolean;
}) {
  const [send] = useState(() => request);
  const [document,setDocument] = useState<CorrectionDocument|null>(null);
  const [edits,setEdits] = useState<CorrectionEdit[]>([]);
  const [images,setImages] = useState<Record<string,string>>({});
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [zoom,setZoom] = useState(1);
  const [rotation,setRotation] = useState<ImageRotation>(0);
  const [pageIndex,setPageIndex] = useState(0);
  const dirty = !!document && edits.some(edit => {
    const original = document.pages.find(p => p.sourceId === edit.sourceId)!;
    return [...original.selected].sort().join() !== [...edit.selected].sort().join() || !!edit.touched?.length || !!edit.recovery;
  });
  useEffect(() => {
    let alive = true;
    const urls:string[] = [];
    setBusy(true);
    void (async () => {
      try {
        const response = await send(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "加载答题卡失败");
        const doc = data as CorrectionDocument;
        const loaded:Record<string,string> = {};
        for (const page of doc.pages) {
          const image = await send(page.imageUrl);
          if (!image.ok) throw new Error("完整答题卡图片加载失败");
          const blob = URL.createObjectURL(await image.blob());
          if (!alive) { URL.revokeObjectURL(blob); return; }
          urls.push(blob); loaded[page.sourceId] = blob;
        }
        if (alive) { setDocument(doc); setImages(loaded); setEdits(doc.pages.map(p => ({sourceId:p.sourceId,revision:p.revision,selected:[...p.selected],touched:[]}))); }
      } catch (error) { if (alive) setMessage(error instanceof Error ? error.message : "加载失败"); }
      finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; urls.forEach(URL.revokeObjectURL); };
  },[url,send]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e:BeforeUnloadEvent) => {e.preventDefault(); e.returnValue = "";};
    window.addEventListener("beforeunload",warn);
    return () => window.removeEventListener("beforeunload",warn);
  },[dirty]);
  const close = () => { if (!busy && (!dirty || window.confirm("修改尚未保存，确定放弃本次修改？"))) onClose(); };
  const page = document?.pages[pageIndex], edit = edits[pageIndex];
  const missing = document?.pages.some(p=>!p.recognition.geometry) ?? false;
  const errors = document && !missing ? document.pages.flatMap((p,i) => correctionState(document.card,p,edits[i]?.selected ?? p.selected,edits[i]?.touched).errors) : [];
  async function recover() {
    if (!document) return;
    setBusy(true); setMessage("正在重新识别服务器旧卷…");
    try {
      const next = await recoverCorrectionDocument(document,url,send);
      setDocument(next);
      setEdits(next.pages.map(p=>p.recovery ? {sourceId:p.sourceId,revision:p.revision,selected:[...p.selected],touched:[],
        recovery:{fingerprint:p.recovery.fingerprint,signature:p.recovery.signature,recognition:p.recognition}} : edits.find(e=>e.sourceId===p.sourceId)!));
      setMessage("重新识别完成，结果尚未保存。核对后点击保存修改。");
    } catch(error) { setMessage(error instanceof Error?error.message:"重新识别失败"); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMessage("");
    try {
      const response = await send(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({pages:edits})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败");
      setEdits([]); setDocument(null);
      await onSaved?.(); onClose();
    } catch (error) {setMessage(error instanceof Error ? error.message : "保存失败");}
    finally {setBusy(false);}
  }
  function toggle(id:string) {
    if (!document || !page || busy) return;
    setEdits(current => current.map(e => e.sourceId === page.sourceId ? {...e, selected:toggleCorrectionCell(document.card,page,e.selected,id),touched:page.invalid.includes(id) || isUnconfirmedCorrectionCell(page,id) ? [...new Set([...(e.touched ?? []),id])] : e.touched} : e));
    setMessage("");
  }
  return <Dialog open onOpenChange={open => {if (!open) close();}}>
    <DialogContent size="lg" className="h-[calc(100vh-48px)] max-w-[1400px]" onInteractOutside={e => e.preventDefault()}>
      <DialogHeader><DialogTitle>整卡改分{dirty ? " · 未保存" : ""}</DialogTitle>
        <DialogDescription>点击原卷中的填涂格修改。学号点击切换；单选题点击切换，再次点击已选项可清空；多选题与分数格点击勾选、再次点击取消。点击保存后生效。</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-2 text-sm">
        <span className="text-correction-normal">蓝框：默认 / 正确 / 合法</span><span className="text-correction-error">红框：错误 / 异常</span>
        <Button size="sm" variant="outline" disabled={pageIndex===0 || busy} onClick={() => setPageIndex(i=>i-1)}>上一页</Button>
        <span>{document ? `${pageIndex+1} / ${document.pages.length}` : "—"}</span>
        <Button size="sm" variant="outline" disabled={!document || pageIndex===document.pages.length-1 || busy} onClick={() => setPageIndex(i=>i+1)}>下一页</Button>
        <Button size="sm" variant="outline" disabled={zoom<=1} onClick={() => setZoom(z=>Math.max(1,z-.5))}>缩小</Button>
        <Button size="sm" variant="outline" disabled={zoom>=4} onClick={() => setZoom(z=>Math.min(4,z+.5))}>放大</Button>
        <span>{Math.round(zoom*100)}%</span>
        <RotationButtons rotation={rotation} onChange={setRotation} />
      </div>
      <DialogBody className="min-h-0 flex-1 overflow-auto bg-muted p-3">
        {busy && !document && <p role="status">正在加载完整答题卡…</p>}
        {missing && <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <span>{document?.pages.some(p=>p.recovery?.reason==="provenance") ? "此旧卷尚未完成原图与答题卡版本核验，请重新识别，核对后保存。" : "此卷缺少坐标数据，请重新识别，核对后保存。"}</span>
          <Button variant="outline" disabled={busy} onClick={()=>void recover()}>重新识别旧卷</Button>
        </div>}
        {page && edit && <CorrectionCanvas document={document} pageIndex={pageIndex} edit={edit} images={images} zoom={zoom} rotation={rotation} busy={busy} onToggle={toggle} />}
      </DialogBody>
      <DialogFooter className="flex-wrap">
        <div className="min-w-0 flex-1 text-sm" role="status">{message || (errors.length ? <span className="text-destructive-fg">{[...new Set(errors)].slice(0,3).join("；")}{errors.length>3 ? "…" : ""}</span> : dirty ? "修改尚未保存" : missing ? "请先重新识别旧卷" : "点击填涂格开始修改")}</div>
        <Button variant="outline" disabled={busy} onClick={close}>取消</Button>
        <Button variant="primary" disabled={!document || (!dirty && !allowUnchangedSave) || busy || missing || errors.length>0} loading={busy && !!document} onClick={() => void save()}>保存修改</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
