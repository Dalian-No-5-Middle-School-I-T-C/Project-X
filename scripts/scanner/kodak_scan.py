"""
Kodak i3000 / 通用 WIA 扫描仪控制脚本
通过 Windows WIA (Windows Image Acquisition) COM 接口连接并控制扫描仪。

用法:
  python kodak_scan.py list                  # 列出所有可用 WIA 扫描仪
  python kodak_scan.py status                # 检查柯达 i3000 是否就绪
  python kodak_scan.py scan [选项]            # 执行扫描并保存图片

扫描选项:
  --dpi N              扫描分辨率 (默认 300)
  --color MODE         色彩模式: color | grayscale | blackwhite (默认 color)
  --duplex             启用 ADF 双面扫描
  --simplex            强制单面扫描 (默认)
  --output DIR         输出目录 (默认: 当前工作目录)
  --device ID          指定 WIA DeviceID (默认自动查找柯达设备)
  --format {jpg,png,tiff}  输出图片格式 (默认 jpg)
  --prefix NAME        输出文件名前缀 (默认 kodak_scan)

所有子命令均输出 JSON 到 stdout，方便 Node.js 侧解析。
"""

import sys
import os
import json
import time
import argparse
import traceback
import re


# ============================================================
# pywin32 导入检查
# ============================================================

def _ensure_pywin32():
    """检查 pywin32 是否可用，不可用时输出 JSON 错误后退出"""
    try:
        from win32com.client import Dispatch  # noqa: F401
        return True
    except ImportError:
        print(json.dumps({
            "success": False,
            "error": (
                "缺少 pywin32 库。请以管理员身份运行以下命令安装：\n"
                "  pip install pywin32\n"
                "  python Scripts/pywin32_postinstall.py -install"
            )
        }, ensure_ascii=False))
        sys.exit(1)


# ============================================================
# COM 生命周期
# ============================================================

def _com_init():
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except ImportError:
        pass


def _com_uninit():
    try:
        import pythoncom
        pythoncom.CoUninitialize()
    except ImportError:
        pass


# ============================================================
# WIA 属性常量
# ============================================================

# 标准 WIA 属性 ID（跨设备通用）
WIA_IPS_CUR_INTENT         = 6146  # 色彩意图: 0=未知 1=彩色 2=灰度 4=黑白
WIA_IPS_XRES               = 6147  # 水平 DPI
WIA_IPS_YRES               = 6148  # 垂直 DPI
WIA_IPS_XEXTENT            = 6154  # 扫描宽度 (像素)
WIA_IPS_YEXTENT            = 6155  # 扫描高度 (像素)
WIA_IPS_BRIGHTNESS         = 6156  # 亮度
WIA_IPS_CONTRAST           = 6157  # 对比度
WIA_DPS_DOCUMENT_HANDLING_SELECT = 3088  # 进纸方式

# 进纸方式值
DHS_FLATBED  = 0x001   # 平板
DHS_FEEDER   = 0x002   # ADF 单面
DHS_DUPLEX   = 0x004   # ADF 双面

# Transfer 格式 GUID（用于指定输出格式）
FORMAT_BMP  = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"
FORMAT_JPEG = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
FORMAT_PNG  = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}"
FORMAT_TIFF = "{B96B3CB1-0728-11D3-9D7B-0000F81EF32E}"

FORMAT_GUIDS = {
    "bmp":  FORMAT_BMP,
    "jpg":  FORMAT_JPEG,
    "jpeg": FORMAT_JPEG,
    "png":  FORMAT_PNG,
    "tiff": FORMAT_TIFF,
    "tif":  FORMAT_TIFF,
}


# ============================================================
# 工具函数
# ============================================================

def _safe_prop(item, prop_id, default=None):
    """安全读取 WIA Item / Device 的属性值"""
    try:
        return item.Properties[prop_id].Value
    except Exception:
        return default


def _try_set_prop(item, prop_id, value):
    """尝试设置属性，失败时静默忽略（不同设备支持的属性不同）"""
    try:
        item.Properties[prop_id].Value = value
        return True
    except Exception:
        return False


# ============================================================
# 设备枚举
# ============================================================

def list_devices():
    """返回所有 WIA 扫描仪列表"""
    _com_init()
    try:
        from win32com.client import Dispatch
        dm = Dispatch("Wia.DeviceManager")
        devices = []
        for i in range(dm.DeviceInfos.Count):
            info = dm.DeviceInfos[i + 1]  # WIA COM 集合 1-based
            props = {}
            for prop in info.Properties:
                try:
                    props[prop.Name] = str(prop.Value) if prop.Value is not None else None
                except Exception:
                    props[prop.Name] = None
            devices.append({
                "deviceId": str(info.DeviceID),
                "name": props.get("Name", "Unknown"),
                "manufacturer": props.get("Manufacturer", ""),
                "description": props.get("Description", ""),
                "type": props.get("Type", ""),
                "port": props.get("Port", ""),
            })
        return devices
    finally:
        _com_uninit()


def find_kodak_device_id():
    """自动查找柯达 i3000/i2000 系列设备，返回 DeviceID 或 None"""
    devices = list_devices()
    for d in devices:
        name = (d.get("name", "") or "").lower()
        desc = (d.get("description", "") or "").lower()
        combined = name + " " + desc
        # 匹配柯达常见型号
        if any(kw in combined for kw in ["kodak", "i3000", "i2000", "i4000", "i5", "alaris"]):
            return d["deviceId"]
    # Fallback: 返回第一个扫描仪
    for d in devices:
        if d.get("deviceId"):
            return d["deviceId"]
    return None


# ============================================================
# 扫描逻辑
# ============================================================

def scan_page(item, output_path, img_format="jpg"):
    """
    扫描单页并保存。
    item: WIA Item 对象（已配置属性）
    output_path: 输出文件的完整路径
    img_format: 输出格式
    """
    format_guid = FORMAT_GUIDS.get(img_format.lower(), FORMAT_JPEG)

    # 尝试用指定格式 Transfer，失败则用默认 BMP 后转换
    try:
        from win32com.client import Dispatch
        # WIA 2.0 支持 format 参数: item.Transfer(formatGuid)
        # WIA 1.0: item.Transfer() 无参数
        image = item.Transfer(format_guid)
    except Exception:
        try:
            image = item.Transfer()
        except Exception:
            # 某些设备需要不同的调用方式
            image = item.Transfer(FORMAT_JPEG)

    image.SaveFile(output_path)
    return output_path


def scan_batch(device_id, options):
    """
    执行扫描任务，返回 {"success": True, "files": [...]}
    或 {"success": False, "error": "..."}

    options 字典:
      dpi: int
      color_mode: "color" | "grayscale" | "blackwhite"
      duplex: bool
      output_dir: str
      img_format: str
      prefix: str
    """
    _com_init()
    try:
        from win32com.client import Dispatch
        dm = Dispatch("Wia.DeviceManager")
        device = None

        # 1. 连接设备
        for i in range(dm.DeviceInfos.Count):
            info = dm.DeviceInfos[i + 1]
            if str(info.DeviceID) == device_id:
                device = info.Connect()
                break

        if device is None:
            return {"success": False, "error": f"未找到扫描仪 (DeviceID={device_id})，请检查设备是否已开机并连接"}

        # 2. 设备级别属性（进纸方式）
        dhs = DHS_FEEDER
        if options.get("duplex"):
            dhs = DHS_FEEDER | DHS_DUPLEX
        _try_set_prop(device, WIA_DPS_DOCUMENT_HANDLING_SELECT, dhs)

        # 3. 获取扫描 Item
        if device.Items.Count == 0:
            return {"success": False, "error": "扫描仪没有可用的扫描项"}

        item = device.Items[1]  # 第一个 Item 通常是扫描面

        # 4. 配置扫描参数
        dpi = options.get("dpi", 300)
        _try_set_prop(item, WIA_IPS_XRES, dpi)
        _try_set_prop(item, WIA_IPS_YRES, dpi)

        color_mode = options.get("color_mode", "color")
        intent_map = {"color": 1, "grayscale": 2, "blackwhite": 4}
        _try_set_prop(item, WIA_IPS_CUR_INTENT, intent_map.get(color_mode, 1))

        # 5. 输出路径
        output_dir = options.get("output_dir") or os.getcwd()
        os.makedirs(output_dir, exist_ok=True)
        img_format = options.get("img_format", "jpg")
        prefix = options.get("prefix", "kodak_scan")
        timestamp = int(time.time() * 1000)

        # 6. 扫描：ADF 模式下逐页扫描直到纸尽
        output_files = []
        page = 0
        max_pages = 200  # 安全上限

        while page < max_pages:
            page += 1
            try:
                filename = f"{prefix}_{timestamp}_{page:04d}.{img_format}"
                filepath = os.path.join(output_dir, filename)
                result = scan_page(item, filepath, img_format)
                output_files.append(result)
            except Exception as e:
                msg = str(e)
                # WIA 在 ADF 纸尽时通常抛出特定异常
                if page == 1:
                    # 第一页就失败 → 可能是平板模式下没放纸
                    return {
                        "success": False,
                        "error": f"扫描失败(第{page}页): {msg}。请确保 ADF 中有纸张，或检查扫描仪状态。"
                    }
                # 第 N 页失败 → 可能是纸尽，正常结束
                break

        if len(output_files) == 0:
            return {"success": False, "error": "未产生任何扫描文件。请放入纸张后重试。"}

        return {"success": True, "files": output_files, "pageCount": len(output_files)}

    finally:
        _com_uninit()


# ============================================================
# 状态查询
# ============================================================

def get_device_status(device_id):
    """获取指定设备的连接状态和基本属性"""
    _com_init()
    try:
        from win32com.client import Dispatch
        dm = Dispatch("Wia.DeviceManager")
        for i in range(dm.DeviceInfos.Count):
            info = dm.DeviceInfos[i + 1]
            if str(info.DeviceID) == device_id:
                props = {}
                for prop in info.Properties:
                    try:
                        props[prop.Name] = str(prop.Value) if prop.Value is not None else None
                    except Exception:
                        props[prop.Name] = None
                return {
                    "connected": True,
                    "name": props.get("Name", "Unknown"),
                    "manufacturer": props.get("Manufacturer", "Unknown"),
                    "deviceId": str(info.DeviceID),
                    "type": props.get("Type", ""),
                }
        return {"connected": False, "name": "", "manufacturer": "", "deviceId": device_id}
    finally:
        _com_uninit()


# ============================================================
# CLI 入口
# ============================================================

def build_parser():
    parser = argparse.ArgumentParser(description="Kodak i3000 WIA 扫描控制")
    sub = parser.add_subparsers(dest="command", required=True)

    # list
    sub.add_parser("list", help="列出所有 WIA 扫描仪")

    # status
    sub.add_parser("status", help="检查柯达 i3000 是否就绪")

    # scan
    scan_p = sub.add_parser("scan", help="执行扫描")
    scan_p.add_argument("--dpi", type=int, default=300, help="扫描分辨率 (默认 300)")
    scan_p.add_argument("--color", default="color", choices=["color", "grayscale", "blackwhite"],
                        dest="color_mode", help="色彩模式 (默认 color)")
    scan_p.add_argument("--duplex", action="store_true", help="启用双面扫描")
    scan_p.add_argument("--simplex", action="store_false", dest="duplex", help="单面扫描(默认)")
    scan_p.add_argument("--output", default=None, dest="output_dir", help="输出目录")
    scan_p.add_argument("--device", default=None, dest="device_id", help="扫描仪 DeviceID")
    scan_p.add_argument("--format", default="jpg", choices=["jpg", "png", "tiff"],
                        dest="img_format", help="输出图片格式 (默认 jpg)")
    scan_p.add_argument("--prefix", default="kodak_scan", help="输出文件名前缀")
    scan_p.set_defaults(duplex=False)

    return parser


def main():
    _ensure_pywin32()
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "list":
        devices = list_devices()
        print(json.dumps({"success": True, "devices": devices}, ensure_ascii=False, indent=2))

    elif args.command == "status":
        device_id = find_kodak_device_id()
        if device_id is None:
            print(json.dumps({"connected": False, "name": "", "manufacturer": "",
                              "deviceId": None, "message": "未检测到柯达扫描仪"}, ensure_ascii=False))
        else:
            status = get_device_status(device_id)
            print(json.dumps(status, ensure_ascii=False))

    elif args.command == "scan":
        device_id = args.device_id or find_kodak_device_id()
        if device_id is None:
            print(json.dumps({"success": False, "error": "未检测到可用扫描仪。请确认设备已开机并连接。"}, ensure_ascii=False))
            sys.exit(1)

        options = {
            "dpi": args.dpi,
            "color_mode": args.color_mode,
            "duplex": args.duplex,
            "output_dir": args.output_dir,
            "img_format": args.img_format,
            "prefix": args.prefix,
        }

        result = scan_batch(device_id, options)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
