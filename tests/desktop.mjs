import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const app = await electron.launch({ args: ["."] });
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".dock");
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.waitForTimeout(3000);
  const browser = async () =>
    app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children[0];
      return {
        visible: view.getVisible(),
        url: view.webContents.getURL(),
        bounds: view.getBounds(),
      };
    });
  assert.match((await browser()).url, /example.com/);
  const isolated = await app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript(
      "({require:typeof window.require,process:typeof window.process,bridge:typeof window.openarc})",
    ),
  );
  assert.deepEqual(isolated, {
    require: "undefined",
    process: "undefined",
    bridge: "undefined",
  });
  await page.getByRole("button", { name: "全局 AI", exact: true }).click();
  assert.equal((await browser()).visible, false);
  await page.getByRole("button", { name: "关闭AI面板" }).click();
  assert.equal((await browser()).visible, true);
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  assert.equal((await browser()).visible, false);
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.className),
    "search-result",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "全局搜索",
  );
  assert.equal((await browser()).visible, true);
  const invalid = await page.evaluate(() =>
    window.openarc.navigate("file:///etc/passwd"),
  );
  assert.ok(invalid.error);
  await page
    .getByRole("button", { name: "最小化browser", exact: true })
    .click();
  assert.equal((await browser()).visible, false);
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click();
  assert.equal((await browser()).visible, true);
  await page.getByRole("button", { name: "打开系统设置", exact: true }).click();
  assert.equal((await browser()).visible, false);
  await page.getByLabel("减少动态效果", { exact: true }).check();
  await page.getByLabel("减少透明度", { exact: true }).check();
  assert.equal(await page.locator(".desktop.reduced.opaque").count(), 1);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.waitForTimeout(150);
  const boxes = await page
    .locator(".window:not(.minimized)")
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { right: r.right, bottom: r.bottom };
      }),
    );
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  assert.ok(boxes.every((r) => r.right <= size.w && r.bottom <= size.h));
  await fs.mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/d1-desktop.png" });
  console.log(
    "PASS: real Electron navigation, isolated globals, overlay hiding/restoring, invalid URL, minimize/restore, focus trap, preferences and host resize.",
  );
} finally {
  await app.close();
}
