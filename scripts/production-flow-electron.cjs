const { chromium } = require("./tools/node_modules/playwright-core");
const { validateTargets } = require("./production-flow-target.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.PROJECTX_FLOW_SHARED_ROOT;
const state = JSON.parse(fs.readFileSync(path.join(root, "state.json")));
validateTargets(state);
const stage = process.argv[2] || "inspect";
const stages = new Set([
  "inspect", "prepare", "login", "scan", "early", "last-pair", "replay", "retry",
  "device-open", "device-scan", "device-cycle", "device-cancel-after-frame", "continuation",
  "cache-conflict", "cache-resume", "matrix-A", "matrix-B", "matrix-C", "roster-upload",
  "policy-upload", "standby", "standby-empty", "offline", "notice-before", "notice-recovery",
  "notice-workspace", "queued-student-correction", "postprocess-issues", "active-upload-lock",
  "ledger-recovery", "pause-badge", "legacy-import", "brotli-control", "outage-A",
  "canvas-rotation", "prepare-draft", "crash-draft", "session-crash", "draft-boundaries",
  "postprocess-viewport",
]);
assert.ok(stages.has(stage), "Unknown Electron stage: " + stage);
const debugPort = Number(process.env.PROJECTX_FLOW_CDP_PORT || 19324);
assert.ok(Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536);
(async () => {
  const endpoint = "http://127.0.0.1:" + debugPort;
  let browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  try {
    let page;
    const deadline = Date.now() + 60000;
    while (!page && Date.now() < deadline) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => {
          try {
            return new URL(p.url()).origin === state.scanner;
          } catch {
            return false;
          }
        });
      if (!page) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(page, "No installed scanner page at " + state.scanner);
    page.setDefaultTimeout(15000);
    const events = [];
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/"))
        events.push({
          origin: u.origin,
          path: u.pathname,
          status: r.status(),
          method: r.request().method(),
        });
    });
    async function snap(name) {
      const out = path.join(root, "evidence", name);
      await page.screenshot({ path: out + ".png" });
      fs.writeFileSync(out + ".txt", await page.locator("body").innerText());
    }
    try {
      if (stage === "prepare") {
        const radio = page.getByRole("radio", { name: /明澈/ });
        if (await radio.isVisible()) {
          await radio.click();
          await page
            .getByRole("button", { name: /确认|使用此风格|开始使用|进入登录/ })
            .click();
        }
        const url = page.getByPlaceholder("https://projectx.school.edu.cn");
        if (!(await url.isVisible())) {
          const back = page.getByRole("button", {
            name: "返回扫描",
            exact: true,
          });
          if (await back.isVisible()) await back.click();
          await page
            .getByRole("button", { name: /^服务器连接(?:（可选）)?$/ })
            .first()
            .click();
        }
        await url.fill(state.server.replace("https:", "http:"));
        await page.getByPlaceholder("sk-xxx...").fill(state.scannerKey);
        let headersWithCredential = 0;
        const requestHook = (req) => {
          if (
            req.url().startsWith(state.server.replace("https:", "http:")) &&
            req.headers()["x-api-key"]
          )
            headersWithCredential++;
        };
        page.on("request", requestHook);
        const test = page.getByRole("button", {
          name: "测试连接",
          exact: true,
        });
        await test.click();
        await page.getByText(/已暂停发送 API Key/).waitFor();
        assert.equal(headersWithCredential, 0);
        await snap("明文未确认时暂停发送凭据");
        const allow = page.getByRole("checkbox", {
          name: /隔离的内网测试环境/,
        });
        await allow.check();
        await test.click();
        await page
          .getByText("服务器可达，上传权限有效", { exact: true })
          .waitFor();
        assert.ok(headersWithCredential > 0);
        const secondOrigin = new URL(state.server);
        secondOrigin.protocol = "http:";
        secondOrigin.port = secondOrigin.port === "5179" ? "5180" : "5179";
        await url.fill(secondOrigin.origin);
        assert.equal(await allow.isChecked(), false);
        page.off("request", requestHook);
        await url.fill(state.server);
        await test.click();
        await page
          .getByText("服务器可达，上传权限有效", { exact: true })
          .waitFor();
        await snap("扫描端HTTPS连接成功");
        await page
          .getByRole("button", { name: "保存配置", exact: true })
          .click();
      }
      if (stage === "login") {
        const file = path.join(
          process.env.APPDATA,
          "answer-card-designer",
          "data",
          "bootstrap-admin.txt",
        );
        const initial = fs.existsSync(file)
          ? fs.readFileSync(file, "utf8").trim()
          : state.changedPassword;
        await page.getByPlaceholder("请输入用户名 / 学号").fill("admin");
        await page
          .getByPlaceholder("请输入密码", { exact: true })
          .fill(initial);
        await page.getByRole("button", { name: /^登录$|登录系统/ }).click();
        const change = page.getByText("首次登录安全设置", { exact: true });
        await Promise.race([
          page.getByText(state.cardTitle, { exact: true }).first().waitFor(),
          change.waitFor(),
        ]);
        if (await change.isVisible()) {
          await page.getByPlaceholder("请输入当前一次性密码").fill(initial);
          await page
            .getByPlaceholder("设置新密码", { exact: true })
            .fill(state.changedPassword);
          await page
            .getByPlaceholder("再次输入新密码")
            .fill(state.changedPassword);
          await page
            .getByRole("button", { name: "修改密码并重新登录" })
            .click();
          await page.getByPlaceholder("请输入用户名 / 学号").fill("admin");
          await page
            .getByPlaceholder("请输入密码", { exact: true })
            .fill(state.changedPassword);
          await page.getByRole("button", { name: /^登录$|登录系统/ }).click();
        }
        await page
          .getByText(state.cardTitle, { exact: true })
          .first()
          .waitFor();
        await snap("扫描端远程选卡");
        await page.getByText(state.cardTitle, { exact: true }).first().click();
        await page.getByText("本地判分+上传服务器", { exact: true }).waitFor();
        await snap("扫描工作台");
      }
      if (stage === "scan") {
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        const manifest = JSON.parse(
          fs.readFileSync(path.join(root, "manifest.json")),
        );
        await page
          .locator("input[type=file]:not([webkitdirectory])")
          .setInputFiles(
            manifest.map((row) => path.join(root, "images", row.image)),
          );
        await snap("导入五十张扫描卷");
        await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
        await page
          .getByText(/阅卷完成：50 张/)
          .first()
          .waitFor({ timeout: 900000 });
        await snap("五十张扫描卷识别结果");
      }
      if (stage === "early" || stage === "last-pair") {
        const pending = JSON.parse(
          fs.readFileSync(
            path.join(root, "evidence", "initial-成绩与排名核验.json"),
          ),
        ).pending.items;
        const group = (n) => {
          const r = pending.find((i) => Number(i.groupId) === n);
          return page
            .getByRole("group", {
              name: "原卷 " + r.sessionId + "/" + r.groupId,
              exact: true,
            })
            .first();
        };
        async function changePair(first, id) {
          const next = group(first + 1),
            previous = group(first);
          await next
            .getByPlaceholder("输入姓名或考号搜索应考学生")
            .fill("测试学生" + id);
          await next
            .getByRole("button", { name: new RegExp("测试学生" + id) })
            .click();
          await snap("按姓名回填学号" + id);
          await next.getByRole("button", { name: "订正此卷" }).click();
          await next
            .getByText(new RegExp("学号 " + id))
            .first()
            .waitFor();
          await previous
            .getByRole("button", { name: "保存此卷", exact: true })
            .click();
          await next
            .getByRole("button", { name: "保存此卷", exact: true })
            .click();
        }
        if (stage === "early") {
          await changePair(0, "10002");
          await changePair(2, "10004");
        } else {
          const first = group(4);
          await first.getByRole("button", { name: "查看原卷" }).click();
          const dialog = page.getByRole("dialog");
          const pic = dialog.locator("[data-page-item] img").first();
          await pic.waitFor();
          await page.waitForFunction(() =>
            [...document.querySelectorAll("[data-page-item] img")].some(
              (img) => img.naturalWidth > 0,
            ),
          );
          const size = await pic.evaluate((img) => [
            img.naturalWidth,
            img.naturalHeight,
          ]);
          await dialog
            .getByRole("button", { name: "顺时针旋转 90 度" })
            .click();
          const svg = dialog.locator("[data-page-item] svg[role=img]").first();
          await svg.waitFor();
          const viewbox = (await svg.getAttribute("viewBox"))
            .split(" ")
            .map(Number);
          assert.deepEqual(viewbox.slice(2), [size[1], size[0]]);
          await snap("原卷顺时针旋转后");
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await changePair(4, "10006");
          await page
            .getByRole("textbox", { name: "订正上传卷学号" })
            .fill("10007");
          await page.getByRole("button", { name: "订正学号并重试" }).click();
        }
        await snap("扫描订正-" + stage);
      }
      if (stage === "replay") {
        const urls = JSON.parse(
          fs.readFileSync(
            path.join(root, "evidence", "electron-device-scan.json"),
          ),
        );
        const session = urls
          .map(
            (e) => e.path.match(/\/api\/scanner\/scan\/([a-f0-9-]{36})$/)?.[1],
          )
          .find(Boolean);
        assert.ok(session);
        const data = await page.evaluate(async (sid) => {
          const details = await fetch("/api/scanner/scan/" + sid).then((r) =>
            r.json(),
          );
          const r = await fetch("/api/scanner/progress/" + sid, {
            signal: AbortSignal.timeout(10000),
          });
          const reader = r.body.getReader(),
            decoder = new TextDecoder();
          let body = "";
          while (body.length < 50000) {
            const v = await reader.read();
            if (v.done) break;
            body += decoder.decode(v.value);
            if (
              /event: (done|error|cancelled|complete)|"type":"(done|error|cancelled|complete)"/.test(
                body,
              )
            )
              break;
          }
          await reader.cancel();
          return {
            status: r.status,
            detailStatus: details.status || details.session?.status,
            data: body,
          };
        }, session);
        assert.equal(data.status, 200);
        assert.ok(data.data.indexOf("warning") >= 0);
        fs.writeFileSync(
          path.join(root, "evidence", "设备终态重连.json"),
          JSON.stringify({ session, ...data }, null, 2),
        );
      }
      if (["device-open", "device-cycle"].includes(stage)) {
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        const card = page.getByText(state.cardTitle, { exact: true }).first();
        await card.waitFor({ timeout: 35000 });
        await card.click();
        await page.getByText("仅本地", { exact: true }).click();
        await page
          .getByRole("button", { name: "开始扫描", exact: true })
          .first()
          .click();
        await page.getByText("单次最多张数", { exact: true }).waitFor();
        await snap("TWAIN设置");
        console.log(
          "controls",
          await page.getByRole("combobox").allTextContents(),
          await page.getByRole("spinbutton").count(),
        );
      }
      if (["device-scan", "device-cycle"].includes(stage)) {
        const panel = page
          .getByRole("dialog")
          .count()
          .then((n) => (n ? page.getByRole("dialog").first() : page));
        const container = await panel;
        const combos = container.getByRole("combobox");
        async function choose(current, value) {
          const box = combos.filter({ hasText: current }).first();
          await box.click();
          await page.getByRole("option", { name: value, exact: true }).click();
        }
        await choose(/^(150|200|300|400|600)$/, "150");
        await choose(/彩色|灰度|黑白/, "灰度");
        await choose(/^A[34]$|^Letter$/, "Letter");
        const standby = container.locator("#scanner-standby");
        if ((await standby.getAttribute("aria-checked")) === "true")
          await standby.click();
        await container.getByRole("spinbutton").first().fill("1");
        await snap("TWAIN开始前设置");
        await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/scanner/scan") &&
              r.request().method() === "POST",
          ),
          container
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click(),
        ]);
        await page
          .getByText("卡查看与改分", { exact: true })
          .waitFor({ timeout: 150000 });
        await snap("TWAIN后处理扫描结果");
        for (const view of ["卡查看与改分", "异常处理", "扫描结果"]) {
          await page
            .getByText(view, { exact: view !== "异常处理" })
            .first()
            .click();
          await snap("TWAIN后处理-" + view);
        }
      }
      if (stage === "device-cancel-after-frame") {
        const toggle = page.locator("#scanner-standby");
        await page
          .getByRole("button", { name: /返回扫描|返回答题卡列表|继续扫描/ })
          .first()
          .or(page.getByText(state.cardTitle, { exact: true }).first())
          .first()
          .waitFor();
        if (!(await toggle.isVisible())) {
          const back = page.getByRole("button", {
            name: "返回扫描",
            exact: true,
          });
          if (await back.isVisible()) await back.click();
          const list = page.getByRole("button", { name: "返回答题卡列表" });
          if (await list.isVisible()) await list.click();
          await page
            .getByText(state.cardTitle, { exact: true })
            .first()
            .click();
          await page.getByText("仅本地", { exact: true }).click();
          await page
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click();
        }
        const panel = page
          .locator("main > div > section")
          .filter({ has: toggle });
        if ((await toggle.getAttribute("aria-checked")) === "true")
          await toggle.click();
        for (const [current, value] of [
          [/^(150|200|300|400|600)$/, "150"],
          [/^A[34]$|^Letter$/, "Letter"],
        ]) {
          await panel
            .getByRole("combobox")
            .filter({ hasText: current })
            .first()
            .click();
          await page.getByRole("option", { name: value, exact: true }).click();
        }
        await panel.getByRole("spinbutton").first().fill("4");
        const [start] = await Promise.all([
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/scanner/scan" &&
              r.request().method() === "POST",
          ),
          panel.getByRole("button", { name: "开始扫描", exact: true }).click(),
        ]);
        const { sessionId } = await start.json();
        const route = "/api/scanner/scan/" + sessionId;
        const read = () =>
          page.evaluate(
            async (path) => (await fetch(path, { cache: "no-store" })).json(),
            route,
          );
        const deadline = Date.now() + 120000;
        let recordId;
        while (!recordId && Date.now() < deadline) {
          const info = await read();
          assert.ok(
            info.workerActive,
            "Scan ended before an image became visible: " + info.session.status,
          );
          recordId = info.records.find((row) => row.hasImage)?.id;
          if (!recordId) await page.waitForTimeout(60);
        }
        assert.ok(recordId, "Waited for a real frame before cancelling");
        await page
          .getByRole("button", { name: "停止扫描", exact: true })
          .click();
        let info = await read();
        while (info.workerActive && Date.now() < deadline) {
          await page.waitForTimeout(200);
          info = await read();
        }
        assert.equal(info.workerActive, false);
        assert.equal(info.session.status, "cancelled");
        const final = await page.evaluate(
          async ({ route, id }) => {
            const info = await (await fetch(route)).json();
            const image = await fetch("/api/scanner/scan-image/" + id);
            return {
              status: info.session.status,
              pages: info.records.length,
              preserved: info.records.some((r) => r.id === id),
              imageStatus: image.status,
              imageBytes: (await image.arrayBuffer()).byteLength,
            };
          },
          { route, id: recordId },
        );
        assert.ok(
          final.preserved &&
            final.imageStatus === 200 &&
            final.imageBytes > 1000,
        );
        await snap("同批出图后取消");
        console.log(JSON.stringify({ sessionId, recordId, ...final }));
      }
      if (stage === "retry") {
        const targets = await page
          .getByRole("button", { name: "重试保存", exact: true })
          .all();
        const labels = await page.getByRole("group").all();
        console.log("queued", targets.length, "groups", labels.length);
        // Snapshot nodes before jobs start moving in the queue.
        const nodes = await page
          .getByRole("button", { name: "重试保存", exact: true })
          .elementHandles();
        for (const node of nodes) {
          if (await node.evaluate((n) => n.isConnected))
            await node.click({ timeout: 6000 });
        }
        await snap("扫描上传队列重试后");
      }
      if (["continuation", "device-cycle"].includes(stage)) {
        const start = () =>
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/scanner/scan" &&
              r.request().method() === "POST",
            { timeout: 30000 },
          );
        const groupLabel = page.getByText(/已扫 \d+ 组/).first();
        const count = Number(
          (await groupLabel.innerText()).match(/已扫 (\d+) 组/)[1],
        );
        await Promise.all([
          start(),
          page.getByRole("button", { name: "继续扫描", exact: true }).click(),
        ]);
        await page
          .getByText(new RegExp("已扫 " + (count + 1) + " 组"))
          .first()
          .waitFor({ timeout: 120000 });
        await snap("继续扫描保留两批");
        const [response] = await Promise.all([
          start(),
          page.getByRole("button", { name: "继续扫描", exact: true }).click(),
        ]);
        const session = await response.json();
        const stop = page.getByRole("button", { name: /^停止扫描$|^结束$/ });
        await stop.click();
        await page.waitForTimeout(2000);
        await snap("第三批主动停止");
        assert.ok(session.sessionId || session.id);
        assert.ok(
          events.some((e) => /cancel/.test(e.path) && e.status === 200),
          "The scanner acknowledged cancellation",
        );
      }
      if (stage === "cache-conflict") {
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "cache-exam.json")),
        );
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        await page.getByText(spec.title, { exact: true }).first().click();
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        await page
          .locator("input[type=file]:not([webkitdirectory])")
          .setInputFiles(path.join(root, "缓存测试", "异卷-10009.png"));
        const completion = page.waitForResponse(
          (r) =>
            r.url().startsWith(state.server) &&
            new URL(r.url()).pathname.endsWith("/complete") &&
            r.request().method() === "POST",
          { timeout: 90000 },
        );
        await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
        const result = await completion;
        assert.ok([200, 409].includes(result.status()));
        await snap("异卷同号进入冲突");
      }
      if (stage === "cache-resume") {
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "cache-exam.json")),
        );
        const dir = path.join(root, "缓存测试");
        const files = JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json")),
        ).map((r) => path.join(dir, "images", r.image));
        assert.equal(files.length, 3);
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const close = page
          .getByRole("button", {
            name: /^关闭$|关闭扫描面板|关闭面板|关闭对话框/,
          })
          .first();
        if (await close.isVisible()) await close.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        let card = page.getByText(spec.title, { exact: true }).first();
        if (!(await card.isVisible())) await page.reload();
        await card.waitFor();
        await card.click();
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        const local = path.join(
          process.env.APPDATA,
          "answer-card-designer",
          "data",
          "answer-card",
          "recognition",
        );
        const payloads = [];
        let simulated = false,
          pausedSession,
          blocked = 0,
          restored = false,
          handlerFailure;
        const snapshots = [];
        const cachePattern = "**/grading/upload-payload/**";
        const uploadPattern =
          state.server + "/api/scanner/upload/sessions/*/pages";
        const onCache = async (route) => {
          let original, backup;
          try {
            const name = path.basename(
              decodeURIComponent(new URL(route.request().url()).pathname),
            );
            if (!simulated) {
              simulated = true;
              const meta = JSON.parse(
                fs.readFileSync(
                  path.join(local, "uploads", spec.card, name + ".upload.json"),
                ),
              );
              original = path.resolve(meta.recognition.blockCrops[0].path);
              const boundary =
                path.resolve(local, "crop-temp", spec.card) + path.sep;
              assert.ok(original.startsWith(boundary));
              backup = original + ".e2e-missing";
              assert.ok(!fs.existsSync(backup));
              fs.renameSync(original, backup);
            }
            const response = await route.fetch();
            payloads.push({ file: name, status: response.status() });
            assert.equal(response.status(), backup ? 404 : 200);
            await route.fulfill({ response });
          } catch (error) {
            handlerFailure = error;
            await route.abort().catch(() => {});
          } finally {
            if (backup && fs.existsSync(backup))
              fs.renameSync(backup, original);
          }
        };
        const onUpload = async (route) => {
          const session = new URL(route.request().url()).pathname
            .split("/")
            .at(-2);
          if (!pausedSession) pausedSession = session;
          if (session === pausedSession && !restored) {
            blocked++;
            await route.abort("internetdisconnected");
          } else await route.continue();
        };
        await page.route(cachePattern, onCache);
        await page.route(uploadPattern, onUpload);
        try {
          await page
            .locator("input[type=file]:not([webkitdirectory])")
            .setInputFiles(files);
          await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
          const retry = page
            .getByRole("button", { name: /重试失败页|重试保存/ })
            .first();
          await retry.waitFor({ timeout: 120000 });
          if (handlerFailure) throw handlerFailure;
          await snap("受控断网后上传队列");
          snapshots.push((await page.locator("body").innerText()).slice(-3500));
          restored = true;
          await retry.click();
          const waitUntil = Date.now() + 60000;
          while (
            !events.some(
              (e) =>
                e.path.endsWith("/" + pausedSession + "/complete") &&
                e.status === 200,
            ) &&
            Date.now() < waitUntil
          )
            await page.waitForTimeout(300);
          if (handlerFailure) throw handlerFailure;
          assert.ok(blocked > 0 && pausedSession);
          const complete = events.filter(
            (e) =>
              e.origin === state.server &&
              e.path.endsWith("/complete") &&
              e.status === 200,
          );
          assert.ok(
            complete.some((e) =>
              e.path.endsWith("/" + pausedSession + "/complete"),
            ),
          );
          assert.equal(payloads.filter((p) => p.status === 404).length, 1);
          assert.ok(payloads.filter((p) => p.status === 200).length >= 2);
          assert.equal(
            events.filter(
              (e) =>
                e.method === "POST" &&
                e.path.endsWith("/recognition") &&
                e.status === 200,
            ).length,
            1,
          );
          await snap("恢复连接后完成续传");
          console.log(
            JSON.stringify({
              payloads,
              blocked,
              pausedSession,
              completions: complete.length,
              fallback: 1,
            }),
          );
        } finally {
          restored = true;
          await page.unroute(cachePattern, onCache);
          await page.unroute(uploadPattern, onUpload);
          fs.writeFileSync(
            path.join(root, "evidence", "缓存与续传观测.json"),
            JSON.stringify(
              { payloads, pausedSession, blocked, snapshots },
              null,
              2,
            ),
          );
        }
      }
      if (
        stage.startsWith("matrix-") ||
        ["roster-upload", "policy-upload"].includes(stage)
      ) {
        const key = stage.startsWith("matrix-") ? stage.slice(7) : "B";
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "matrix-exams.json")),
        )[key];
        if (
          await page
            .getByRole("button", { name: "返回扫描", exact: true })
            .isVisible()
        )
          await page
            .getByRole("button", { name: "返回扫描", exact: true })
            .click();
        const close = page
          .getByRole("button", {
            name: /^关闭$|关闭扫描面板|关闭面板|关闭对话框/,
          })
          .first();
        if (await close.isVisible()) await close.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        const card = page.getByText(spec.title, { exact: true }).first();
        await card.waitFor();
        await card.click();
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        const dir = path.join(
          root,
          stage === "roster-upload"
            ? "名单外审批"
            : stage === "policy-upload"
              ? "公布策略"
              : "卡型" + key,
        );
        const files = JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json")),
        )
          .filter(
            (x) =>
              stage !== "policy-upload" ||
              ["10015", "10016"].includes(x.student),
          )
          .map((x) => path.join(dir, "images", x.image));
        await page
          .locator("input[type=file]:not([webkitdirectory])")
          .setInputFiles(files);
        await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
        await page
          .getByText(/阅卷完成：/)
          .first()
          .waitFor({ timeout: 750000 });
        await snap(
          stage === "roster-upload"
            ? "两份名单外双面卷识别"
            : stage === "policy-upload"
              ? "两份公布策略样本识别"
              : "卡型" + key + "识别上传",
        );
        console.log((await page.locator("body").innerText()).slice(0, 1000));
      }
      if (stage === "standby") {
        const dialog = page.getByRole("dialog").first();
        const toggle = page.locator("#scanner-standby");
        if (!(await toggle.isVisible())) {
          if (
            await page
              .getByRole("button", { name: "返回扫描", exact: true })
              .isVisible()
          )
            await page
              .getByRole("button", { name: "返回扫描", exact: true })
              .click();
          await page
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click();
        }
        await toggle.waitFor();
        if ((await toggle.getAttribute("aria-checked")) !== "true")
          await toggle.click();
        await page.getByRole("spinbutton").first().fill("1");
        await page.getByRole("spinbutton").nth(1).fill("2");
        const starts = [];
        page.on("response", async (r) => {
          if (
            new URL(r.url()).pathname === "/api/scanner/scan" &&
            r.request().method() === "POST" &&
            r.ok()
          )
            starts.push((await r.json()).sessionId);
        });
        await page
          .getByRole("button", { name: "开始扫描", exact: true })
          .first()
          .click();
        const until = Date.now() + 90000;
        while (starts.length < 2 && Date.now() < until)
          await page.waitForTimeout(200);
        assert.ok(starts.length >= 2, "Standby started the next batch");
        await page
          .getByRole("button", { name: "结束", exact: true })
          .first()
          .click();
        await page
          .getByText("卡查看与改分", { exact: true })
          .waitFor({ timeout: 60000 });
        await snap("一直待命结束后保留已扫批次");
        const count = starts.length;
        await page.waitForTimeout(2600);
        assert.equal(starts.length, count);
        console.log("Standby started", count, "sessions and stopped rearming");
      }
      if (stage === "standby-empty") {
        const collapse = page.getByRole("button", {
          name: "收起上传",
          exact: true,
        });
        if (await collapse.isVisible()) await collapse.click();
        const settings = page.locator("#scanner-standby");
        if (await settings.isVisible())
          await page
            .getByRole("button", { name: "关闭", exact: true })
            .first()
            .click();
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        await page.getByText(state.cardTitle, { exact: true }).first().click();
        await page.getByText("仅本地", { exact: true }).click();
        await page
          .getByRole("button", { name: "开始扫描", exact: true })
          .first()
          .click();
        const toggle = page.locator("#scanner-standby");
        if ((await toggle.getAttribute("aria-checked")) !== "true")
          await toggle.click();
        await page.getByRole("spinbutton").first().fill("1");
        const oldEvents = JSON.parse(
          fs.readFileSync(path.join(root, "evidence", "electron-standby.json")),
        );
        const firstId = oldEvents
          .find((e) => e.path.startsWith("/api/scanner/progress/"))
          .path.split("/")
          .pop();
        const first = await page.evaluate(
          async (id) => await (await fetch("/api/scanner/scan/" + id)).json(),
          firstId,
        );
        assert.equal(first.session.card_id, state.cardId);
        assert.ok(first.records.length > 0);
        const idleId = "fixture-standby-empty";
        const lastId = "fixture-standby-next";
        const cancelUrl =
          state.scanner + "/api/scanner/scan/" + lastId + "/cancel";
        const detailsUrl = state.scanner + "/api/scanner/scan/" + lastId;
        const lastProgress =
          state.scanner + "/api/scanner/progress/" + lastId + "*";
        let cancelled = false;
        await page.route(cancelUrl, (route) => {
          cancelled = true;
          return route.fulfill({ json: { ok: true } });
        });
        await page.route(detailsUrl, (route) =>
          route.fulfill({
            json: {
              session: { id: lastId, status: "cancelled" },
              records: [],
              workerActive: false,
            },
          }),
        );
        await page.route(lastProgress, (route) =>
          route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"scanning"}\n\n',
          }),
        );
        const idleEvents =
          state.scanner + "/api/scanner/progress/" + idleId + "*";
        const startUrl = state.scanner + "/api/scanner/scan";
        const starts = [];
        let lastArmTime = 0;
        const observe = (req) => {
          if (
            req.method() === "GET" &&
            new URL(req.url()).pathname === "/api/cards/" + state.cardId
          )
            lastArmTime = Date.now();
        };
        page.on("request", observe);
        await page.route(startUrl, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          starts.push({ start: Date.now(), arm: lastArmTime });
          return route.fulfill({
            json: {
              sessionId: [firstId, idleId, lastId][starts.length - 1] ?? lastId,
            },
          });
        });
        await page.route(idleEvents, (route) =>
          route.fulfill({
            contentType: "text/event-stream",
            body: 'data: {"type":"error","message":"No pages captured"}\n\n',
          }),
        );
        try {
          await page
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click();
          await page
            .getByText(
              "进纸器里还没有答题卡。放上去就会开始，也可以点「结束」。",
              { exact: true },
            )
            .waitFor({ timeout: 90000 });
          assert.equal(starts.length, 2);
          const next = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/scanner/scan" &&
              r.request().method() === "POST" &&
              r.ok(),
            { timeout: 15000 },
          );
          const session = (await (await next).json()).sessionId;
          assert.ok(session && session !== idleId);
          const delay = starts[2].arm - starts[1].arm;
          console.log(
            "Empty tray event shown, elapsed between arming requests",
            delay,
            "ms",
          );
          assert.ok(
            delay >= 4950,
            "Standby rearmed before its five-second interval",
          );
          await page.getByRole("button", { name: "结束", exact: true }).click();
          await page
            .getByText("扫描结果", { exact: true })
            .waitFor({ timeout: 60000 });
          await page.getByText("扫描结果", { exact: true }).click();
          await snap("空纸槽重新待命并结束后保留实扫批次");
          const storage = await page.evaluate(() =>
            Object.entries(localStorage).filter(([key]) =>
              key.includes("postprocess"),
            ),
          );
          assert.ok(
            storage.length > 0 &&
              JSON.stringify(storage).includes(firstId) &&
              !JSON.stringify(storage).includes(idleId),
          );
          assert.equal(cancelled, true);
          const count = starts.length;
          await page.waitForTimeout(5500);
          assert.equal(starts.length, count);
          console.log(
            "Existing TWAIN batch retained, empty session removed and rearmed session cancelled",
            firstId,
          );
        } finally {
          page.off("request", observe);
          await page.unroute(startUrl);
          await page.unroute(idleEvents);
          for (const url of [cancelUrl, detailsUrl, lastProgress])
            await page.unroute(url);
        }
      }
      if (stage === "offline") {
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const close = page.getByRole("button", { name: /^关闭$/ }).first();
        if (await close.isVisible()) await close.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        const card = page.getByText(state.cardTitle, { exact: true }).first();
        await card.waitFor();
        await page.route(state.server + "/**", (route) =>
          route.abort("internetdisconnected"),
        );
        const choose = async (accept) => {
          const message = page.waitForEvent("dialog").then(async (d) => {
            const text = d.message();
            if (accept) await d.accept();
            else await d.dismiss();
            return text;
          });
          await card.click();
          return await message;
        };
        try {
          assert.match(await choose(false), /缓存/);
          await card.waitFor();
          assert.match(await choose(true), /本机版本/);
          await page.getByText(/离线模式：本机缓存版本/).waitFor();
          await snap("离线选卡拒绝后重新确认");
        } finally {
          await page.unroute(state.server + "/**");
        }
        console.log(
          "Offline cancellation stayed on card list; explicit confirmation entered cached card",
        );
      }

      if (
        stage === "notice-workspace" &&
        (await page.getByPlaceholder("请输入用户名 / 学号").isVisible())
      ) {
        await page.getByPlaceholder("请输入用户名 / 学号").fill("admin");
        await page
          .getByPlaceholder("请输入密码", { exact: true })
          .fill(state.changedPassword);
        const remember = page.getByRole("checkbox", { name: /记住密码/ });
        if (await remember.isVisible()) await remember.check();
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page
          .getByPlaceholder("请输入用户名 / 学号")
          .waitFor({ state: "hidden" });
      }
      if (
        ["notice-before", "notice-recovery", "notice-workspace"].includes(stage)
      ) {
        if (stage === "notice-recovery") {
          const session = await page.context().newCDPSession(page);
          const crashed = page.waitForEvent("crash");
          session.send("Page.crash").catch(() => {});
          await crashed;
          await browser.close();
          await assertRecoveryWindow();
        } else {
          await page.evaluate(() => {
            window.__projectxRendererRecovered = true;
            window.dispatchEvent(new Event("projectx:renderer-recovered"));
          });
        }
        const notice = page
          .getByRole("status")
          .filter({ hasText: "界面已自动恢复" });
        await notice.waitFor();
        if (stage === "notice-workspace") {
          const sample = path.join(root, "cache-exam.json");
          if (fs.existsSync(sample)) {
            const { title } = JSON.parse(fs.readFileSync(sample));
            const back = page.getByRole("button", {
              name: "返回扫描",
              exact: true,
            });
            const heading = page
              .locator("header")
              .getByText(title, { exact: true });
            const list = page.getByRole("button", { name: "返回答题卡列表" });
            const selector = page.getByRole("heading", { name: "选择答题卡" });
            await back.or(list).or(selector).first().waitFor();
            if (await back.isVisible()) {
              await back.click();
              await list.waitFor();
            }
            if (!(await heading.isVisible())) {
              if (await list.isVisible()) await list.click();
              await page.getByText(title, { exact: true }).first().click();
              await heading.waitFor();
            }
            await page
              .getByRole("button", { name: "开始扫描", exact: true })
              .scrollIntoViewIfNeeded();
          }
        }
        const results = [];
        const original = await page.evaluate(() => ({
          skin: document.documentElement.dataset.skin,
          theme: document.documentElement.dataset.theme,
        }));
        try {
          for (const skin of ["paper-edge", "flat"]) {
            for (const theme of ["light", "dark"]) {
              await page.evaluate(
                ({ skin, theme }) => {
                  Object.assign(document.documentElement.dataset, {
                    skin,
                    theme,
                  });
                },
                { skin, theme },
              );
              const row = await notice.evaluate((panel) => {
                const ctx = document.createElement("canvas").getContext("2d");
                const background = getComputedStyle(panel).backgroundColor;
                ctx.fillStyle = background;
                ctx.fillRect(0, 0, 1, 1);
                const box = panel.getBoundingClientRect();
                const front = document.elementFromPoint(
                  box.left + 10,
                  box.top + 10,
                );
                return {
                  background,
                  alpha: ctx.getImageData(0, 0, 1, 1).data[3],
                  onTop: panel.contains(front),
                };
              });
              results.push({ skin, theme, ...row });
              await page.screenshot({
                path: path.join(
                  root,
                  "evidence",
                  stage + "-" + skin + "-" + theme + ".png",
                ),
              });
            }
          }
        } finally {
          await page.evaluate((original) => {
            for (const [key, value] of Object.entries(original)) {
              if (value === undefined)
                delete document.documentElement.dataset[key];
              else document.documentElement.dataset[key] = value;
            }
          }, original);
        }
        await notice.getByRole("button", { name: "知道了" }).click();
        await notice.waitFor({ state: "hidden" });
        console.log(JSON.stringify({ results, dismissed: true }));
        if (stage !== "notice-before")
          assert.ok(results.every((r) => r.alpha === 255 && r.onTop));

        async function assertRecoveryWindow() {
          const deadline = Date.now() + 65000;
          while (Date.now() < deadline) {
            browser = await chromium.connectOverCDP(endpoint);
            const candidate = browser
              .contexts()
              .flatMap((context) => context.pages())
              .find((p) => {
                try {
                  return new URL(p.url()).origin === state.scanner;
                } catch {
                  return false;
                }
              });
            if (
              candidate &&
              (await candidate
                .getByText("界面已自动恢复", { exact: true })
                .waitFor({ timeout: 1500 })
                .then(
                  () => true,
                  () => false,
                ))
            ) {
              page = candidate;
              return;
            }
            await browser.close();
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          throw Error(
            "Windows scanner did not display the recovery notice after the renderer crashed",
          );
        }
      }
      if (stage === "queued-student-correction") {
        const fixture = JSON.parse(
          fs.readFileSync(path.join(root, "draft-session.json")),
        );
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "cache-exam.json")),
        );
        assert.equal(fixture.card, spec.card);
        const correction =
          "/api/scanner/session/" +
          fixture.sessionId +
          "/groups/" +
          fixture.group +
          "/correction";
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const heading = page
          .locator("header")
          .getByText(spec.title, { exact: true });
        if (!(await heading.isVisible())) {
          const list = page.getByRole("button", { name: "返回答题卡列表" });
          if (await list.isVisible()) await list.click();
          await page.getByText(spec.title, { exact: true }).first().click();
          await heading.waitFor();
        }
        const saved = await page.evaluate(
          async (url) => await (await fetch(url)).json(),
          correction,
        );
        assert.equal(saved.pages[0].recognition.studentId.value, "10009");
        const adjust = async (newNumber, restore) =>
          page.evaluate(
            async ({ url, newNumber, original }) => {
              const doc = await (await fetch(url)).json();
              const edits = doc.pages.map((p, i) => {
                const cells = p.layout.elements.filter(
                  (c) => c.type === "student_digit",
                );
                const digits = cells.filter(
                  (c) => Number(newNumber[c.digitIndex]) === c.digit,
                );
                const selected = original
                  ? original[i].selected
                  : [
                      ...p.selected.filter(
                        (x) => !cells.some((c) => c.id === x),
                      ),
                      ...digits.map((c) => c.id),
                    ];
                return {
                  sourceId: p.sourceId,
                  revision: p.revision,
                  selected,
                  touched: cells
                    .filter(
                      (c) =>
                        p.selected.includes(c.id) !== selected.includes(c.id),
                    )
                    .map((c) => c.id),
                };
              });
              const res = await fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pages: edits }),
              });
              const result = await res.json();
              return { code: res.status, message: result.message };
            },
            {
              url: correction,
              newNumber,
              original: restore ? saved.pages : null,
            },
          );
        const payload =
          state.scanner +
          "/api/scanner/record/" +
          fixture.record +
          "/upload-payload";
        const endpoint = state.server + "/api/scanner/upload/sessions/*/pages";
        let release,
          intercepted,
          changed = false,
          observed;
        const waitForCache = new Promise((resolve) => (intercepted = resolve));
        const continueUpload = new Promise((resolve) => (release = resolve));
        await page.route(payload, async (route) => {
          const response = await route.fetch();
          intercepted(response.status());
          await continueUpload;
          await route.fulfill({ response });
        });
        await page.route(endpoint, async (route) => {
          const req = route.request();
          const form = await new Response(req.postDataBuffer(), {
            headers: { "Content-Type": req.headers()["content-type"] },
          }).formData();
          const number = JSON.parse(form.get("recognition")).studentId.value;
          if (number !== "10019") return route.abort("aborted");
          observed = { number, url: req.url() };
          await route.continue();
        });
        try {
          await page.getByText("本地判分+上传服务器", { exact: true }).click();
          await page.getByRole("button", { name: /查看扫描后处理/ }).click();
          const status = await Promise.race([
            waitForCache,
            new Promise((_, reject) => {
              const timer = setTimeout(
                () => reject(Error("Test scan did not enqueue a cached page")),
                25000,
              );
              timer.unref();
            }),
          ]);
          assert.equal(status, 200);
          const result = await adjust("10019", false);
          assert.equal(result.code, 200, result.message);
          changed = true;
          const finished = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname.endsWith("/complete") &&
              r.request().method() === "POST" &&
              [200, 409].includes(r.status()),
            { timeout: 60000 },
          );
          release();
          const response = await finished;
          assert.equal(observed?.number, "10019");
          assert.equal(
            new URL(response.url()).pathname.replace(/\/complete$/, ""),
            new URL(observed.url).pathname.replace(/\/pages$/, ""),
          );
          console.log(
            "Queued 10009; cached page read before the correction; uploaded 10019",
            new URL(observed.url).pathname,
          );
        } finally {
          release();
          if (await back.isVisible()) await back.click();
          const local = page.getByText("仅本地", { exact: true });
          if (await local.isVisible()) await local.click();
          if (changed) assert.equal((await adjust("10009", true)).code, 200);
          await page.unroute(payload);
          await page.unroute(endpoint);
        }
      }
      if (stage === "postprocess-issues" || stage === "active-upload-lock") {
        const activeLock = stage === "active-upload-lock";
        const installed =
          process.env.PROJECTX_FLOW_INSTALLATION ||
          path.join(
            process.env.LOCALAPPDATA,
            "Programs",
            "answer-card-designer",
          );
        const exe = fs
          .readdirSync(installed)
          .find((n) => n.endsWith(".exe") && !/uninstall|crashpad/i.test(n));
        assert.ok(exe);
        const created = require("node:child_process").execFileSync(
          path.join(installed, exe),
          [
            path.join(__dirname, "production-flow-postprocess-fixture.cjs"),
            installed,
            activeLock ? "active" : "issues",
          ],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            encoding: "utf8",
            timeout: 25000,
          },
        );
        const fixtures = JSON.parse(created);
        const cache = JSON.parse(
          fs.readFileSync(path.join(root, "cache-exam.json")),
        );
        const { B } = JSON.parse(
          fs.readFileSync(path.join(root, "matrix-exams.json")),
        );
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        const results = page.getByText("扫描结果", { exact: true });
        const read = async (url) =>
          page.evaluate(async (url) => {
            const r = await fetch(url);
            if (!r.ok) throw Error("HTTP " + r.status);
            return r.json();
          }, url);
        const collapse = page.getByRole("button", {
          name: "收起上传",
          exact: true,
        });
        if (await collapse.isVisible()) await collapse.click();
        if (await page.locator("#scanner-standby").isVisible())
          await page
            .getByRole("button", { name: "关闭", exact: true })
            .first()
            .click();
        for (const [spec, kind] of [
          [B, "missing"],
          [cache, "low"],
        ]) {
          const rows = fixtures.filter((f) => f.kind === kind);
          if (!rows.length) continue;
          assert.ok(rows.every((f) => f.card === spec.card));
          if (await back.isVisible()) await back.click();
          const list = page.getByRole("button", { name: "返回答题卡列表" });
          if (await list.isVisible()) await list.click();
          await page.getByText(spec.title, { exact: true }).first().click();
          await page.getByText("仅本地", { exact: true }).click();
          const prior = await page.evaluate(
            ({ spec, rows }) => {
              const existing = Object.keys(localStorage).find((k) =>
                /^projectx-postprocess-sessions\/v1\/\d+\//.test(k),
              );
              if (!existing)
                throw Error(
                  "A test scanner session must have been opened before running this stage",
                );
              const userId = Number(existing.split("/")[2]);
              const sessions =
                "projectx-postprocess-sessions/v1/" + userId + "/" + spec.card;
              const active = "projectx-postprocess-active/v1/" + userId;
              const view =
                "projectx-postprocess-view/v1/" + userId + "/" + spec.card;
              const old = Object.fromEntries(
                [sessions, active, view].map((k) => [
                  k,
                  localStorage.getItem(k),
                ]),
              );
              const at = Date.now();
              localStorage.setItem(
                sessions,
                JSON.stringify({
                  at,
                  userId,
                  sessions: rows.map(({ sessionId, pageCount }) => ({
                    sessionId,
                    pageCount,
                  })),
                }),
              );
              localStorage.setItem(
                active,
                JSON.stringify({
                  at,
                  userId,
                  cardId: spec.card,
                  cardTitle: spec.title,
                }),
              );
              localStorage.removeItem(view);
              return old;
            },
            { spec, rows },
          );
          try {
            await page.reload();
            await results.waitFor();
            await results.click();
            if (activeLock) {
              const row = rows[0];
              const cacheUrl =
                state.scanner +
                "/api/scanner/record/" +
                row.record +
                "/upload-payload";
              let started, release;
              const cached = new Promise((resolve) => (started = resolve));
              const waiting = new Promise((resolve) => (release = resolve));
              const pending = [];
              const targetPages =
                state.server + "/api/scanner/upload/sessions/*/pages";
              let transmitted;
              await page.route(targetPages, async (route) => {
                const req = route.request();
                const form = await new Response(req.postDataBuffer(), {
                  headers: { "Content-Type": req.headers()["content-type"] },
                }).formData();
                const number = JSON.parse(form.get("recognition")).studentId
                  .value;
                if (number !== row.student) return route.abort("aborted");
                transmitted = new URL(req.url()).pathname;
                return route.continue();
              });
              await page.route(cacheUrl, (route) => {
                started(true);
                const transfer = waiting.then(() => route.continue());
                pending.push(transfer);
                return transfer;
              });
              try {
                await back.click();
                await page
                  .getByText("本地判分+上传服务器", { exact: true })
                  .click();
                await page
                  .getByRole("button", { name: /查看扫描后处理/ })
                  .click();
                assert.equal(
                  await Promise.race([
                    cached,
                    page.waitForTimeout(20000).then(() => false),
                  ]),
                  true,
                );
                await results.click();
                const choose = page.getByRole("button", {
                  name: "选择",
                  exact: true,
                });
                const region = page.getByRole("region", {
                  name: "后台上传任务",
                });
                for (const expanded of [true, false]) {
                  const switcher = region.getByRole("button", {
                    name: /收起上传|展开上传/,
                  });
                  if (
                    ((await switcher.getAttribute("aria-expanded")) ===
                      "true") !==
                    expanded
                  )
                    await switcher.click();
                  const panel = await region.boundingBox(),
                    control = await choose.boundingBox();
                  assert.ok(
                    panel && control && panel.y + panel.height <= control.y + 1,
                    "Upload panel must leave the selection toolbar visible",
                  );
                  await choose.click({ trial: true });
                }
                console.log(
                  "Selection toolbar visible and clickable with the upload panel expanded and collapsed",
                );
                await page
                  .getByRole("button", {
                    name: "打开 " + row.student,
                    exact: true,
                  })
                  .click();
                await page.getByText("卡查看与改分", { exact: true }).click();
                const save = page.getByRole("button", {
                  name: "保存修改",
                  exact: true,
                });
                await save.waitFor();
                assert.ok(await save.isDisabled());
                assert.equal(await save.getAttribute("aria-busy"), "true");
                await results.click();
                await page
                  .getByRole("button", { name: "选择", exact: true })
                  .click();
                await page
                  .getByRole("button", {
                    name: "选择 " + row.student,
                    exact: true,
                  })
                  .click();
                await page
                  .getByRole("button", { name: "删除选中（1）", exact: true })
                  .click();
                await page
                  .getByRole("button", { name: "删除", exact: true })
                  .click();
                await page
                  .getByText("这份卷正在上传，请等上传结束再删除本机原图", {
                    exact: true,
                  })
                  .waitFor();
                const info = await read("/api/scanner/scan/" + row.sessionId);
                assert.equal(info.records[0].id, row.record);
                await snap("上传中锁定保存和删除");
                const done = page.waitForResponse(
                  (r) =>
                    new URL(r.url()).pathname.endsWith("/complete") &&
                    r.request().method() === "POST",
                  { timeout: 60000 },
                );
                release();
                const finished = await done;
                assert.ok([200, 409].includes(finished.status()));
                assert.equal(
                  transmitted,
                  new URL(finished.url()).pathname.replace(
                    /\/complete$/,
                    "/pages",
                  ),
                );
                console.log(
                  "Active transfer blocked edit and delete; source record retained, submission status",
                  finished.status(),
                );
              } catch (error) {
                await snap("活动上传操作中断");
                throw error;
              } finally {
                release();
                await Promise.allSettled(pending);
                await page.unroute(cacheUrl);
                await page.unroute(targetPages);
                if (await back.isVisible()) await back.click();
                const mode = page.getByText("仅本地", { exact: true });
                if (await mode.isVisible()) await mode.click();
              }
            } else if (kind === "missing") {
              const cards = page.getByRole("button", { name: /^打开 / });
              await cards.first().waitFor();
              assert.equal(await cards.count(), 2);
              await page.getByText("正常 0", { exact: true }).click();
              await page
                .getByText("没有符合条件的卷子", { exact: true })
                .waitFor();
              await page.getByText("异常 2", { exact: true }).click();
              await page.getByText("列表", { exact: true }).click();
              const query = page.getByRole("textbox", { name: "搜索考号" });
              await query.fill(rows[0].student);
              await page
                .getByRole("cell", { name: rows[0].student, exact: true })
                .waitFor();
              assert.equal(
                await page
                  .getByRole("cell", { name: rows[1].student, exact: true })
                  .count(),
                0,
              );
              await query.fill("");
              await page
                .getByText(/^异常处理/)
                .first()
                .click();
              await page.getByRole("button", { name: /缺页/ }).first().click();
              await page.getByText("第 1 页已到", { exact: true }).waitFor();
              await page.getByText("第 2 页缺失", { exact: true }).waitFor();
              await snap("缺背面卷的异常处理");
              await results.click();
              await page.getByText("方块", { exact: true }).click();
              await page
                .getByRole("button", { name: "选择", exact: true })
                .click();
              const choices = page.getByRole("button", {
                name: /^选择 (?:1000[12]|组 0)$/,
              });
              assert.equal(await choices.count(), 2);
              await choices.nth(0).click();
              await choices.nth(1).click();
              await page
                .getByRole("button", { name: "删除选中（2）", exact: true })
                .click();
              await page
                .getByRole("button", { name: "取消", exact: true })
                .last()
                .click();
              await page.getByText("已选 2 张", { exact: true }).waitFor();
              await page
                .getByRole("button", { name: "删除选中（2）", exact: true })
                .click();
              await page
                .getByRole("button", { name: "删除", exact: true })
                .click();
              await page
                .getByText("没有符合条件的卷子", { exact: true })
                .waitFor();
              for (const row of rows)
                assert.equal(
                  (await read("/api/scanner/scan/" + row.sessionId)).records
                    .length,
                  0,
                );
              console.log(
                "Two synthetic B fronts reported missing backs. Grid, list, search, filters, cancel and two-session delete verified",
              );
            } else {
              const row = rows[0];
              const url =
                "/api/scanner/session/" +
                row.sessionId +
                "/groups/0/correction";
              const before = await read(url);
              const q = before.pages[0].recognition.questions.find(
                (q) => q.questionNumber === 1,
              );
              assert.equal(q.confidence, 0.05);
              await page
                .getByText(/^异常处理/)
                .first()
                .click();
              await page.getByRole("button", { name: /存疑/ }).first().click();
              const item = page
                .getByRole("listitem")
                .filter({ hasText: "第 1 题（客观）" });
              await item.getByText("置信 0.05", { exact: true }).waitFor();
              await item.getByRole("button", { name: "去改这题" }).click();
              const control = page.getByRole("combobox", {
                name: "第 1 题选项",
                exact: true,
              });
              const original = q.selectedOptions[0];
              // Touch the original answer and restore it to confirm without changing the mark.
              for (const val of [original === "B" ? "A" : "B", original]) {
                await control.click();
                await page
                  .getByRole("option", { name: val, exact: true })
                  .click();
              }
              await page.getByText("扫描结果", { exact: true }).click();
              await page.getByText("卡查看与改分", { exact: true }).click();
              const save = page.getByRole("button", {
                name: "保存修改",
                exact: true,
              });
              await save.waitFor();
              assert.equal(await save.isEnabled(), true);
              const [written] = await Promise.all([
                page.waitForResponse(
                  (r) =>
                    new URL(r.url()).pathname === url &&
                    r.request().method() === "PUT",
                ),
                save.click(),
              ]);
              assert.equal(written.status(), 200);
              const after = await read(url);
              const fixed = after.pages[0].recognition.questions.find(
                (q) => q.questionNumber === 1,
              );
              assert.equal(fixed.confidence, 1);
              assert.deepEqual(fixed.selectedOptions, q.selectedOptions);
              assert.equal(
                after.pages[0].revision,
                before.pages[0].revision + 1,
              );
              const response = await read(
                "/api/scanner/session/" + row.sessionId + "/results",
              );
              assert.equal(response.results[0].needsReviewCount, 0);
              await snap("逐题确认后保留原答案");
              console.log(
                "Question 1 confirmed; original selection retained, confidence 0.05 to 1, outstanding questions",
                response.results[0].needsReviewCount,
              );
            }
          } catch (err) {
            await snap("异常队列操作中断-" + kind);
            throw err;
          } finally {
            await page.evaluate((old) => {
              for (const [key, value] of Object.entries(old)) {
                if (value === null) localStorage.removeItem(key);
                else localStorage.setItem(key, value);
              }
            }, prior);
            await page.reload();
          }
        }
      }
      if (stage === "ledger-recovery") {
        const fixture = JSON.parse(
          fs.readFileSync(path.join(root, "draft-session.json")),
        );
        const tuple = [fixture.card, fixture.sessionId, fixture.group];
        const key = "projectx-scanner-upload-recovery/" + JSON.stringify(tuple);
        const read = () =>
          page.evaluate((key) => localStorage.getItem(key), key);
        assert.equal(
          await read(),
          null,
          "Choose a fixture without pending uploads",
        );
        const results = page.getByText("扫描结果", { exact: true });
        if (!(await results.isVisible()))
          await page.getByRole("button", { name: /查看扫描后处理/ }).click();
        await results.click();
        await page
          .getByRole("button", { name: "打开 10009", exact: true })
          .click();
        const save = page.getByRole("button", {
          name: "保存修改",
          exact: true,
        });
        await save.waitFor();
        const abandon = page.getByRole("button", {
          name: "放弃续传",
          exact: true,
        });
        const clear = page.getByRole("button", {
          name: "清除损坏记录",
          exact: true,
        });
        const remoteId = "local-test-" + fixture.sessionId;
        try {
          for (const phase of [
            "partial-pages",
            "completion-pending",
            "damaged",
          ]) {
            const ledger = {
              remoteBase: state.server,
              remoteSessionId: remoteId,
              cardVersion: "0".repeat(24),
              completed: false,
              dpi: 300,
              paperSize: "A4",
              identityMode: "strict",
              pages: [
                {
                  pageNum: 1,
                  side: "front",
                  recordId: fixture.record,
                  token: "test-page",
                  done: phase === "completion-pending",
                },
              ],
            };
            await page.evaluate(
              ([key, value]) => localStorage.setItem(key, value),
              [key, phase === "damaged" ? "{" : JSON.stringify(ledger)],
            );
            await page.reload();
            await save.waitFor();
            assert.equal(await save.isDisabled(), true);
            assert.equal(await abandon.isVisible(), phase === "partial-pages");
            assert.equal(await clear.isVisible(), phase === "damaged");
            if (phase !== "completion-pending") {
              const action = phase === "damaged" ? clear : abandon;
              page.once("dialog", (d) => d.dismiss());
              await action.click();
              assert.notEqual(await read(), null);
              page.once("dialog", (d) => d.accept());
              await action.click();
              assert.equal(await read(), null);
            }
            console.log("Checked upload recovery UI", phase);
          }
        } finally {
          await page.evaluate((key) => localStorage.removeItem(key), key);
          await page.reload();
        }
      }
      if (stage === "pause-badge") {
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "matrix-exams.json")),
        ).B;
        const header = page
          .locator("header")
          .getByText(spec.title, { exact: true });
        if (!(await header.isVisible())) {
          const back = page.getByRole("button", {
            name: "返回扫描",
            exact: true,
          });
          if (await back.isVisible()) await back.click();
          const list = page.getByRole("button", { name: "返回答题卡列表" });
          if (await list.isVisible()) await list.click();
          await page.getByText(spec.title, { exact: true }).first().click();
          await header.waitFor();
        }
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        const clear = page.getByRole("button", { name: "清空", exact: true });
        if (await clear.isVisible()) await clear.click();
        const number = process.env.PROJECTX_FLOW_PAUSE_STUDENT || "10020";
        const inputs = [1, 2].map((n) =>
          path.join(root, "公布策略", "images", number + "-" + n + ".png"),
        );
        await page
          .locator("input[type=file]:not([webkitdirectory])")
          .setInputFiles(inputs);
        const pattern = state.server + "/api/scanner/upload/sessions/*/pages";
        let interrupted = false;
        const health = state.server + "/api/app/health";
        await page.route(health, (route) =>
          interrupted ? route.abort("internetdisconnected") : route.continue(),
        );
        await page.route(pattern, async (route) => {
          if (interrupted) return route.continue();
          interrupted = true;
          await page
            .getByText("服务器离线", { exact: true })
            .first()
            .waitFor({ timeout: 60000 });
          await route.abort("internetdisconnected");
        });
        try {
          await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
          await page
            .getByRole("button", { name: "立即重试", exact: true })
            .last()
            .waitFor({ timeout: 100000 });
          assert.equal(interrupted, true);
          await snap("断网后的实际暂停提示");
          console.log("Pause visible after network interruption");
        } finally {
          await page.unroute(health);
          await page.unroute(pattern);
        }
        const completion = await page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname.endsWith("/complete") &&
            r.request().method() === "POST",
          { timeout: 90000 },
        );
        const status = completion.status();
        assert.ok([200, 409].includes(status));
        if (status === 409) {
          const result = await completion.json();
          assert.ok(
            result.failures?.some((f) => f.studentId === number) ||
              result.reviewCards?.some((c) => c.studentId === number),
            "The restored transfer must identify the pending student",
          );
        }
        const base = new URL(completion.url()).pathname.replace(
          /\/complete$/,
          "",
        );
        assert.equal(
          events.filter((e) => e.path === base + "/pages" && e.status === 200)
            .length,
          2,
        );
        console.log(
          "Reconnected, uploaded both pages and submitted the same session",
          base,
          status,
        );
      }
      if (stage === "legacy-import") {
        const { C: spec } = JSON.parse(
          fs.readFileSync(path.join(root, "matrix-exams.json")),
        );
        const api =
          await require("./tools/node_modules/playwright-core").request.newContext(
            {
              userAgent: "ProjectX-E2E",
              storageState: await page.context().storageState(),
            },
          );
        const input = path.join(root, "卡型C", "旧卡");
        const local = state.scanner + "/api/cards/" + spec.card;
        const headers = { "X-Api-Key": state.scannerKey };
        const endpoint = state.server + "/api/scanner/upload/sessions";
        const files = [1, 2, 3].map((n) => ({
          name: n + ".png",
          mimeType: "image/png",
          buffer: fs.readFileSync(path.join(input, n + ".png")),
        }));
        const batch = await api.post(local + "/grading", {
          multipart: {
            files: files[0],
            identityMode: "legacy",
            pageOrder: "sequential",
          },
        });
        assert.equal(batch.status(), 200);
        const { cardVersion } = await batch.json();
        assert.match(cardVersion, /^[0-9a-f]{24}$/);
        const session = {
          cardId: spec.card,
          cardVersion,
          name: "旧卡页序验收",
          dpi: 300,
          paperSize: "A3",
          identityMode: "legacy",
        };
        const wrong = await api.post(endpoint, {
          headers,
          data: { ...session, cardVersion: "0".repeat(24), pageCount: 1 },
        });
        assert.equal(wrong.status(), 409);
        assert.equal((await wrong.json()).code, "CARD_VERSION_MISMATCH");
        const pages = [];
        for (const [i, file] of files.entries()) {
          const response = await api.post(local + "/recognition", {
            multipart: {
              file,
              identityMode: "legacy",
              page: String(i + 1),
              dpi: "300",
              cardVersion,
            },
          });
          assert.equal(response.status(), 200);
          const r = await response.json();
          assert.equal(r.identity.status, "unverified");
          assert.ok(["QR_MISSING", "QR_UNREADABLE"].includes(r.identity.code));
          pages.push(r);
        }
        assert.equal(pages[0].studentId.value, "10001");
        assert.ok(pages.slice(1).every((p) => !p.studentId?.value));
        for (const size of [3, 1]) {
          const created = await api.post(endpoint, {
            headers,
            data: { ...session, pageCount: size },
          });
          assert.ok(created.ok(), String(created.status()));
          const { sessionId, uploadTokens } = await created.json();
          for (let i = 0; i < size; i++) {
            const r = pages[i];
            const recognition = {
              status: r.status,
              studentId:
                i === 0
                  ? r.studentId
                  : { status: "inherited", value: pages[0].studentId.value },
              identity: r.identity,
              geometry: r.geometry,
              pageNumber: r.pageNumber,
              questions: r.questions,
              subjectiveQuestions: r.subjectiveQuestions,
            };
            const uploaded = await api.post(
              endpoint + "/" + sessionId + "/pages",
              {
                headers,
                multipart: {
                  image: files[i],
                  token: uploadTokens[i],
                  pageNum: String(Math.floor(i / 2) + 1),
                  side: i % 2 === 0 ? "front" : "back",
                  recognition: JSON.stringify(recognition),
                },
              },
            );
            assert.ok(
              uploaded.ok(),
              "upload status " +
                uploaded.status() +
                " " +
                (await uploaded.text()).slice(0, 160),
            );
          }
          const view = await api.get(endpoint + "/" + sessionId + "/results", {
            headers,
          });
          assert.equal(view.status(), 200);
          const preview = await view.json();
          if (size === 3) {
            const group = preview.failures.find(
              (f) => f.studentId === "10001" && /重复学号/.test(f.message),
            );
            assert.ok(
              group,
              "The complete old paper must reach the duplicate gate for the existing student",
            );
            assert.equal(group.pages.length, 3);
          } else {
            assert.equal(preview.results.length, 0);
            assert.ok(preview.failures.length);
            const submitted = await api.post(
              endpoint + "/" + sessionId + "/complete",
              { headers, data: { cardVersion } },
            );
            const completion = await submitted.json();
            assert.match(preview.failures[0].message, /缺页|整数倍|补齐/);
            assert.ok(
              [200, 409, 422].includes(submitted.status()),
              "completion " + submitted.status(),
            );
            assert.ok(
              (completion.reviewCards || []).every(
                (c) => !c.formalScoreRetained,
              ),
            );
          }
          console.log(
            "Legacy group",
            sessionId,
            size,
            "pages",
            preview.failures.map((x) => x.message),
          );
        }
        await api.dispose();
        console.log(
          "Outdated card rejected with 409; only page one provided the student number",
        );
      }
      if (stage === "brotli-control") {
        const { origin } = JSON.parse(
          fs.readFileSync(path.join(root, "encoding-control.json")),
        );
        validateTargets({ server: origin, scanner: state.scanner });
        const blocked = [];
        page.on("requestfailed", (request) => {
          if (request.url().startsWith(origin + "/"))
            blocked.push({
              path: new URL(request.url()).pathname,
              error: request.failure()?.errorText,
            });
        });
        const result = await page.evaluate(async (origin) => {
          const armed = await fetch("/api/app/brotli-gate", { method: "POST" });
          const plain = await fetch(origin + "/plain", { cache: "no-store" });
          const control = await plain.text();
          let outcome;
          try {
            const br = await fetch(origin + "/br", { cache: "no-store" });
            outcome = { status: br.status, text: await br.text() };
          } catch (error) {
            outcome = { error: error.message };
          }
          return { armed: armed.status, plain: plain.status, control, outcome };
        }, origin);
        assert.equal(result.armed, 200);
        assert.equal(result.plain, 200);
        assert.equal(result.control, "projectx benign encoding control");
        assert.ok(result.outcome.error);
        fs.writeFileSync(
          path.join(root, "evidence", "扫描端压缩响应限制.json"),
          JSON.stringify({ result, blocked }, null, 2),
        );
        console.log(JSON.stringify({ result, blocked }));
      }
      if (stage === "outage-A") {
        const dir = path.join(root, "卡型A"),
          spec = JSON.parse(
            fs.readFileSync(path.join(root, "matrix-exams.json")),
          ).A;
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json")),
        );
        const marker = path.join(root, "nginx-outage-ready.json");
        assert.ok(!fs.existsSync(marker), "Use a fresh outage marker");
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        const close = page
          .getByRole("button", {
            name: /^关闭$|关闭扫描面板|关闭面板|关闭对话框/,
          })
          .first();
        if (await close.isVisible()) await close.click();
        const list = page.getByRole("button", { name: "返回答题卡列表" });
        if (await list.isVisible()) await list.click();
        await page.getByText(spec.title, { exact: true }).first().click();
        await page.getByText("本地判分+上传服务器", { exact: true }).click();
        page.on("response", (r) => {
          const u = new URL(r.url());
          if (
            u.origin === state.server &&
            u.pathname.endsWith("/pages") &&
            r.request().method() === "POST" &&
            r.ok() &&
            !fs.existsSync(marker)
          )
            fs.writeFileSync(
              marker,
              JSON.stringify({ at: Date.now(), path: u.pathname }),
            );
        });
        await page
          .locator("input[type=file]:not([webkitdirectory])")
          .setInputFiles(
            manifest.map((x) => path.join(dir, "images", x.image)),
          );
        await page.getByRole("button", { name: /开始阅卷|开始识别/ }).click();
        let observedPause = false;
        const completed = () =>
          new Set(
            events
              .filter(
                (e) =>
                  e.origin === state.server &&
                  e.method === "POST" &&
                  e.path.endsWith("/complete") &&
                  e.status === 200,
              )
              .map((e) => e.path),
          ).size;
        const retry = page.getByRole("button", { name: /重试失败页|重试保存/ });
        const limit = Date.now() + 320000;
        let recoveredManually = 0;
        while (completed() < manifest.length && Date.now() < limit) {
          const txt = await page.locator("body").innerText();
          if (
            !observedPause &&
            /已断线等待恢复|等待恢复连接|已暂停，等待|等待网络恢复|已暂停上传/.test(
              txt,
            )
          ) {
            observedPause = true;
            await snap("五十张上传中断时的队列");
          }
          const restored = fs.existsSync(
            path.join(root, "nginx-restored.json"),
          );
          if (
            restored &&
            Date.now() -
              JSON.parse(
                fs.readFileSync(path.join(root, "nginx-restored.json")),
              ).at >
              25000 &&
            (await retry.count())
          ) {
            for (const el of await retry.elementHandles())
              if (await el.evaluate((n) => n.isConnected)) {
                await el.click({ timeout: 3000 }).catch(() => {});
                recoveredManually++;
              }
          }
          await page.waitForTimeout(400);
        }
        const stats = {
          completed: completed(),
          inputs: manifest.length,
          observedPause,
          recoveredManually,
          sessions: events.filter(
            (e) =>
              e.origin === state.server &&
              e.method === "POST" &&
              e.path.endsWith("/sessions") &&
              e.status === 201,
          ).length,
        };
        fs.writeFileSync(
          path.join(root, "evidence", "五十份断网续传.json"),
          JSON.stringify(stats, null, 2),
        );
        await snap("五十张卷在Nginx恢复后的队列");
        assert.equal(stats.completed, manifest.length);
        console.log(JSON.stringify(stats));
      }

      if (stage === "canvas-rotation") {
        const sample = JSON.parse(
          fs.readFileSync(path.join(root, "draft-session.json")),
        );
        const route =
          "/api/scanner/session/" + sample.sessionId + "/groups/0/correction";
        const capture = () =>
          page.evaluate(async (url) => {
            const doc = await fetch(url).then((r) => r.json()),
              p = doc.pages[0];
            const image = await fetch(p.imageUrl).then((r) => r.arrayBuffer());
            const hash = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", image)),
            )
              .map((n) => n.toString(16).padStart(2, "0"))
              .join("");
            return {
              hash,
              geometry: p.recognition.geometry,
              revision: p.revision,
              selected: p.selected,
            };
          }, route);
        const before = await capture();
        const chosen = page.getByRole("combobox", {
          name: "第 1 题选项",
          exact: true,
        });
        await chosen.waitFor();
        const svg = page
          .locator("svg")
          .filter({ has: page.locator("polygon[data-cell-id]") })
          .first();
        await page.waitForFunction(() =>
          Boolean(document.querySelector("svg image")?.getAttribute("href")),
        );
        const gt = before.geometry;
        for (const angle of [90, 180, 270, 0]) {
          await page
            .getByRole("button", { name: "顺时针旋转 90 度", exact: true })
            .click();
          assert.deepEqual(
            (await svg.getAttribute("viewBox"))
              .split(/\s+/)
              .map(Number)
              .slice(2),
            angle % 180
              ? [gt.imageHeight, gt.imageWidth]
              : [gt.imageWidth, gt.imageHeight],
          );
          if (angle === 90 || angle === 270) {
            const choice = angle === 90 ? "C" : "D";
            const cell = svg.getByRole("button", {
              name: new RegExp("^第 1 题 " + choice + "(，|$)"),
            });
            await cell.scrollIntoViewIfNeeded();
            const pt = await cell.evaluate((p) => {
              const bounds = p.getBoundingClientRect();
              const x = (bounds.left + bounds.right) / 2,
                y = (bounds.top + bounds.bottom) / 2;
              return { x, y, hit: document.elementFromPoint(x, y) === p };
            });
            assert.ok(
              pt.hit,
              "The center of the rotated answer hits the intended polygon",
            );
            await page.mouse.click(pt.x, pt.y);
            assert.equal((await chosen.innerText()).trim(), choice);
          }
        }
        const unchanged = await capture();
        assert.deepEqual(unchanged, before);
        const [save] = await Promise.all([
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === route &&
              r.request().method() === "PUT",
          ),
          page.getByRole("button", { name: "保存修改", exact: true }).click(),
        ]);
        assert.equal(save.status(), 200);
        const after = await capture();
        assert.ok(after.revision > before.revision);
        assert.equal(before.hash, after.hash);
        assert.deepEqual(before.geometry, after.geometry);
        await snap("四向旋转后保存热区改分");
        console.log(
          JSON.stringify({
            original: after.hash,
            beforeRevision: before.revision,
            afterRevision: after.revision,
            angles: [90, 180, 270, 0],
            selected: "D",
          }),
        );
      }

      if (stage === "prepare-draft") {
        const spec = JSON.parse(
          fs.readFileSync(path.join(root, "cache-exam.json")),
        );
        const back = page.getByRole("button", {
          name: "返回扫描",
          exact: true,
        });
        if (await back.isVisible()) await back.click();
        if (
          !(await page.getByText("单次最多张数", { exact: true }).isVisible())
        ) {
          const list = page.getByRole("button", { name: "返回答题卡列表" });
          if (await list.isVisible()) await list.click();
          const card = page.getByText(spec.title, { exact: true }).first();
          if (!(await card.isVisible())) await page.reload();
          await card.waitFor();
          await card.click();
          await page.getByText("仅本地", { exact: true }).click();
          await page
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click();
        }
        const panel = (await page.getByRole("dialog").count())
          ? page.getByRole("dialog").first()
          : page;
        const options = panel.getByRole("combobox");
        for (const [present, wanted] of [
          [/^(150|200|300|400|600)$/, "300"],
          [/^A[34]$|^Letter$/, "Letter"],
        ]) {
          await options.filter({ hasText: present }).first().click();
          await page.getByRole("option", { name: wanted, exact: true }).click();
        }
        const standby = page.locator("#scanner-standby");
        if (
          (await standby.isVisible()) &&
          (await standby.getAttribute("aria-checked")) === "true"
        )
          await standby.click();
        await panel.getByRole("spinbutton").first().fill("1");
        const [start] = await Promise.all([
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === "/api/scanner/scan" &&
              r.request().method() === "POST",
          ),
          panel
            .getByRole("button", { name: "开始扫描", exact: true })
            .first()
            .click(),
        ]);
        const { sessionId } = await start.json();
        assert.ok(sessionId);
        await page
          .getByText("卡查看与改分", { exact: true })
          .waitFor({ timeout: 120000 });
        const info = await page.evaluate(
          async (id) =>
            await fetch("/api/scanner/scan/" + id).then((r) => r.json()),
          sessionId,
        );
        assert.equal(info.session.card_id, spec.card);
        assert.equal(info.records.length, 1);
        const row = info.records[0];
        const installed =
          process.env.PROJECTX_FLOW_INSTALLATION ||
          path.join(
            process.env.LOCALAPPDATA,
            "Programs",
            "answer-card-designer",
          );
        const names = fs
          .readdirSync(installed)
          .filter(
            (name) =>
              name.endsWith(".exe") && !/uninstall|crashpad/i.test(name),
          );
        assert.equal(names.length, 1);
        require("node:child_process").execFileSync(
          path.join(installed, names[0]),
          [
            path.join(__dirname, "production-flow-draft-fixture.cjs"),
            sessionId,
            row.id,
            spec.card,
            installed,
          ],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: "inherit",
            timeout: 20000,
          },
        );
        const result = await page.evaluate(async (id) => {
          const r = await fetch("/api/scanner/session/" + id + "/retry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: "0", previewOnly: true }),
          });
          return { status: r.status, message: (await r.json()).message };
        }, sessionId);
        assert.equal(result.status, 200, JSON.stringify(result));
        const doc = await page.evaluate(
          async (id) =>
            await fetch(
              "/api/scanner/session/" + id + "/groups/0/correction",
            ).then((r) => r.json()),
          sessionId,
        );
        assert.ok(doc.pages[0].recognition.geometry);
        fs.writeFileSync(
          path.join(root, "draft-session.json"),
          JSON.stringify({
            sessionId,
            record: row.id,
            card: spec.card,
            group: "0",
          }),
        );
        await page.reload();
        await page
          .getByText("卡查看与改分", { exact: true })
          .waitFor({ timeout: 60000 });
        await page.getByText("卡查看与改分", { exact: true }).click();
        const entry = page.getByRole("button", { name: /^打开 / }).first();
        if (await entry.isVisible()) await entry.click();
        await snap("带真实识别坐标的故障恢复夹具");
      }
      if (stage === "crash-draft" || stage === "session-crash") {
        const result = page.getByText("卡查看与改分", { exact: true });
        if (!(await result.isVisible())) {
          const button = page.getByRole("button", { name: /查看扫描后处理/ });
          await button.waitFor();
          await button.click();
        }
        const groups = page.getByText(/已扫 \d+ 组/).first();
        const before = await groups.innerText();
        if (stage === "crash-draft") {
          await page.getByText("扫描结果", { exact: true }).click();
          await page
            .getByRole("button", { name: "打开 10009", exact: true })
            .click();
          await page
            .getByRole("combobox", { name: "第 1 题选项", exact: true })
            .waitFor();
        } else {
          const entry = page.getByRole("button", { name: /^打开 / }).first();
          if (await entry.isVisible()) await entry.click();
        }
        await snap("闪退前选中异常卷");
        const inputs = page.getByRole("combobox", { name: /第 [\d.]+ 题选项/ });
        const changes = [];
        for (const control of (await inputs.all()).slice(0, 2)) {
          const label = await control.getAttribute("aria-label");
          const existing = (await control.innerText()).trim(),
            value = existing === "A" ? "B" : "A";
          await control.click();
          await page.getByRole("option", { name: value, exact: true }).click();
          changes.push({ label, value });
        }
        if (stage === "crash-draft")
          assert.equal(
            changes.length,
            2,
            "An editable scanned sheet is required to test draft recovery",
          );
        if (changes.length)
          await page
            .getByText(/已自动存本机草稿/)
            .first()
            .waitFor();
        const cdp = await page.context().newCDPSession(page);
        const crash = page.waitForEvent("crash", { timeout: 15000 });
        cdp.send("Page.crash").catch(() => {});
        await crash;
        await browser.close();
        const deadline = Date.now() + 75000;
        let restored = false;
        while (!restored && Date.now() < deadline) {
          try {
            browser = await chromium.connectOverCDP(endpoint, {
              timeout: 4000,
            });
            for (const candidate of browser
              .contexts()
              .flatMap((c) => c.pages())) {
              if (new URL(candidate.url()).origin !== state.scanner) continue;
              const label = candidate.getByText(/已扫 \d+ 组/).first();
              await label.waitFor({ timeout: 2500 });
              assert.equal(await label.innerText(), before);
              page = candidate;
              restored = true;
              break;
            }
          } catch (error) {
            if (error.code === "ERR_ASSERTION") throw error;
          }
          if (!restored) {
            await browser.close().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        assert.ok(
          restored,
          "The restarted renderer restored the same scanned group count",
        );
        await page
          .getByText(/已恢复上次停留的卷|界面已自动恢复/)
          .first()
          .waitFor();
        await snap("渲染进程崩溃后恢复会话");
        if (changes.length) {
          if (
            !(await page
              .getByRole("combobox", { name: /第 [\d.]+ 题选项/ })
              .first()
              .isVisible())
          )
            await page
              .getByRole("button", { name: /^打开 / })
              .first()
              .click();
          for (const { label, value } of changes)
            assert.equal(
              (
                await page.getByRole("combobox", { name: label }).innerText()
              ).trim(),
              value,
            );
        }
        console.log(
          JSON.stringify({ recovered: before, restoredEdits: changes.length }),
        );
      }

      if (stage === "draft-boundaries") {
        const sample = JSON.parse(
          fs.readFileSync(path.join(root, "draft-session.json")),
        );
        const api = (url) => state.scanner + url;
        const request = async (method, url, data) => {
          const answer = await page.evaluate(
            async ({ method, url, data }) => {
              const result = await fetch(url, {
                method,
                headers: data && { "Content-Type": "application/json" },
                body: data && JSON.stringify(data),
              });
              return {
                ok: result.ok,
                status: result.status,
                data: await result.json(),
              };
            },
            { method, url, data },
          );
          return {
            ok: () => answer.ok,
            status: () => answer.status,
            json: () => answer.data,
            text: () => answer.data.message || "",
          };
        };
        const route = api(
          "/api/scanner/session/" +
            sample.sessionId +
            "/groups/" +
            sample.group +
            "/correction",
        );
        const resultTab = page.getByText("扫描结果", { exact: true });
        if (!(await resultTab.isVisible()))
          await page.getByRole("button", { name: /查看扫描后处理/ }).click();
        await resultTab.click();
        await page
          .getByRole("button", { name: "打开 10009", exact: true })
          .click();
        const opt = page.getByRole("combobox", {
          name: "第 1 题选项",
          exact: true,
        });
        const previous = await request("GET", route).then((r) => r.json());
        const first = previous.pages[0];
        const selected = first.layout.elements.find(
          (e) =>
            e.type === "objective_option" &&
            Number(e.questionNumber) === 1 &&
            first.selected.includes(e.id),
        );
        assert.ok(selected);
        const current = selected.option;
        const another = current === "A" ? "B" : "A";
        await opt.click();
        await page.getByRole("option", { name: another, exact: true }).click();
        await page.getByText(/已自动存本机草稿/).waitFor();
        const written = await request("PUT", route, {
          draft: true,
          pages: previous.pages.map((p) => ({
            sourceId: p.sourceId,
            revision: p.revision,
            selected: p.selected,
            touched: [],
          })),
        });
        assert.ok(written.ok(), await written.text());
        const next = await (await request("GET", route)).json();
        assert.ok(next.pages[0].revision > previous.pages[0].revision);
        await page.reload({ waitUntil: "domcontentloaded" });
        await opt.waitFor();
        assert.equal((await opt.innerText()).trim(), current);
        assert.equal(
          await page.getByText("已恢复本机草稿", { exact: true }).count(),
          0,
        );
        const who = async () => {
          const info = await (await request("GET", api("/api/auth/me"))).json();
          return info.user || info;
        };
        const original = await who();
        assert.equal(original.username, "admin");
        const username = "flow_local_recovery_test";
        const users = await (
          await request("GET", api("/api/users?keyword=" + username))
        ).json();
        if (!users.users.some((u) => u.username === username)) {
          const created = await request("POST", api("/api/users"), {
            username,
            name: "扫描恢复测试教师",
            role: "teacher",
            password: state.password,
          });
          assert.ok(created.ok());
        }
        const login = async (identifier, password) =>
          request("POST", api("/api/auth/login"), { identifier, password });
        const enter = async (identifier, primary, backup) => {
          let response = await login(identifier, primary);
          if (response.status() === 401)
            response = await login(identifier, backup);
          assert.ok(
            response.ok(),
            "Test identity sign-in " + response.status(),
          );
          const data = await response.json();
          if (data.passwordChangeRequired) {
            const changed = await request(
              "POST",
              api("/api/auth/change-password"),
              { oldPassword: primary, newPassword: state.changedPassword },
            );
            assert.ok(changed.ok());
            assert.ok((await login(identifier, state.changedPassword)).ok());
          }
        };
        try {
          await enter(username, state.password, state.changedPassword);
          await page.reload({ waitUntil: "domcontentloaded" });
          assert.equal((await who()).username, username);
          await page.getByText("选择答题卡", { exact: true }).waitFor();
          assert.equal(await resultTab.count(), 0);
        } finally {
          await enter("admin", state.changedPassword, state.adminPassword);
          await page.reload({ waitUntil: "domcontentloaded" });
        }
        await opt.waitFor();
        assert.equal((await opt.innerText()).trim(), current);
        console.log(
          "Old draft was discarded on page revision",
          previous.pages[0].revision,
          "to",
          next.pages[0].revision,
          "; a different teacher saw the card list and the original account returned to its selected sheet",
        );
      }
      if (stage === "postprocess-viewport") {
        const { checkViewports } = require("./production-flow-viewports.cjs");
        const result = page.getByText("扫描结果", { exact: true });
        if (!(await result.isVisible())) {
          const open = page.getByRole("button", { name: /查看扫描后处理/ });
          await open.click();
        }
        await result.click();
        await checkViewports(
          page,
          path.join(root, "evidence"),
          "扫描后处理尺寸",
          page.getByRole("button", { name: "继续扫描", exact: true }),
        );
      }
      if (stage === "inspect") {
        await snap("已安装扫描端首页");
        console.log(
          "page",
          page.url(),
          (await page.locator("body").innerText()).slice(0, 3600),
        );
        console.log(
          "inputs",
          await page
            .locator("input")
            .evaluateAll((ns) =>
              ns.map((n) => [
                n.type,
                n.placeholder,
                n.getAttribute("aria-label"),
              ]),
            ),
        );
      }
    } catch (e) {
      await snap("electron-" + stage + "-failure").catch(() => {});
      throw e;
    } finally {
      fs.writeFileSync(
        path.join(root, "evidence", "electron-" + stage + ".json"),
        JSON.stringify(events, null, 2),
      );
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
