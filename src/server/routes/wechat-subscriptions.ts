/**
 * 微信小程序订阅消息绑定路由
 * 挂载点：/api/wechat/subscriptions
 *
 * POST /grade-release  body: { code, templateId }
 *   - Bearer Token 鉴权，学生身份来自 token，不信任前端传入的 studentId。
 *   - code → jscode2session 换 openid。
 *   - 保存 student_id + openid + template_id + accepted_at（UNIQUE(student_id, template_id) 覆盖旧记录）。
 *   - 一次性订阅：每次接受授权只够发一条，故前端每场成绩公布前都会重新引导订阅。
 *
 * GET /diagnostic  管理员部署自检（env 缺失项 / access_token 实取 / 绑定人数）。
 */
import express from "express";
import type { Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getMysqlDb } from "../db";
import {
  getGradeReleaseTemplateId,
  getMissingWechatEnv,
  getOpenIdByLoginCode,
  getWechatRuntimeConfig,
  isWechatConfigured,
  probeWechatAccessToken,
} from "../services/WechatMiniProgramService";

const router = express.Router();
router.use(authMiddleware);

router.post(
  "/grade-release",
  async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ message: "未认证" });
      return;
    }
    if (req.user.role_name !== "student") {
      res.status(403).json({ message: "仅学生账号可订阅成绩发布通知" });
      return;
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const templateId = typeof req.body?.templateId === "string" ? req.body.templateId.trim() : "";
    if (!code || !templateId) {
      res.status(400).json({ message: "缺少 code 或 templateId" });
      return;
    }
    if (!isWechatConfigured()) {
      res.status(503).json({ message: "服务端未配置成绩发布订阅模板" });
      return;
    }
    if (templateId !== getGradeReleaseTemplateId()) {
      res.status(400).json({ message: "无效的订阅模板" });
      return;
    }

    let openid: string;
    try {
      openid = await getOpenIdByLoginCode(code);
    } catch (error) {
      console.error("wechat jscode2session failed:", { studentId: req.user.id, error: error instanceof Error ? error.message : String(error) });
      res.status(502).json({ message: "微信登录凭证校验失败" });
      return;
    }

    const db = getMysqlDb();
    // 仅清理「本学生 / 本模板」的旧绑定，保证 UNIQUE(student_id, template_id) 不冲突。
    // 同一 openid 允许绑定多个学生（共用设备、同一家长多个孩子），故不按 openid 清理。
    try {
      await db.transaction(async (tx) => {
        await tx.run(
          "DELETE FROM wechat_subscription_bindings WHERE template_id = ? AND student_id = ?",
          templateId, req.user!.id,
        );
        await tx.run(
          `INSERT INTO wechat_subscription_bindings
             (student_id, openid, template_id, accepted_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
          req.user!.id, openid, templateId,
        );
      });
    } catch (error) {
      console.error("wechat subscription binding failed:", {
        studentId: req.user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ message: "订阅绑定保存失败，请稍后重试" });
      return;
    }

    res.json({ ok: true });
  },
);

/**
 * GET /diagnostic  部署自检（仅管理员）
 * 绕过 token 缓存实取一次 access_token，用于定位 AppID/AppSecret 错误与
 * 「IP 未加入小程序后台白名单」（errcode 40164）等部署侧问题。
 * 响应只含布尔值、错误码与聚合计数，不回显任何密钥或 openid。
 */
router.get("/diagnostic", async (req: Request, res: Response) => {
  if (req.user?.role_name !== "admin") {
    res.status(403).json({ message: "仅管理员可查看微信订阅自检信息" });
    return;
  }

  const missing = getMissingWechatEnv();
  if (missing.length > 0) {
    res.json({ configured: false, missing });
    return;
  }

  const { page, miniprogramState } = getWechatRuntimeConfig();
  const tokenProbe = await probeWechatAccessToken();
  const db = getMysqlDb();
  const bindings = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM wechat_subscription_bindings WHERE template_id = ?",
    getGradeReleaseTemplateId(),
  );

  res.json({
    configured: true,
    missing: [],
    page,
    miniprogramState,
    accessToken: tokenProbe,
    boundStudents: Number(bindings?.count ?? 0),
  });
});

export default router;
