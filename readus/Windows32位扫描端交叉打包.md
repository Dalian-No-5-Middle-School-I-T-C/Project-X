# Windows 10 32 位扫描端交叉打包

目标为 Windows 10 32 位工作站，默认输出 `release/答题卡扫描端-<版本>-ia32.msi` 安装包，创建桌面和开始菜单快捷方式。原生 OMR 与 TWAIN 扫描桥由 MinGW 编译；目标机需要安装扫描仪的 32 位 TWAIN 驱动。

MSI 将程序与 `resources/native/win-ia32/` 安装到固定目录。便携 EXE 每次启动会解压到 Windows 临时目录；运行期间若原生文件被清理或隔离，会出现「Native recognizer executable not found」。改用 MSI 后仍需根据安全软件的记录确认是否发生隔离。

## 构建

macOS / Linux 构建机需要 Node.js、npm、CMake、curl、tar、ripgrep 和 `i686-w64-mingw32` 工具链。Apple Silicon 上打包工具可能需要 Rosetta。先按项目说明安装 npm 开发依赖，再执行：

```bash
npm run package:scanner:win32:cross
```

只编译原生组件：

```bash
npm run native:build:mingw:ia32
```

脚本下载并校验 OpenCV 4.13.0 与 nlohmann/json 3.12.0，缓存、安装前缀和原生产物位于 `ignored/native-mingw/`。OpenCV 启用 `core`、`imgproc`、`imgcodecs`、`objdetect` 及其依赖，包含 JPEG、PNG、TIFF、WebP，并显式启用答题卡身份校验需要的 quirc 二维码解码器。C++ 运行库和 OpenCV 静态链接；TWAIN DSM 沿用仓库内的 32 位 DLL。依赖许可证随原生组件一起打包。

桌面应用依赖安装到 `ignored/scanner-package/`。Electron、better-sqlite3 和 sharp 的版本读取根目录锁文件；better-sqlite3 使用对应 Electron ABI 的官方 Windows ia32 预编译包，并校验 GitHub 发布资产的 SHA256。sharp 显式补齐 Windows ia32 二进制。当前 sharp ia32 包的 npm engines 限制为 Node 20，因此安装时使用 `--force`；实际 Electron 中的加载及图片处理仍须在目标 Windows 上验收。

该流程符合 [electron-builder 的跨平台构建说明](https://www.electron.build/docs/features/multi-platform-build/)：具有官方预编译包的 Node 原生模块可以用于交叉打包；本项目两个 C++ 程序由独立 MinGW 工具链生成。

完整命令包含类型检查、扫描端前端和服务端构建、依赖准备、MSI 打包及 SHA256 校验。MSI 编译使用 electron-builder 下载的 WiX；非 Windows 构建机需要支持该 WiX 的 Wine 和 .NET 环境，Apple Silicon 还需要 Rosetta。自带旧 Wine 在较新的 macOS 上可能无法运行 WiX，此时可在 Windows 虚拟机中编译。`--prepared` 仅供已完成上述准备后的重新打包：

```bash
node scripts/package-scanner-win32.cjs --prepared
npm run release:hash:check
```

在 macOS 上准备应用与 WiX 清单，随后在 Windows 上编译 MSI：

```bash
node scripts/package-scanner-win32.cjs --prepare-msi
# 已完成构建与依赖准备时加 --prepared
```

Windows 通过共享文件夹访问同一项目，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-scanner-msi.ps1
```

该脚本复用 electron-builder 生成的 WiX 清单，将应用和工具复制到 Windows 临时工作目录，再编译 MSI。编译后用 Windows Installer 执行管理解包，核对原生文件的安装路径与 SHA256，最后将 MSI 写回共享的 `release/`。编译日志及结果位于 `ignored/msi-tools/windows-build.log` 与 `windows-build-status.json`。回到 macOS 执行 `node scripts/package-scanner-win32.cjs --verify-msi`，复核最终 MSI 内的原生文件并生成发布校验清单。

需要便携版时使用 `npm run package:scanner:win32:portable:cross`；准备完成后可用 `node scripts/package-scanner-win32.cjs --prepared --portable`。

现有 `electron:dist:ia32` / `electron:msi:ia32` 保留 Windows + MSVC 构建流程。交叉构建的原生文件位于独立目录，交叉打包只携带 `native/win-ia32`。

## 交付验收

脚本核对原生 EXE、DLL、Node 插件和展开后的桌面应用均为 PE32 / i386，并逐个确认识别器、扫描桥及 TWAIN DSM 已进入应用资源目录与最终安装包，内容与构建产物一致，再生成 `release/SHA256SUMS.txt` 与 `release/BUILD-INTEGRITY.txt`。这些检查覆盖构建与包内架构，不等同于 Windows 运行和扫描仪验收。

目标机需要实际确认：安装、快捷方式启动、连接服务端、图片导入识别、TWAIN 设备枚举、单页及双面扫描、取消扫描、上传及成绩保存。当前配置为未签名安装包，发布者及校验方法见完整性报告。
