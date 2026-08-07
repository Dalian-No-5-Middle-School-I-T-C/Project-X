import { lazy, Suspense } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from "./ui/v2";

// 懒加载：隔离 react-markdown / remark-gfm / 用户指南 md 文本，仅打开弹窗时才加载
const UserGuidePage = lazy(() => import("./UserGuidePage").then((m) => ({ default: m.UserGuidePage })));

export function UserGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg" className="max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>使用说明</DialogTitle>
        </DialogHeader>
        <DialogBody className="overflow-y-auto">
          <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">正在加载...</p>}>
            <UserGuidePage embedded />
          </Suspense>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
