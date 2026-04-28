import { readFile, writeFile } from "node:fs/promises";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: null, cache: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) opts.input = args[++i];
    if (args[i] === "--cache" && args[i + 1]) opts.cache = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  let existingPmids = [];
  try {
    const raw = await readFile(opts.cache || "summarized_cache.json", "utf-8");
    existingPmids = JSON.parse(raw).pmids || [];
  } catch {}

  let newPapers;
  try {
    const raw = await readFile(opts.input || "papers.json", "utf-8");
    newPapers = JSON.parse(raw).papers || [];
  } catch {
    return;
  }

  const seen = new Set(existingPmids.map(String));
  for (const p of newPapers) {
    const id = String(p.pmid || p.doi || "");
    if (id) seen.add(id);
  }

  const output = {
    pmids: [...seen],
    lastUpdated: new Date().toISOString(),
  };

  await writeFile("summarized_cache.json", JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Dedup cache updated: ${output.pmids.length} total PMIDs/DOIs`);
}

main().catch((e) => {
  console.error(`[ERROR] ${e.message}`);
});
