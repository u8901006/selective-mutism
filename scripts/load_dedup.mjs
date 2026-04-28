import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DOCS_DIR = "docs";
const CACHE_FILE = "summarized_cache.json";

async function main() {
  let existingPmids = [];
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    existingPmids = data.pmids || [];
  } catch {
    // first run
  }

  const output = { pmids: existingPmids, lastUpdated: new Date().toISOString() };
  await writeFile(CACHE_FILE, JSON.stringify(output, null, 2), "utf-8");
  process.stdout.write(JSON.stringify(output));
}

main().catch((e) => {
  console.error(`[ERROR] ${e.message}`);
  process.stdout.write('{"pmids":[]}');
});
