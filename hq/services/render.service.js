/**
 * HQ — HTML to PNG, via headless Chrome.
 *
 * The other half of the image pipeline. Leonardo renders Hebrew headlines well
 * (measured — see leonardo.service.js), so this is NOT a workaround for bad
 * typography. It's for the cases where the string has to be EXACT and the
 * layout has to be repeatable: a logo, a URL, a price, legal wording, or a
 * template that must come out identical thirty times.
 *
 * The two are usually combined — Leonardo makes the photograph, this puts the
 * precise things on top.
 *
 * Needs a real Chrome binary. Locally that is the installed browser; in the
 * container the Dockerfile installs `chromium` and sets CHROME_PATH. If neither
 * is present `isAvailable()` returns false and the worker says it cannot render
 * rather than failing obscurely mid-job.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function chromePath() {
  return CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function isAvailable() {
  return !!chromePath();
}

/**
 * Screenshot an HTML string at exact pixel dimensions.
 *
 * Everything the page needs must already be IN the page — images arrive as
 * data URIs, inlined by the caller. Chrome captures whatever has painted when
 * it fires, so a remote <img> is a race it will silently lose, leaving a hole
 * where the picture should be. (`--virtual-time-budget` looks like the fix for
 * that and is not: with --headless=new and --screenshot it produces an empty
 * file.)
 *
 * The HTML is pinned to the target size — without it Chrome captures the
 * layout viewport and any stray margin shifts everything by a few pixels,
 * which is invisible in review and obvious in a carousel.
 */
async function htmlToPng(html, { width = 1080, height = 1920, deviceScaleFactor = 1 } = {}) {
  const chrome = chromePath();
  if (!chrome) {
    throw new Error(
      'No Chrome available to render HTML. Fine locally; the Cloud Run image has no browser yet.'
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-render-'));
  const htmlFile = path.join(dir, 'page.html');
  const pngFile = path.join(dir, 'out.png');

  const wrapped = /<html/i.test(html) ? html : `<!doctype html>
<html dir="rtl"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}
  *{box-sizing:border-box}
  /* The brand fonts exist on a designer's machine, not in a container. Noto
     and DejaVu are installed by the Dockerfile and carry Hebrew — without a
     Hebrew-capable fallback every glyph renders as a box, which looks like a
     bug in our code and is not one. */
  body{font-family:'Assistant','Rubik','Heebo','Segoe UI',
       'Noto Sans Hebrew','Noto Sans','DejaVu Sans',Arial,sans-serif}
</style></head><body>${html}</body></html>`;

  fs.writeFileSync(htmlFile, wrapped, 'utf8');

  try {
    await run(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      // Containers run as root with a tiny /dev/shm; without these two Chrome
      // either refuses to start or crashes partway through a screenshot.
      '--no-sandbox', '--disable-dev-shm-usage',
      `--force-device-scale-factor=${deviceScaleFactor}`,
      `--screenshot=${pngFile}`,
      `--window-size=${width},${height}`,
      `file:///${htmlFile.replace(/\\/g, '/')}`,
    ], { timeout: 60_000 });

    if (!fs.existsSync(pngFile)) throw new Error('Chrome produced no image');
    const buffer = fs.readFileSync(pngFile);
    if (buffer.length < 1000) throw new Error('Chrome produced an empty image');
    return buffer;
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { htmlToPng, isAvailable, chromePath };
