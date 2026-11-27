const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkViewports(page, directory, label, control) {
  const original = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    theme: document.documentElement.dataset.theme,
  }));
  const dimensions = page.viewportSize();
  const diagnostics = [];
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const skin of ['paper-edge', 'flat']) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { skin, theme });
        for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
          if (dimensions) await page.setViewportSize({ width, height });
          else await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await control.waitFor();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const geometry = await control.evaluate(el => {
            const box = el.getBoundingClientRect();
            const x = box.left + box.width / 2, y = box.top + box.height / 2;
            return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, clickable: el.contains(document.elementFromPoint(x, y)) };
          });
          assert.equal(geometry.width, width);
          diagnostics.push({ skin, theme, width, height, ...geometry });
          await page.screenshot({ path: path.join(directory, [label, skin, theme, width].join('-') + '.png') });
        }
      }
    }
  } finally {
    page.off('pageerror', onError);
    fs.writeFileSync(path.join(directory, label + '.json'), JSON.stringify({ diagnostics, errors }, null, 2));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (dimensions) await page.setViewportSize(dimensions);
    await cdp.detach();
    await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), original);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(diagnostics.filter(row => row.scrollWidth > row.width || !row.clickable), []);
  console.log(label, diagnostics.length, 'viewport and appearance combinations passed');
}

module.exports = { checkViewports };
