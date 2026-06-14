import type { CredentialRecord } from "../repositories/UserRepository";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ROLE_LABELS: Record<CredentialRecord["role"], string> = {
  student: "学生",
  teacher: "教师"
};

export function buildCredentialsHtml(credentials: CredentialRecord[], title: string): string {
  const generatedAt = new Date().toLocaleString("zh-CN");
  const rows = credentials
    .map(
      (item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.username)}</td>
          <td><code>${escapeHtml(item.password)}</code></td>
          <td>${ROLE_LABELS[item.role]}</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 32px; color: #1a1a1a; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .warn { background: #fff3cd; border: 1px solid #ffeeba; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 10px 12px; text-align: left; }
    th { background: #f5f5f5; }
    code { font-family: Consolas, monospace; font-size: 13px; }
    @media print {
      body { margin: 16px; }
      .warn { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">生成时间：${escapeHtml(generatedAt)} · 共 ${credentials.length} 个账号</p>
  <div class="warn">本文件含明文初始密码，请妥善保管并在分发后提醒用户尽快修改密码。勿上传到公共网络。</div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>姓名</th>
        <th>用户名</th>
        <th>初始密码</th>
        <th>角色</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>`;
}
