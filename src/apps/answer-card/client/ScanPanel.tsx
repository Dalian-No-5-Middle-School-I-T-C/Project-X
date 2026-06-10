import { useEffect, useState, useCallback } from "react";
import {
  FolderOpen,
  RefreshCw,
  Search,
  Settings,
  Upload,
  Trash2,
  CheckCircle,
  AlertCircle,
  Loader,
  X,
  ImagePlus
} from "lucide-react";

// ============================================================
// 类型定义
// ============================================================

type ScanStatus = "pending" | "processing" | "recognized" | "error";

interface ScanSummary {
  id: string;
  file_name: string;
  status: ScanStatus;
  student_id: string | null;
  student_name: string | null;
  card_id: string | null;
  thumbnail_url: string | null;
  created_at: string;
}

interface ScanDetail {
  id: string;
  file_name: string;
  original_path: string;
  stored_path: string;
  thumbnail_path: string | null;
  file_size: number;
  width: number | null;
  height: number | null;
  dpi: number;
  status: ScanStatus;
  card_id: string | null;
  page_number: number;
  student_id: string | null;
  student_name: string | null;
  class_name: string | null;
  recognition_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ScanConfig {
  config: Record<string, string>;
  watcher: { watching: boolean; folder: string | null };
}

interface CardSummary {
  id: string;
  title: string;
  updatedAt: string;
}

// ============================================================
// API 调用
// ============================================================

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
}

// ============================================================
// 主组件
// ============================================================

export default function ScanPanel() {
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [config, setConfig] = useState<ScanConfig | null>(null);
  const [selectedScan, setSelectedScan] = useState<ScanDetail | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ScanStatus | "">("");
  const [showSettings, setShowSettings] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importCardId, setImportCardId] = useState("");

  // 加载扫描列表
  const loadScans = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      params.set("limit", "100");

      const data = await fetchJson<{ scans: ScanSummary[]; total: number }>(
        `/api/scans?${params.toString()}`
      );
      setScans(data.scans);
      setTotal(data.total);
    } catch (err) {
      console.error("加载扫描列表失败:", err);
    }
  }, [statusFilter]);

  // 加载配置
  const loadConfig = useCallback(async () => {
    try {
      const data = await fetchJson<ScanConfig>("/api/scans/config");
      setConfig(data);
    } catch (err) {
      console.error("加载配置失败:", err);
    }
  }, []);

  // 加载答题卡列表（用于手动导入时选择）
  const loadCards = useCallback(async () => {
    try {
      const data = await fetchJson<CardSummary[]>("/api/cards");
      setCards(data);
    } catch (err) {
      console.error("加载答题卡列表失败:", err);
    }
  }, []);

  useEffect(() => {
    void loadScans();
    void loadConfig();
    void loadCards();
  }, [loadScans, loadConfig, loadCards]);

  // 定时刷新（每 5 秒）
  useEffect(() => {
    const interval = setInterval(() => {
      void loadScans();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadScans]);

  // 查看详情
  async function viewDetail(scanId: string) {
    setIsBusy(true);
    try {
      const detail = await fetchJson<ScanDetail>(`/api/scans/${scanId}`);
      setSelectedScan(detail);
    } catch (err) {
      console.error("加载扫描详情失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  // 手动导入
  async function handleImport() {
    if (!importPath) return;
    setIsBusy(true);
    try {
      const body: Record<string, unknown> = { path: importPath };
      if (importCardId) body.cardId = importCardId;

      await fetchJson("/api/scans/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      setImportPath("");
      await loadScans();
    } catch (err) {
      console.error("导入失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  // 手动触发识别
  async function handleRecognize(scanId: string, cardId: string) {
    setIsBusy(true);
    try {
      await fetchJson(`/api/scans/${scanId}/recognize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId })
      });
      await loadScans();
    } catch (err) {
      console.error("触发识别失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  // 删除扫描记录
  async function handleDelete(scanId: string) {
    if (!confirm("确定删除此扫描记录？")) return;
    setIsBusy(true);
    try {
      await fetchJson(`/api/scans/${scanId}`, { method: "DELETE" });
      if (selectedScan?.id === scanId) setSelectedScan(null);
      await loadScans();
    } catch (err) {
      console.error("删除失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  // 更新配置
  async function handleSaveConfig(updates: Record<string, string>) {
    setIsBusy(true);
    try {
      const data = await fetchJson<ScanConfig>("/api/scans/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates)
      });
      setConfig(data);
      setShowSettings(false);
    } catch (err) {
      console.error("保存配置失败:", err);
    } finally {
      setIsBusy(false);
    }
  }

  // 格式化文件大小
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // 状态标签
  function statusBadge(status: ScanStatus) {
    const map: Record<ScanStatus, { icon: JSX.Element; label: string; className: string }> = {
      pending: { icon: <Loader size={13} />, label: "待处理", className: "status-pending" },
      processing: { icon: <Loader size={13} className="spin" />, label: "识别中", className: "status-processing" },
      recognized: { icon: <CheckCircle size={13} />, label: "已识别", className: "status-recognized" },
      error: { icon: <AlertCircle size={13} />, label: "失败", className: "status-error" }
    };
    const item = map[status];
    return (
      <span className={`status-badge ${item.className}`}>
        {item.icon} {item.label}
      </span>
    );
  }

  return (
    <div className="scan-panel">
      {/* 顶部操作栏 */}
      <div className="scan-toolbar">
        <div className="scan-toolbar-left">
          <h2>扫描管理</h2>
          {config && (
            <span className="watcher-status">
              {config.watcher.watching ? (
                <><CheckCircle size={14} /> 监听中: {config.watcher.folder}</>
              ) : (
                <><AlertCircle size={14} /> 未监听</>
              )}
            </span>
          )}
        </div>
        <div className="scan-toolbar-right">
          <button className="ghost-button" onClick={() => setShowSettings(true)} disabled={isBusy}>
            <Settings size={16} /> 设置
          </button>
          <button className="ghost-button" onClick={loadScans} disabled={isBusy}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </div>

      {/* 手动导入区 */}
      <div className="scan-import-bar">
        <input
          type="text"
          placeholder="图片文件路径..."
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          className="scan-path-input"
        />
        <select
          value={importCardId}
          onChange={(e) => setImportCardId(e.target.value)}
          className="scan-card-select"
        >
          <option value="">自动匹配答题卡</option>
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.title} ({card.id})
            </option>
          ))}
        </select>
        <button
          className="primary-button"
          onClick={() => void handleImport()}
          disabled={isBusy || !importPath}
        >
          <Upload size={16} /> 导入
        </button>
      </div>

      {/* 筛选 */}
      <div className="scan-filters">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ScanStatus | "")}
          className="scan-filter-select"
        >
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="processing">识别中</option>
          <option value="recognized">已识别</option>
          <option value="error">失败</option>
        </select>
        <span className="scan-count">共 {total} 条记录</span>
      </div>

      {/* 扫描列表 */}
      <div className="scan-list-container">
        {scans.length === 0 ? (
          <div className="scan-empty">
            <ImagePlus size={40} />
            <p>暂无扫描记录</p>
            <small>将扫描仪输出文件夹设置为本程序的 input_folder，或手动导入图片文件。</small>
          </div>
        ) : (
          <div className="scan-list">
            {scans.map((scan) => (
              <div
                key={scan.id}
                className={`scan-item ${selectedScan?.id === scan.id ? "active" : ""}`}
                onClick={() => void viewDetail(scan.id)}
              >
                <div className="scan-thumbnail">
                  {scan.thumbnail_url ? (
                    <img src={scan.thumbnail_url} alt={scan.file_name} />
                  ) : (
                    <div className="scan-thumbnail-placeholder">
                      <ImagePlus size={24} />
                    </div>
                  )}
                </div>
                <div className="scan-info">
                  <div className="scan-filename" title={scan.file_name}>
                    {scan.file_name}
                  </div>
                  <div className="scan-meta">
                    {statusBadge(scan.status)}
                    {scan.student_id && (
                      <span className="scan-student">考号: {scan.student_id}</span>
                    )}
                    {scan.student_name && (
                      <span className="scan-student">姓名: {scan.student_name}</span>
                    )}
                  </div>
                  <div className="scan-time">
                    {new Date(scan.created_at).toLocaleString("zh-CN")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 详情面板 */}
      {selectedScan && (
        <div className="scan-detail-panel">
          <div className="scan-detail-header">
            <h3>扫描详情</h3>
            <button className="ghost-button" onClick={() => setSelectedScan(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="scan-detail-body">
            <div className="detail-row">
              <span className="detail-label">文件名</span>
              <span className="detail-value">{selectedScan.file_name}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">状态</span>
              <span className="detail-value">{statusBadge(selectedScan.status)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">文件大小</span>
              <span className="detail-value">{formatSize(selectedScan.file_size)}</span>
            </div>
            {selectedScan.width && selectedScan.height && (
              <div className="detail-row">
                <span className="detail-label">尺寸</span>
                <span className="detail-value">
                  {selectedScan.width} x {selectedScan.height} px
                </span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label">DPI</span>
              <span className="detail-value">{selectedScan.dpi}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">答题卡</span>
              <span className="detail-value">
                {selectedScan.card_id ?? (
                  <select
                    onChange={(e) => {
                      if (e.target.value && selectedScan) {
                        void handleRecognize(selectedScan.id, e.target.value);
                      }
                    }}
                    className="detail-select"
                  >
                    <option value="">选择答题卡...</option>
                    {cards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </div>
            {selectedScan.student_id && (
              <div className="detail-row">
                <span className="detail-label">学号</span>
                <span className="detail-value highlight">{selectedScan.student_id}</span>
              </div>
            )}
            {selectedScan.student_name && (
              <div className="detail-row">
                <span className="detail-label">姓名</span>
                <span className="detail-value">{selectedScan.student_name}</span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label">时间</span>
              <span className="detail-value">
                {new Date(selectedScan.created_at).toLocaleString("zh-CN")}
              </span>
            </div>
            {selectedScan.recognition_json && (
              <div className="detail-row">
                <span className="detail-label">识别结果</span>
                <pre className="detail-json">
                  {JSON.stringify(JSON.parse(selectedScan.recognition_json), null, 2)}
                </pre>
              </div>
            )}
            {selectedScan.error_message && (
              <div className="detail-row">
                <span className="detail-label">错误信息</span>
                <span className="detail-value error-text">{selectedScan.error_message}</span>
              </div>
            )}
          </div>
          <div className="scan-detail-actions">
            {selectedScan.card_id && selectedScan.status !== "recognized" && (
              <button
                className="primary-button"
                onClick={() => void handleRecognize(selectedScan.id, selectedScan.card_id!)}
                disabled={isBusy}
              >
                <Search size={16} /> 重新识别
              </button>
            )}
            <button
              className="ghost-button danger"
              onClick={() => void handleDelete(selectedScan.id)}
              disabled={isBusy}
            >
              <Trash2 size={16} /> 删除
            </button>
          </div>
        </div>
      )}

      {/* 设置弹窗 */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>扫描设置</h3>
              <button className="ghost-button" onClick={() => setShowSettings(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <label>
                输入文件夹（扫描仪输出目录）
                <input
                  type="text"
                  defaultValue={config?.config.input_folder || ""}
                  id="setting-input-folder"
                  placeholder="例如: D:\Scans\AnswerCards"
                />
              </label>
              <label>
                默认 DPI
                <input
                  type="number"
                  defaultValue={config?.config.default_dpi || "300"}
                  id="setting-dpi"
                  min={72}
                  max={1200}
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  defaultChecked={config?.config.auto_recognize !== "false"}
                  id="setting-auto-recognize"
                />
                导入后自动识别
              </label>
              <label>
                扫描仪驱动（预留，当前仅支持 folder 模式）
                <select
                  defaultValue={config?.config.scanner_driver || "folder"}
                  id="setting-scanner-driver"
                >
                  <option value="folder">文件夹监听模式</option>
                  <option value="twain" disabled>
                    TWAIN 直连（待开发）
                  </option>
                  <option value="wia" disabled>
                    WIA 直连（待开发）
                  </option>
                  <option value="kodak_sdk" disabled>
                    柯达 SDK 直连（待开发）
                  </option>
                </select>
              </label>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" onClick={() => setShowSettings(false)}>
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  const folder = (document.getElementById("setting-input-folder") as HTMLInputElement)?.value;
                  const dpi = (document.getElementById("setting-dpi") as HTMLInputElement)?.value;
                  const autoRecognize = (document.getElementById("setting-auto-recognize") as HTMLInputElement)?.checked;
                  const driver = (document.getElementById("setting-scanner-driver") as HTMLSelectElement)?.value;

                  void handleSaveConfig({
                    input_folder: folder,
                    default_dpi: dpi,
                    auto_recognize: autoRecognize ? "true" : "false",
                    scanner_driver: driver
                  });
                }}
                disabled={isBusy}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
