# 赞助页面说明

> **适用版本**: v1.3.0 及以上
> **关联 Issue**: [#11 赞助页面](https://github.com/Dalian-No-5-Middle-School-I-T-C/Project-X/issues/11)  
> **关联文档**: [`CHANGELOG.md`](./CHANGELOG.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

本文说明 Project-X Electron 桌面端中**赞助/支持页面**的设计、入口、配置方式与 API 接口。该功能采用低调视觉呈现，当前无实际收款码图片时展示占位 UI，后续通过配置文件与图片目录即可启用。

---

## 1. 功能概述

| 项目 | 说明 |
|------|------|
| **页面名称** | 支持项目（内部模式 `sponsor`） |
| **入口位置** | 右上角账号菜单 →「支持项目」 |
| **顶栏 Tab** | **不显示**（避免与工作模式并列，保持低调） |
| **适用角色** | 所有已登录用户（学生 / 教师 / 管理员） |
| **当前状态** | 接口与页面已就绪，收款码图片待部署时配置 |

---

## 2. 用户操作

1. 登录 Project-X 桌面端（或 Web 开发模式）。
2. 点击右上角 **账号头像下拉菜单**。
3. 选择 **「支持项目」**（位于「修改密码」与「退出登录」之间）。
4. 进入赞助页后，可查看各支付渠道卡片：
   - 已配置收款码：显示二维码图片。
   - 未配置：显示虚线占位框与「收款码待配置」提示。
5. 点击右上角 **「返回」** 回到进入前的页面。

---

## 3. 配置收款码（运维）

无需重新构建前端，按以下三步启用真实收款码：

### 3.1 放置图片

将 PNG 收款码图片放入：

```
data/sponsor/qr/
├── wechat.png    # 微信（示例文件名）
└── alipay.png    # 支付宝（示例文件名）
```

> 图片文件**不纳入 git**，仅保留 `data/sponsor/qr/.gitkeep` 占位。部署时在目标机器上手动放置。

### 3.2 更新配置

编辑 [`src/apps/answer-card/server/data/sponsor.json`](../src/apps/answer-card/server/data/sponsor.json)：

```json
{
  "title": "支持 Project-X",
  "description": "项目持续维护离不开社区支持，感谢您的信任。",
  "channels": [
    { "id": "wechat", "name": "微信", "qrFile": "wechat.png", "enabled": true },
    { "id": "alipay", "name": "支付宝", "qrFile": "alipay.png", "enabled": true }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `title` | 页面标题 |
| `description` | 页面底部说明文字 |
| `channels[].id` | 渠道唯一标识，对应 API 路径中的 `:channelId` |
| `channels[].name` | 渠道显示名称（如「微信」「支付宝」） |
| `channels[].qrFile` | 图片文件名（相对 `data/sponsor/qr/`）；`null` 时显示占位 |
| `channels[].enabled` | `false` 时该渠道不展示 |

### 3.3 重启应用

修改配置或图片后，**重启 Electron 应用或后端服务**即可生效。

---

## 4. API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sponsor` | 返回赞助页配置（含各渠道 `qrUrl` 或 `null`） |
| `GET` | `/api/sponsor/qr/:channelId` | 按渠道 ID 返回收款码图片；未配置或文件不存在时 404 |

### 4.1 配置响应示例（占位态）

```json
{
  "title": "支持 Project-X",
  "description": "项目持续维护离不开社区支持，感谢您的信任。",
  "channels": [
    { "id": "wechat", "name": "微信", "enabled": true, "qrUrl": null },
    { "id": "alipay", "name": "支付宝", "enabled": true, "qrUrl": null }
  ]
}
```

### 4.2 配置响应示例（已启用收款码）

```json
{
  "channels": [
    { "id": "wechat", "name": "微信", "enabled": true, "qrUrl": "/api/sponsor/qr/wechat" }
  ]
}
```

---

## 5. 技术实现

### 5.1 文件结构

| 文件 | 职责 |
|------|------|
| `src/server/routes/sponsor.ts` | 赞助 API 路由 |
| `src/apps/answer-card/server/data/sponsor.json` | 赞助页配置 |
| `data/sponsor/qr/` | 收款码图片目录（运行时） |
| `src/apps/answer-card/client/components/SponsorPage.tsx` | 赞助页 React 组件 |
| `src/apps/answer-card/client/components/AccountMenu.tsx` | 账号菜单入口 |
| `src/apps/answer-card/client/App.tsx` | `sponsor` 模式面板与导航 |
| `src/shared/appVariant.ts` | `ProjectXAppMode` 类型含 `sponsor` |

### 5.2 设计原则

- **低调入口**：仅在账号下拉菜单中暴露，不在顶栏 `mode-toggle` 增加 Tab。
- **占位友好**：`qrFile` 为空或图片缺失时，前端展示虚线框而非报错。
- **配置驱动**：标题、说明、渠道均由 JSON 控制，便于运维替换。
- **无需 Electron 主进程改动**：页面通过 React SPA 实现，与现有架构一致。

### 5.3 数据流

```
AccountMenu「支持项目」
    → App.tsx setMode("sponsor")
    → SponsorPage fetch /api/sponsor
    → sponsor.json + data/sponsor/qr/*.png
    → 渲染二维码或占位 UI
```

---

## 6. 验证清单

| 步骤 | 预期结果 |
|------|----------|
| `curl http://127.0.0.1:5174/api/sponsor` | 返回 JSON，`qrUrl` 为 `null`（占位态） |
| 登录后打开账号菜单 | 可见「支持项目」菜单项 |
| 进入赞助页 | 顶栏无新 Tab；各渠道显示占位框 |
| 放置 `wechat.png` 并更新 `qrFile` | `/api/sponsor/qr/wechat` 返回 200；页面显示图片 |
| 点击「返回」 | 回到进入赞助页前的模式 |

---

## 7. 常见问题

**Q: 为什么顶栏没有「赞助」Tab？**  
A: 有意设计为低调入口，避免干扰日常阅卷工作流。入口仅在账号菜单中。

**Q: 学生端能看到吗？**  
A: 可以。所有已登录用户均可从账号菜单进入，与角色无关。

**Q: 能否新增其他支付渠道？**  
A: 在 `sponsor.json` 的 `channels` 数组中追加条目，并放置对应 PNG 即可。

**Q: 修改配置后需要重新打包吗？**  
A: 不需要。重启应用或后端服务即可。
