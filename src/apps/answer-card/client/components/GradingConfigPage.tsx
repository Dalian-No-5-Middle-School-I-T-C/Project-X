// GradingConfigPage —— 网阅设置（T5 v2 迁移）
// 视觉层整体切换到 v2：Panel / Field / Select / Input / Checkbox / Button / Dialog / Badge。
// 功能守恒（API / 请求体 / 权限判断零改动）：
//  · GET  /api/review/exams/:examId/blocks
//  · GET  /api/block-grading-config/exams/:examId
//  · PUT  /api/block-grading-config/exams/:examId/blocks/__default__
//  · POST /api/block-grading-config/exams/:examId/batch
// PR #189 的评分模式 / 拆分策略字段与其联动逻辑完整保留。
import React, { useState, useEffect, useCallback } from "react";
import { Settings2 } from "lucide-react";
import { fetchJson } from "../auth/api";
import type { BlockGradingConfig, ArbitratorCandidate } from "../../../../shared/types";
import {
  Badge,
  Button,
  Checkbox,
  ControlRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "./ui/v2";

interface Props {
  examId: number;
}

/** Radix Select 不接受空字符串 value，用哨兵值表示「不修改」 */
const KEEP = "__keep__";
const fromKeep = (v: string): string => (v === KEEP ? "" : v);
const toKeep = (v: string): string => (v === "" ? KEEP : v);

const roundingLabel: Record<string, string> = {
  ceil: "↑",
  half: "0.5",
  none: "—",
};

export function GradingConfigPage({ examId }: Props) {
  const [blocks, setBlocks] = useState<Array<{ blockId: string; blockTitle: string }>>([]);
  const [configs, setConfigs] = useState<Record<string, BlockGradingConfig>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [batchThreshold, setBatchThreshold] = useState("");
  const [batchRounding, setBatchRounding] = useState("");
  const [batchHasHalf, setBatchHasHalf] = useState("");
  const [batchReviewMode, setBatchReviewMode] = useState("");
  // PR #189 修复：批量调整也需要覆盖评分模式 + 拆分策略（管理员可改字段）
  const [batchScoringMode, setBatchScoringMode] = useState("");
  const [batchScoreDistribution, setBatchScoreDistribution] = useState("");
  const [loading, setLoading] = useState(true);
  const [applyingBatch, setApplyingBatch] = useState(false);
  const [arbitrators, setArbitrators] = useState<ArbitratorCandidate[]>([]);

  // v1.9.4 设置重构：本场考试的「网阅默认」模板（block_id='__default__'）
  const [defThreshold, setDefThreshold] = useState("2");
  const [defRounding, setDefRounding] = useState("ceil");
  const [defHasHalf, setDefHasHalf] = useState("0");
  const [defAutoReassign, setDefAutoReassign] = useState(true);
  const [defWorkload, setDefWorkload] = useState("4");
  const [defReviewMode, setDefReviewMode] = useState("1");
  // PR #189 修复：网阅默认模板也需承载评分模式 + 拆分策略，
  // 否则新题块只能回退到 DB 默认（block_total）且管理员无 UI 可改。
  const [defScoringMode, setDefScoringMode] = useState<"block_total" | "per_question">("block_total");
  const [defScoreDistribution, setDefScoreDistribution] = useState<"proportional" | "equal">("proportional");
  const [savingDefault, setSavingDefault] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 获取题块
      const blockRes = await fetchJson<{ ok: boolean; data: any[] }>(
        `/api/review/exams/${examId}/blocks`
      );
      if (blockRes.ok) {
        setBlocks(blockRes.data.map((b: any) => ({ blockId: b.blockId, blockTitle: b.blockTitle || b.blockId })));

        // 获取配置
        const configRes = await fetchJson<{ ok: boolean; data: BlockGradingConfig[] }>(
          `/api/block-grading-config/exams/${examId}`
        );
        if (configRes.ok) {
          const map: Record<string, BlockGradingConfig> = {};
          for (const c of configRes.data) map[c.blockId] = c;
          setConfigs(map);
          // 初始化「网阅默认」表单
          const d = map["__default__"];
          if (d) {
            setDefThreshold(String(d.disputeThreshold ?? 2));
            setDefRounding(d.rounding ?? "ceil");
            setDefHasHalf(String(d.hasHalfPoint === 1 ? 1 : 0));
            setDefAutoReassign(d.autoReassignNoArb !== 0);
            setDefWorkload(String(d.workloadBalanceThreshold ?? 4));
            setDefReviewMode(String(d.reviewMode ?? 1));
            // PR #189 修复：把已有的 scoringMode / scoreDistribution 反映到表单
            setDefScoringMode(d.scoringMode === "per_question" ? "per_question" : "block_total");
            setDefScoreDistribution(d.scoreDistribution === "equal" ? "equal" : "proportional");
          }
        }
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [examId]);

  const handleSaveDefault = async () => {
    setSavingDefault(true);
    try {
      await fetchJson(`/api/block-grading-config/exams/${examId}/blocks/__default__`, {
        method: "PUT",
        body: JSON.stringify({
          disputeThreshold: Number(defThreshold) || 2,
          rounding: defRounding,
          hasHalfPoint: Number(defHasHalf),
          autoReassignNoArb: defAutoReassign ? 1 : 0,
          workloadBalanceThreshold: Number(defWorkload) || 4,
          reviewMode: Number(defReviewMode) || 1,
          // PR #189 修复：把评分模式 / 拆分策略写回网阅默认模板
          scoringMode: defScoringMode,
          scoreDistribution: defScoringMode === "per_question" ? "proportional" : defScoreDistribution,
        }),
      });
      load();
    } finally {
      setSavingDefault(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (blockId: string) => {
    const next = new Set(selected);
    if (next.has(blockId)) next.delete(blockId);
    else next.add(blockId);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === blocks.length) setSelected(new Set());
    else setSelected(new Set(blocks.map((b) => b.blockId)));
  };

  const handleBatchApply = async () => {
    const blockIds = Array.from(selected);
    if (blockIds.length === 0) return;

    const body: any = { blockIds };
    if (batchThreshold) body.disputeThreshold = Number(batchThreshold);
    if (batchRounding) body.rounding = batchRounding;
    if (batchHasHalf) body.hasHalfPoint = Number(batchHasHalf);
    if (batchReviewMode) body.reviewMode = Number(batchReviewMode);
    // PR #189 修复：批量弹窗也支持覆盖评分模式 / 拆分策略
    if (batchScoringMode) {
      body.scoringMode = batchScoringMode;
      // per_question 模式下 scoreDistribution 无意义，若用户切到 per_question 就清掉
      if (batchScoringMode === "per_question") body.scoreDistribution = "proportional";
      else if (batchScoreDistribution) body.scoreDistribution = batchScoreDistribution;
    } else if (batchScoreDistribution) {
      body.scoreDistribution = batchScoreDistribution;
    }

    setApplyingBatch(true);
    try {
      await fetchJson(`/api/block-grading-config/exams/${examId}/batch`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      setShowBatch(false);
      setBatchThreshold("");
      setBatchRounding("");
      setBatchHasHalf("");
      setBatchReviewMode("");
      setBatchScoringMode("");
      setBatchScoreDistribution("");
      load();
    } finally {
      setApplyingBatch(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner size={16} /> 加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">网阅设置</h2>
        <p className="text-sm text-muted-foreground">
          配置各题块的分差阈值、取整方式和仲裁人。选中多题后可使用批量调整。
        </p>
      </header>

      {/* v1.9.4 设置重构：本场考试的「网阅默认」模板（此前误放在全局设置） */}
      <Panel className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-base font-medium text-foreground">网阅默认（新建题块模板）</h3>
          <p className="text-xs text-muted-foreground">
            本场考试新建题块未单独配置时套用以下默认策略；仍可在下方逐题覆盖。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="分差阈值" htmlFor="def-threshold">
            <Input
              id="def-threshold"
              type="number"
              value={defThreshold}
              onChange={(e) => setDefThreshold(e.target.value)}
              className="tabular-nums"
            />
          </Field>

          <Field label="均衡阈值（份）" htmlFor="def-workload">
            <Input
              id="def-workload"
              type="number"
              value={defWorkload}
              onChange={(e) => setDefWorkload(e.target.value)}
              className="tabular-nums"
            />
          </Field>

          <Field label="取整方式">
            <Select value={defRounding} onValueChange={setDefRounding}>
              <SelectTrigger aria-label="取整方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ceil">向上取整</SelectItem>
                <SelectItem value="floor">向下取整</SelectItem>
                <SelectItem value="round">四舍五入</SelectItem>
                <SelectItem value="half">保留 0.5</SelectItem>
                <SelectItem value="none">保留小数</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="本题块含 0.5 小数">
            <Select value={defHasHalf} onValueChange={setDefHasHalf}>
              <SelectTrigger aria-label="本题块含 0.5 小数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">是</SelectItem>
                <SelectItem value="0">否</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="复评模式（仲裁卷可+2轮）">
            <Select value={defReviewMode} onValueChange={setDefReviewMode}>
              <SelectTrigger aria-label="复评模式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">单评（1轮）</SelectItem>
                <SelectItem value="2">双评（2轮）</SelectItem>
                <SelectItem value="3">三评（3轮）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* PR #189 修复：网阅默认模板暴露评分模式，管理员才能在 UI 中改 block_total / per_question */}
          <Field label="评分模式">
            <Select
              value={defScoringMode}
              onValueChange={(v) => setDefScoringMode(v as "block_total" | "per_question")}
            >
              <SelectTrigger aria-label="评分模式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block_total">题块总分（合计分，后端按比例拆分）</SelectItem>
                <SelectItem value="per_question">逐题评分（每题独立输入，GradePanel 不可用）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {defScoringMode !== "per_question" && (
            <Field label="拆分策略（题块总分模式）">
              <Select
                value={defScoreDistribution}
                onValueChange={(v) => setDefScoreDistribution(v as "proportional" | "equal")}
              >
                <SelectTrigger aria-label="拆分策略">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="proportional">按满分比例拆分（默认）</SelectItem>
                  <SelectItem value="equal">按题数均分</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>

        <ControlRow
          label="无仲裁人时自动重分配争议/剩余卷"
          control={
            <Checkbox
              checked={defAutoReassign}
              onCheckedChange={(v) => setDefAutoReassign(v === true)}
              aria-label="无仲裁人时自动重分配争议/剩余卷"
            />
          }
        />

        <div>
          <Button
            variant="primary"
            size="sm"
            loading={savingDefault}
            onClick={() => void handleSaveDefault()}
          >
            {savingDefault ? "保存中..." : "保存网阅默认"}
          </Button>
        </div>
      </Panel>

      {blocks.length === 0 ? (
        <EmptyState
          icon={<Settings2 />}
          title="暂无题块"
          description="本场考试尚未生成网阅题块，完成切块后即可逐题配置。"
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={selectAll}>
              {selected.size === blocks.length ? "取消全选" : "全选"}
            </Button>
            <Button
              variant={selected.size > 0 ? "primary" : "outline"}
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setShowBatch(true)}
            >
              调整选中 ({selected.size})
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {blocks.map((block) => {
              const config = configs[block.blockId];
              const isSelected = selected.has(block.blockId);
              return (
                <label
                  key={block.blockId}
                  className={[
                    "flex cursor-pointer flex-wrap items-center gap-3 rounded-md border px-3.5 py-2.5",
                    "transition-colors duration-(--px-dur-1) ease-standard",
                    isSelected
                      ? "border-accent-border bg-accent"
                      : "border-border-subtle bg-secondary hover:border-border",
                  ].join(" ")}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelect(block.blockId)}
                    aria-label={`选择 ${block.blockTitle}`}
                  />
                  <span className="flex-1 min-w-40 truncate text-base text-foreground">
                    {block.blockTitle}
                  </span>
                  {/* PR #189 修复：题块摘要展示当前评分模式，让管理员在列表里就能看出
                      哪些题块是 block_total、哪些是 per_question。 */}
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <Badge tone={config?.scoringMode === "per_question" ? "info" : "neutral"}>
                      模式:{" "}
                      {config?.scoringMode === "per_question"
                        ? "逐题评分"
                        : config?.scoringMode === "block_total"
                          ? "题块总分"
                          : "—"}
                    </Badge>
                    {config?.scoringMode === "block_total" && (
                      <span>拆分: {config.scoreDistribution === "equal" ? "均分" : "按比例"}</span>
                    )}
                    <span>阈值: {config?.disputeThreshold ?? "—"}</span>
                    <span>
                      取整: {config?.rounding ? (roundingLabel[config.rounding] ?? config.rounding) : "—"}
                    </span>
                    <span>
                      0.5: {config?.hasHalfPoint === 1 ? "是" : config?.hasHalfPoint === 0 ? "否" : "—"}
                    </span>
                    <span>
                      复评:{" "}
                      {config?.reviewMode === 1
                        ? "单评"
                        : config?.reviewMode === 2
                          ? "双评"
                          : config?.reviewMode === 3
                            ? "三评"
                            : "—"}
                    </span>
                    <span>仲裁: {config?.arbitratorId ? `教师${config.arbitratorId}` : "未指定"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}

      {arbitrators.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          可选仲裁人：
          {arbitrators.map((a) => (
            <Badge key={a.id} tone="neutral">
              {a.name}
            </Badge>
          ))}
        </div>
      )}

      {/* 批量调整对话框 */}
      <Dialog open={showBatch} onOpenChange={(o) => { if (!applyingBatch) setShowBatch(o); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>调整 {selected.size} 道题的设置</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <Field label="分差阈值">
              <Select value={toKeep(batchThreshold)} onValueChange={(v) => setBatchThreshold(fromKeep(v))}>
                <SelectTrigger aria-label="分差阈值">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  <SelectItem value="1">1 分</SelectItem>
                  <SelectItem value="2">2 分</SelectItem>
                  <SelectItem value="3">3 分</SelectItem>
                  <SelectItem value="5">5 分</SelectItem>
                  <SelectItem value="10">10 分</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="取整方式">
              <Select value={toKeep(batchRounding)} onValueChange={(v) => setBatchRounding(fromKeep(v))}>
                <SelectTrigger aria-label="取整方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  <SelectItem value="ceil">向上取整</SelectItem>
                  <SelectItem value="floor">向下取整</SelectItem>
                  <SelectItem value="round">四舍五入</SelectItem>
                  <SelectItem value="half">保留 0.5</SelectItem>
                  <SelectItem value="none">保留小数</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="本题块含 0.5 小数">
              <Select value={toKeep(batchHasHalf)} onValueChange={(v) => setBatchHasHalf(fromKeep(v))}>
                <SelectTrigger aria-label="本题块含 0.5 小数">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  <SelectItem value="1">是（启用手写 0.5 评分）</SelectItem>
                  <SelectItem value="0">否</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="复评模式（仲裁卷可+2轮）">
              <Select value={toKeep(batchReviewMode)} onValueChange={(v) => setBatchReviewMode(fromKeep(v))}>
                <SelectTrigger aria-label="复评模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  <SelectItem value="1">单评（1轮）</SelectItem>
                  <SelectItem value="2">双评（2轮）</SelectItem>
                  <SelectItem value="3">三评（3轮）</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {/* PR #189 修复：批量调整弹窗暴露评分模式（管理员可改） */}
            <Field label="评分模式">
              <Select
                value={toKeep(batchScoringMode)}
                onValueChange={(v) => {
                  const next = fromKeep(v);
                  setBatchScoringMode(next);
                  // 切到 per_question 时把拆分策略重置为不修改
                  if (next === "per_question") setBatchScoreDistribution("");
                }}
              >
                <SelectTrigger aria-label="评分模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  <SelectItem value="block_total">题块总分</SelectItem>
                  <SelectItem value="per_question">逐题评分</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {batchScoringMode !== "per_question" && (
              <Field label="拆分策略（题块总分模式）">
                <Select
                  value={toKeep(batchScoreDistribution)}
                  onValueChange={(v) => setBatchScoreDistribution(fromKeep(v))}
                >
                  <SelectTrigger aria-label="拆分策略">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={KEEP}>不修改</SelectItem>
                    <SelectItem value="proportional">按满分比例拆分</SelectItem>
                    <SelectItem value="equal">按题数均分</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}

            <p className="text-xs text-muted-foreground">
              将覆盖:{" "}
              {Array.from(selected)
                .map((id) => blocks.find((b) => b.blockId === id)?.blockTitle ?? id)
                .join(", ")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={applyingBatch} onClick={() => setShowBatch(false)}>
              取消
            </Button>
            <Button variant="primary" loading={applyingBatch} onClick={handleBatchApply}>
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
