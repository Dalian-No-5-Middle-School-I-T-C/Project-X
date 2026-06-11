import { useEffect, useState, useCallback, useRef, type ChangeEvent, type DragEvent } from "react";
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
  ImagePlus,
  ScanLine
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

interface DeviceStatus {
  connected: boolean;
  name: string;
  manufacturer: string;
  scanning: boolean;
}

interface ScanConfig {
  config: Record<string, string>;
  watcher: { watching: boolean; folder: string | null };
  device?: DeviceStatus;
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
  const [scanFolderPath, setScanFolderPath] = useState("");
  const [folderProgress, setFolderProgress] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 柯达扫描仪直连状态
  const [kodakScanning, setKodakScanning] = useState(false);
  const [kodakDpi, setKodakDpi] = useState(300);
  const [kodakDuplex, setKodakDuplex] = useState(false);
  const [kodakColor, setKodakColor] = useState<"color" | "grayscale" | "blackwhite">("color");

  /** 上传单个 File 对象 */
  async function uploadFile(file: File): Promise<boolean> {
    const formData = new FormData();
    formData.append("file", file);
    try {
      await fetchJson("/api/scans/upload-file", {
        method: "POST",
        body: formData
      });
      return true;
    } catch (err) {
      console.error(`上传 ${file.name} 失败:`, err);
      return false;
    }
  }

  /** 文件选择器选取后批量上传 */
  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    setIsBusy(true);
    setFolderProgress(`正在上传 ${selectedFiles.length} 个文件...`);
    let ok = 0;
    for (let i = 0; i < selectedFiles.length; i++) {
      if (await uploadFile(selectedFiles[i])) ok++;
      setFolderProgress(`已上传 ${ok}/${selectedFiles.length}...`);
    }
    setFolderProgress(`完成！成功导入 ${ok}/${selectedFiles.length} 个文件`);
    // 清空 input
    if (fileInputRef.current) fileInputRef.current.value = "";
    await loadScans();
    setIsBusy(false);
  }

  /** 拖拽上传 */
  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }
  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }
  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("image/")
    );
    if (droppedFiles.length === 0) {
      setFolderProgress("没有识别到图片文件");
      return;
    }
    setIsBusy(true);
    setFolderProgress(`正在上传 ${droppedFiles.length} 个文件...`);
    let ok = 0;
    for (let i = 0; i < droppedFiles.length; i++) {
      if (await uploadFile(droppedFiles[i])) ok++;
      setFolderProgress(`已上传 ${ok}/${droppedFiles.length}...`);
    }
    setFolderProgress(`完成！成功导入 ${ok}/${droppedFiles.length} 个文件`);
    await loadScans();
    setIsBusy(false);
  }

  /** 调用 Windows 文件夹选择器，读取所有图片并上传 */
  async function pickFolderAndUpload() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dirHandle = await (window as any).showDirectoryPicker();
      setFolderProgress("正在读取文件夹...");
      const imageExts = new Set([".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".gif", ".webp"]);
      const fileList: File[] = [];
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === "file") {
          const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
          if (imageExts.has(ext)) {
            fileList.push(await handle.getFile());
          }
        }
      }
      if (fileList.length === 0) { setFolderProgress("文件夹中没有图片文件"); return; }
      setIsBusy(true);
      setFolderProgress(`正在上传 ${fileList.length} 个文件...`);
      let ok = 0;
      for (let i = 0; i < fileList.length; i++) {
        if (await uploadFile(fileList[i])) ok++;
        setFolderProgress(`已上传 ${ok}/${fileList.length}...`);
      }
      setFolderProgress(`完成！成功导入 ${ok}/${fileList.length} 个文件`);
      await loadScans();
    } catch (err) {
      if ((err as Error).name === "AbortError") setFolderProgress("");
      else { console.error("选择文件夹失败:", err); setFolderProgress("选择文件夹失败"); }
    } finally {
      setIsBusy(false);
    }
  }

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

  // 扫描文件夹（批量导入文件夹内所有图片）
  async function handleScanFolder() {
    if (!scanFolderPath) return;
    setIsBusy(true);
    try {
      await fetchJson("/api/scans/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: scanFolderPath })
      });
      setScanFolderPath("");
      await loadScans();
    } catch (err) {
      console.error("扫描文件夹失败:", err);
      alert("扫描文件夹失败，请检查路径是否正确");
    } finally {
      setIsBusy(false);
    }
  }

  // 柯达扫描仪直连扫描
  async function handleKodakScan() {
    setKodakScanning(true);
    try {
      const result = await fetchJson<{ success: boolean; files: string[]; error?: string }>(
        "/api/scanner/scan",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dpi: kodakDpi,
            colorMode: kodakColor,
            duplex: kodakDuplex
          })
        }
      );
      if (!result.success) {
        alert(result.error || "扫描失败，请检查扫描仪状态");
      } else {
        setFolderProgress(`扫描完成，导入了 ${result.files?.length ?? 0} 张图片`);
        await loadScans();
      }
    } catch (err) {
      console.error("柯达扫描失败:", err);
      alert("扫描失败，请检查扫描仪连接和 Python 环境");
    } finally {
      setKodakScanning(false);
    }
  }

  // 取消柯达扫描
  async function handleKodakCancel() {
    try {
      await fetchJson("/api/scanner/scan/cancel", { method: "POST" });
    } catch { /* 忽略 */ }
    setKodakScanning(false);
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
            <>
              <span className="watcher-status">
                {config.watcher.watching ? (
                  <><CheckCircle size={14} /> 监听中: {config.watcher.folder}</>
                ) : (
                  <><AlertCircle size={14} /> 未监听</>
                )}
              </span>
              {config.device && (
                <span className={`watcher-status ${config.device.connected ? "connected" : ""}`}>
                  <ScanLine size={14} />
                  {config.device.connected ? (
                    <>{config.device.name} 已就绪</>
                  ) : (
                    <>{config.device.name} 未连接</>
                  )}
                </span>
              )}
            </>
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

      {/* 扫描操作区 */}
      <div
        className={`scan-import-bar ${isDragging ? "drag-over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
      >
        {/* 隐藏的文件选择器 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void handleFileSelect(e)}
          style={{ display: "none" }}
        />
        {isDragging ? (
          <div className="drop-zone-active">
            <ImagePlus size={40} />
            <p>松开鼠标上传图片</p>
          </div>
        ) : (
          <div className="drop-zone">
            <ImagePlus size={24} />
            <span>拖拽图片到此处上传，或</span>
            <button className="ghost-button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} /> 选择文件
            </button>
            <span className="scan-or">或</span>
            <button className="primary-button" onClick={() => void pickFolderAndUpload()} disabled={isBusy}>
              <FolderOpen size={14} /> 选择文件夹
            </button>
          </div>
        )}
        {/* 底部手动路径输入 */}
        <div className="scan-import-group">
          <input
            type="text"
            placeholder="高级: 手动输入文件夹路径后点扫描..."
            value={scanFolderPath}
            onChange={(e) => setScanFolderPath(e.target.value)}
            className="scan-path-input"
          />
          <button
            className="ghost-button"
            onClick={() => void handleScanFolder()}
            disabled={isBusy || !scanFolderPath}
          >
            <ScanLine size={14} /> 扫描
          </button>
        </div>
        {/* Kodak 直连扫描控制 */}
        {config?.config.scanner_driver === "kodak_sdk" && (
          <div className="kodak-controls">
            <div className="kodak-controls-row">
              <label className="kodak-label">
                DPI
                <select value={kodakDpi} onChange={(e) => setKodakDpi(Number(e.target.value))}>
                  <option value={200}>200</option>
                  <option value={300}>300</option>
                  <option value={400}>400</option>
                  <option value={600}>600</option>
                </select>
              </label>
              <label className="kodak-label">
                色彩
                <select value={kodakColor} onChange={(e) => setKodakColor(e.target.value as typeof kodakColor)}>
                  <option value="color">彩色</option>
                  <option value="grayscale">灰度</option>
                  <option value="blackwhite">黑白</option>
                </select>
              </label>
              <label className="kodak-label check-label">
                <input
                  type="checkbox"
                  checked={kodakDuplex}
                  onChange={(e) => setKodakDuplex(e.target.checked)}
                />
                双面扫描
              </label>
            </div>
            <div className="kodak-controls-row">
              {kodakScanning ? (
                <button className="primary-button danger" onClick={() => void handleKodakCancel()}>
                  <X size={16} /> 取消扫描
                </button>
              ) : (
                <button
                  className="primary-button"
                  onClick={() => void handleKodakScan()}
                  disabled={isBusy || (config?.device && !config.device.connected)}
                >
                  <ScanLine size={16} /> 开始扫描
                </button>
              )}
              {kodakScanning && <span className="scan-progress"><Loader size={14} className="spin" /> 扫描中，请等待...</span>}
            </div>
          </div>
        )}
        {folderProgress && <div className="scan-progress">{folderProgress}</div>}
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
                <span className="modal-label-text">输入文件夹（扫描仪输出目录）</span>
                <input
                  type="text"
                  defaultValue={config?.config.input_folder || ""}
                  id="setting-input-folder"
                  placeholder="例如: D:\\Scans\\AnswerCards"
                />
                <small className="modal-hint">将扫描仪输出文件夹设置为本程序的 input_folder，或手动导入图片文件。</small>
              </label>
              <label>
                <span className="modal-label-text">默认 DPI</span>
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
                <span>导入后自动识别</span>
              </label>
              <label>
                <span className="modal-label-text">扫描仪驱动</span>
                <select
                  defaultValue={config?.config.scanner_driver || "folder"}
                  id="setting-scanner-driver"
                >
                  <option value="folder">文件夹监听模式</option>
                  <option value="kodak_sdk">柯达 SDK 直连（WIA）</option>
                  <option value="twain" disabled>
                    TWAIN 直连（待开发）
                  </option>
                  <option value="wia" disabled>
                    WIA 直连（待开发）
                  </option>
                </select>
                <small className="modal-hint">
                  {config?.config.scanner_driver === "kodak_sdk"
                    ? "柯达模式需要安装 Python + pywin32 库（pip install pywin32）。扫描仪通过 Windows WIA 协议通信。"
                    : "当前使用文件夹监听模式，请将扫描仪输出到 input_folder"}
                </small>
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
