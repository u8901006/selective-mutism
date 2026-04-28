import { readFile, writeFile } from "node:fs/promises";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 480000;

const SYSTEM_PROMPT = `你是選擇性緘默症（Selective Mutism）領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的選擇性緘默症相關論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: null, output: null, dedup: null, date: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) opts.input = args[++i];
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    if (args[i] === "--dedup" && args[i + 1]) opts.dedup = args[++i];
    if (args[i] === "--date" && args[i + 1]) opts.date = args[++i];
  }
  return opts;
}

async function loadJSON(path) {
  if (!path) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

function filterUnsummarized(papersData, dedupData) {
  if (!dedupData?.pmids?.length) return papersData;
  const seen = new Set(dedupData.pmids.map(String));
  const filtered = papersData.papers.filter((p) => {
    const id = String(p.pmid || p.doi || "");
    return !seen.has(id) && id !== "";
  });
  return { ...papersData, papers: filtered, count: filtered.length };
}

function buildPrompt(papersData, dateStr) {
  const papersText = JSON.stringify(papersData.papers, null, 2);
  return `以下是 ${dateStr} 從 PubMed、Europe PMC、Crossref、OpenAlex、Semantic Scholar、ERIC 等資料庫抓取的最新選擇性緘默症（Selective Mutism）文獻（共 ${papersData.count} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "社會焦慮": 3,
    "治療介入": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：選擇性緘默症核心、社會焦慮、自閉症鑑別、語言溝通、認知行為治療、學校介入、藥物治療、SSRI、家長訓練、行為抑制、氣質、雙語移民、長期追蹤、盛行率、篩檢評估、神經科學、神經影像、個案報告、系統性回顧。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

async function callGLM(apiKey, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "60", 10);
      throw new Error(`RATE_LIMIT:${retryAfter}`);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    let text = data?.choices?.[0]?.message?.content?.trim() || "";

    if (!text) throw new Error("Empty response from API");

    // Strip markdown code blocks
    if (text.startsWith("```")) {
      text = text.split("\n").slice(1).join("\n");
      text = text.replace(/```$/, "").trim();
    }

    // Robust JSON extraction
    return extractJSON(text);
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {}

  // Try finding JSON object boundaries
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {}
      }
    }
  }

  // Try fixing common issues
  const cleaned = text
    .replace(/[\x00-\x1f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? c : ""))
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"');

  try {
    return JSON.parse(cleaned);
  } catch {}

  throw new Error("Failed to parse JSON from API response");
}

async function analyzeWithFallback(apiKey, prompt) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const result = await callGLM(apiKey, prompt, model);
        console.error(
          `[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`
        );
        return result;
      } catch (e) {
        const msg = e.message;
        if (msg.startsWith("RATE_LIMIT:")) {
          const wait = parseInt(msg.split(":")[1], 10) * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (msg.includes("Failed to parse JSON") && attempt < 2) {
          console.error(`[WARN] JSON parse failed, retrying in 5s...`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error(`[ERROR] ${model} failed: ${msg}`);
        break;
      }
    }
  }
  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHTML(analysis, dateStr) {
  const dateParts = dateStr.split("-");
  const dateDisplay = dateParts.length === 3 ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日` : dateStr;
  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
  const d = new Date(dateStr);
  const weekday = weekdayNames[d.getDay()];

  const summary = analysis?.market_summary || "今日無新文獻。";
  const topPicks = analysis?.top_picks || [];
  const allPapers = analysis?.all_papers || [];
  const keywords = analysis?.keywords || [];
  const topicDist = analysis?.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHTML = "";
  for (const pick of topPicks) {
    const tagsHTML = (pick.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const util = pick.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    const picoHTML = Object.keys(pico).length
      ? `<div class="pico-grid">
          <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${esc(pico.population || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${esc(pico.intervention || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${esc(pico.comparison || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${esc(pico.outcome || "-")}</span></div>
        </div>`
      : "";
    topPicksHTML += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank || ""}</span>
            <span class="emoji-icon">${pick.emoji || "📄"}</span>
            <span class="${utilityClass}">${esc(util)}實用性</span>
          </div>
          <h3>${esc(pick.title_zh || pick.title_en || "")}</h3>
          <p class="journal-source">${esc(pick.journal || "")} · ${esc(pick.title_en || "")}</p>
          <p>${esc(pick.summary || "")}</p>
          ${picoHTML}
          <div class="card-footer">
            ${tagsHTML}
            <a href="${escAttr(pick.url || "#")}" target="_blank">閱讀原文 →</a>
          </div>
        </div>`;
  }

  let allPapersHTML = "";
  for (const paper of allPapers) {
    const tagsHTML = (paper.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const util = paper.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allPapersHTML += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || "📄"}</span>
            <span class="${utilityClass} utility-sm">${esc(util)}</span>
          </div>
          <h3>${esc(paper.title_zh || paper.title_en || "")}</h3>
          <p class="journal-source">${esc(paper.journal || "")}</p>
          <p>${esc(paper.summary || "")}</p>
          <div class="card-footer">
            ${tagsHTML}
            <a href="${escAttr(paper.url || "#")}" target="_blank">PubMed →</a>
          </div>
        </div>`;
  }

  const keywordsHTML = keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join("");

  let topicBarsHTML = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHTML += `
            <div class="topic-row">
              <span class="topic-name">${esc(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>選擇性緘默症研究日報 · ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 選擇性緘默症（Selective Mutism）研究文獻日報，由 AI 自動彙整"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .footer-links { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; animation: fadeUp 0.5s ease 0.4s both; }
  .footer-link-card { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .footer-link-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .footer-link-icon { font-size: 28px; flex-shrink: 0; }
  .footer-link-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .footer-link-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  .footer-meta { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  .footer-meta a { color: var(--muted); text-decoration: none; }
  .footer-meta a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } .footer-meta { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🤫</div>
    <div class="header-text">
      <h1>選擇性緘默症研究日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">${dateDisplay}（週${weekday}）</span>
        <span class="badge badge-count">${totalCount} 篇文獻</span>
        <span class="badge badge-source">PubMed · EuropePMC · Crossref · OpenAlex · Semantic Scholar · ERIC</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日總覽</h2>
    <p class="summary-text">${esc(summary)}</p>
  </div>

  ${topPicksHTML ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP ${topPicks.length}</div>${topPicksHTML}</div>` : ""}

  ${allPapersHTML ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>所有文獻</div>${allPapersHTML}</div>` : ""}

  ${topicBarsHTML ? `<div class="section topic-section"><div class="section-title"><span class="section-icon">📊</span>主題分布</div>${topicBarsHTML}</div>` : ""}

  ${keywordsHTML ? `<div class="section keywords-section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHTML}</div></div>` : ""}

  <div class="footer-links">
    <a class="footer-link-card" href="https://www.leepsyclinic.com/" target="_blank">
      <span class="footer-link-icon">🏥</span>
      <span class="footer-link-name">李政洋身心診所首頁</span>
      <span class="footer-link-arrow">→</span>
    </a>
    <a class="footer-link-card" href="https://blog.leepsyclinic.com/" target="_blank">
      <span class="footer-link-icon">📬</span>
      <span class="footer-link-name">訂閱電子報</span>
      <span class="footer-link-arrow">→</span>
    </a>
    <a class="footer-link-card" href="https://buymeacoffee.com/CYlee" target="_blank">
      <span class="footer-link-icon">☕</span>
      <span class="footer-link-name">Buy Me a Coffee</span>
      <span class="footer-link-arrow">→</span>
    </a>
  </div>

  <div class="footer-meta">
    <span>Powered by Multi-Database + Zhipu AI</span>
    <a href="https://github.com/u8901006/selective-mutism">GitHub</a>
  </div>
</div>
</body>
</html>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.ZHIPU_API_KEY;

  if (!apiKey) {
    console.error("[FATAL] ZHIPU_API_KEY environment variable is required");
    process.exit(1);
  }

  const papersData = await loadJSON(opts.input);
  if (!papersData) {
    console.error("[FATAL] No papers data found");
    process.exit(1);
  }

  const dateStr = opts.date || papersData.date || new Date(Date.now() + 8 * 3600000).toISOString().split("T")[0];

  const dedupData = await loadJSON(opts.dedup);
  const filteredData = dedupData ? filterUnsummarized(papersData, dedupData) : papersData;

  console.error(`[INFO] After dedup: ${filteredData.count} new papers to summarize`);

  let analysis = null;
  if (filteredData.count > 0) {
    const prompt = buildPrompt(filteredData, dateStr);
    analysis = await analyzeWithFallback(apiKey, prompt);
  }

  if (!analysis) {
    analysis = {
      date: dateStr,
      market_summary: "今日無新的選擇性緘默症文獻。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  }

  const html = generateHTML(analysis, dateStr);

  if (opts.output) {
    const { dirname } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(opts.output), { recursive: true });
    await writeFile(opts.output, html, "utf-8");
    console.error(`[INFO] Report saved to ${opts.output}`);
  } else {
    process.stdout.write(html);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
