import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DOCS_DIR = "docs";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function main() {
  let files;
  try {
    files = await readdir(DOCS_DIR);
  } catch {
    await mkdir(DOCS_DIR, { recursive: true });
    files = [];
  }

  const htmlFiles = files
    .filter((f) => f.startsWith("sm-") && f.endsWith(".html"))
    .sort()
    .reverse();

  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];

  let links = "";
  for (const f of htmlFiles.slice(0, 60)) {
    const date = f.replace("sm-", "").replace(".html", "");
    const parts = date.split("-");
    let dateDisplay = date;
    let weekday = "";
    if (parts.length === 3) {
      dateDisplay = `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
      try {
        const d = new Date(date);
        weekday = weekdayNames[d.getDay()];
      } catch {}
    }
    links += `      <li><a href="${f}">📅 ${dateDisplay}（週${weekday}）</a></li>\n`;
  }

  const total = htmlFiles.length;

  const index = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>選擇性緘默症研究日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  .footer-links { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; }
  .footer-link-card { display: flex; align-items: center; gap: 14px; padding: 16px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; text-decoration: none; color: var(--text); transition: all 0.2s; }
  .footer-link-card:hover { border-color: var(--accent); transform: translateX(4px); }
  .footer-link-icon { font-size: 24px; flex-shrink: 0; }
  .footer-link-name { font-size: 14px; font-weight: 600; color: var(--text); flex: 1; }
  footer { margin-top: 40px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">🤫</div>
  <h1>選擇性緘默症研究日報</h1>
  <p class="subtitle">Selective Mutism Research Daily · 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>
${links}  </ul>
  <div class="footer-links">
    <a class="footer-link-card" href="https://www.leepsyclinic.com/" target="_blank">
      <span class="footer-link-icon">🏥</span>
      <span class="footer-link-name">李政洋身心診所首頁</span>
    </a>
    <a class="footer-link-card" href="https://blog.leepsyclinic.com/" target="_blank">
      <span class="footer-link-icon">📬</span>
      <span class="footer-link-name">訂閱電子報</span>
    </a>
    <a class="footer-link-card" href="https://buymeacoffee.com/CYlee" target="_blank">
      <span class="footer-link-icon">☕</span>
      <span class="footer-link-name">Buy Me a Coffee</span>
    </a>
  </div>
  <footer>
    <p>Powered by Multi-Database + Zhipu AI · <a href="https://github.com/u8901006/selective-mutism">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  await writeFile(join(DOCS_DIR, "index.html"), index, "utf-8");
  console.error("[INFO] Index page generated");
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
