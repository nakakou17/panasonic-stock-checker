// check-stock.js
// Panasonic Factory Refresh の在庫を JS描画後に判定し、結果をメール送信します。
// - 判定：黒い「買い物かごに入れる」→在庫あり / 灰色「在庫がありません」「在庫なし」→在庫なし
// - 精度：最大15秒待機＋セレクタ優先（在庫なし → カートボタンの順）
// - 出力：コンソール出力＋メール送信（dotenvで読み込んだSMTP設定使用）

const { chromium /*, webkit, firefox */ } = require('playwright');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ======================= 監視対象URL =======================
const URLS = {
  // "掃除機": [
  //   "https://panasonic.jp/pfr-soji/c-db/products/MC-NX700K-W-A/shopping.mc-nx700k-w-a.html",
  // ],
  "洗濯機": [
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX127DRWD-A/shopping.na-lx127drwd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX125DRWD-A/shopping.na-lx125drwd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX127DRJD-A/shopping.na-lx127drjd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX125DRJD-A/shopping.na-lx125drjd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX127CRWD-A/shopping.na-lx127crwd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX125CRWD-A/shopping.na-lx125crwd-a.html",
    "https://panasonic.jp/pfr-wash/c-db/products/NA-LX125CRJD-A/shopping.na-lx125crjd-a.html",
  ],
  "冷蔵庫": [
    "https://panasonic.jp/pfr-reizo/c-db/products/NR-E41EX1WA/shopping.nr-e41ex1wa.html",
    "https://panasonic.jp/pfr-reizo/c-db/products/NR-E41EX1CA/shopping.nr-e41ex1ca.html",
    "https://panasonic.jp/pfr-reizo/c-db/products/NR-C344CWA/shopping.nr-c344cwa.html",
  ],
};

// ======================= 判定セレクタ =======================
const CART_SELECTOR = 'button:has-text("買い物かごに入れる")';
const OOS_SELECTORS = ['text=在庫がありません', 'text=在庫なし'];

// ======================= 環境変数チェック =======================
function ensureEnv(keys) {
  const missing = keys.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    throw new Error(`.env の設定が不足しています → ${missing.join(', ')}`);
  }
}
ensureEnv(['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','MAIL_FROM','MAIL_TO']);

// ======================= メール送信 =======================
async function sendMail(subject, text) {
  const secure = Number(process.env.SMTP_PORT || 465) === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject,
    text,
  });
}

// ======================= デバッグ用保存（任意） =======================
async function saveArtifacts(page, url, tag) {
  try {
    const dir = path.join(process.cwd(), 'artifacts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 90);
    await page.screenshot({ path: path.join(dir, `${safe}_${tag}.png`), fullPage: true });
    fs.writeFileSync(path.join(dir, `${safe}_${tag}.html`), await page.content(), 'utf8');
  } catch { /* noop */ }
}

// ======================= 1URL判定 =======================
async function judge(page, url, waitMs = 30000) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp || !resp.ok()) {
      await saveArtifacts(page, url, 'http_error');
      return '取得失敗';
    }

    // どれかが現れるまで最大 waitMs 待つ（在庫なし or カートボタン）
    const races = [
      ...OOS_SELECTORS.map(sel => page.locator(sel).waitFor({ timeout: waitMs }).catch(() => {})),
      page.locator(CART_SELECTOR).waitFor({ timeout: waitMs }).catch(() => {}),
    ];
    await Promise.race(races);

    // 優先：在庫なし → 次にカート
    for (const sel of OOS_SELECTORS) {
      if (await page.locator(sel).isVisible()) return '在庫なし';
    }
    if (await page.locator(CART_SELECTOR).isVisible()) return '⭐️️在庫あり⭐️';

    // ここまで来たらUI変更/描画遅延の可能性 → アーティファクト保存
    await saveArtifacts(page, url, 'unknown');
    return '取得失敗';
  } catch (e) {
    await saveArtifacts(page, url, 'exception');
    return '取得失敗';
  }
}

// ======================= 全URLチェック =======================
async function checkAll() {
  const headless = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
  const useChromeChannel = (process.env.CHANNEL || '').toLowerCase() === 'chrome';

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    channel: useChromeChannel ? 'chrome' : undefined, // MacにChromeがあるなら CHANNEL=chrome で通りやすく
  });

  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  });

  // webdriverフラグ隠し（簡易）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lines = [`[${nowJst} JST]`];

  let anyInStock = false;

  for (const [category, urls] of Object.entries(URLS)) {
    lines.push(`■ ${category}`);
    for (const url of urls) {
      const result = await judge(page, url, 15000);
      if (result.includes('在庫あり')) anyInStock = true;
      lines.push(`- ${url} — ${result}`);
    }
  }

  await browser.close();

  const body = lines.join('\n');
  const subject = `Panasonic Factory Refresh 在庫チェック`;  
  return { subject, body, anyInStock };
}

// ======================= 実行エントリ =======================
(async () => {
  try {
    const { subject, body, anyInStock } = await checkAll();
    console.log(body);                 // ログにも残す（launchdの標準出力に出ます）
    if (anyInStock) {
     await sendMail(`⚠️ ${subject}（在庫あり）`, body);   // メール送信
    }
  } catch (e) {
    console.error('実行エラー:', e?.message || e);
    process.exit(1);
  }
})();

