# Windows 10 32 位扫描端交叉打包

目标为 Windows 10 32 位工作站，输出 `release/答题卡扫描端-<版本>-ia32.exe` 便携版。原生 OMR 与 TWAIN 扫描桥由 MinGW 编译；目标机需要安装扫描仪的 32 位 TWAIN 驱动。

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

完整命令包含类型检查、扫描端前端和服务端构建、依赖准备、便携 EXE 打包及 SHA256 校验。`--prepared` 仅供已完成上述准备后的重新打包：

```bash
node scripts/package-scanner-win32.cjs --prepared
npm run release:hash:check
```

现有 `electron:dist:ia32` / `electron:msi:ia32` 保留 Windows + MSVC 构建流程。交叉构建的原生文件位于独立目录，便携包只携带 `native/win-ia32`。

## 交付验收

脚本核对原生 EXE、DLL、Node 插件和展开后的桌面应用均为 PE32 / i386，并生成 `release/SHA256SUMS.txt` 与 `release/BUILD-INTEGRITY.txt`。这些检查覆盖构建与包内架构，不等同于 Windows 运行和扫描仪验收。

目标机需要实际确认：应用启动、连接服务端、图片导入识别、TWAIN 设备枚举、单页及双面扫描、取消扫描、上传及成绩保存。当前配置为未签名便携版，发布者及校验方法见完整性报告。
