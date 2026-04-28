import { execSync } from "node:child_process";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const EUROPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CROSSREF_API = "https://api.crossref.org/works";
const OPENALEX_API = "https://api.openalex.org/works";
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";
const ERIC_API = "https://api.ies.ed.gov/eric";
const CORE_API = "https://api.core.ac.uk/v3/search/works";

const HEADERS = { "User-Agent": "SelectiveMutismBot/1.0 (research aggregator)" };

const SEARCH_QUERIES = [
  {
    name: "core",
    query: '("selective mutism"[Title/Abstract] OR "selective mutism"[MeSH Terms] OR "elective mutism"[Title/Abstract] OR "situational mutism"[Title/Abstract])',
  },
  {
    name: "anxiety",
    query: '("selective mutism"[Title/Abstract] OR "elective mutism"[Title/Abstract]) AND ("social anxiety"[Title/Abstract] OR "social phobia"[Title/Abstract] OR "anxiety disorder"[Title/Abstract])',
  },
  {
    name: "treatment",
    query: '("selective mutism"[Title/Abstract]) AND ("cognitive behavioral therapy"[Title/Abstract] OR CBT[Title/Abstract] OR exposure[Title/Abstract] OR "behavior therapy"[Title/Abstract] OR SSRI[Title/Abstract] OR fluoxetine[Title/Abstract])',
  },
  {
    name: "school",
    query: '("selective mutism"[Title/Abstract]) AND (school[Title/Abstract] OR classroom[Title/Abstract] OR teacher[Title/Abstract] OR "school-based"[Title/Abstract])',
  },
  {
    name: "asd",
    query: '("selective mutism"[Title/Abstract]) AND (autism[Title/Abstract] OR ASD[Title/Abstract] OR "autism spectrum disorder"[Title/Abstract])',
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === "--max-papers" && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `"${yyyy}/${mm}/${dd}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function fetchJSON(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchPubMedPMIDs(query, retmax = 20) {
  const dateFilter = buildDateFilter(7);
  const fullQuery = `${query} AND ${dateFilter}`;
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(fullQuery)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const data = await fetchJSON(url, 30000);
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[WARN] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchPubMedDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(",");
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const xml = await resp.text();
    return parsePubMedXML(xml);
  } catch (e) {
    console.error(`[WARN] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parsePubMedXML(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractXML(block, "ArticleTitle");
    const abstractParts = [];
    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const label = absMatch[0].match(/Label="([^"]*)"/);
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (label && label[1] && text) abstractParts.push(`${label[1]}: ${text}`);
      else if (text) abstractParts.push(text);
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);
    const journal = extractXML(block, "<Title>", "</Title>") || extractXML(block, "Title");
    const pmid = extractXML(block, "<PMID>", "</PMID>") || extractXML(block, "PMID");
    const year = extractXML(block, "<Year>", "</Year>");
    const month = extractXML(block, "<Month>", "</Month>");
    const day = extractXML(block, "<Day>", "</Day>");
    const dateStr = [year, month, day].filter(Boolean).join(" ");

    const keywords = [];
    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      if (kwMatch[1].trim()) keywords.push(kwMatch[1].trim());
    }

    if (title) {
      papers.push({
        pmid: pmid || "",
        title,
        journal: journal || "",
        date: dateStr,
        abstract,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
        keywords,
        source: "PubMed",
      });
    }
  }
  return papers;
}

function extractXML(block, openTag, closeTag) {
  if (closeTag) {
    const regex = new RegExp(`${escapeRegex(openTag)}([\\s\\S]*?)${escapeRegex(closeTag)}`);
    const m = block.match(regex);
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  }
  const tag = openTag.replace(/[<>]/g, "");
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(regex);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchEuropePMC(maxPapers = 15) {
  const query = '"selective mutism" OR "elective mutism" OR "situational mutism"';
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const dateFrom = d.toISOString().split("T")[0];
  const url = `${EUROPMC_SEARCH}?query=${encodeURIComponent(query)}&resultType=core&pageSize=${maxPapers}&sort=PDATE desc&format=json&FIRST_PDATE>=${dateFrom}`;
  try {
    const data = await fetchJSON(url, 30000);
    const results = data?.resultList?.result || [];
    return results.map((r) => ({
      pmid: r.pmid || r.id || "",
      title: r.title || "",
      journal: r.journalTitle || "",
      date: r.firstPublicationDate || "",
      abstract: (r.abstractText || "").slice(0, 2000),
      url: r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : `https://europepmc.org/article/${r.source}/${r.id}`,
      keywords: (r.keywordList?.keyword || []).map(String),
      source: "EuropePMC",
      doi: r.doi || "",
    }));
  } catch (e) {
    console.error(`[WARN] EuropePMC search failed: ${e.message}`);
    return [];
  }
}

async function searchCrossref(maxPapers = 15) {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const dateFrom = d.toISOString().split("T")[0];
  const url = `${CROSSREF_API}?query.bibliographic=${encodeURIComponent('"selective mutism"')}&filter=type:journal-article,from-pub-date:${dateFrom}&rows=${maxPapers}&sort=published&order=desc`;
  try {
    const data = await fetchJSON(url, 30000);
    const items = data?.message?.items || [];
    return items.map((item) => ({
      pmid: "",
      title: (item.title || [""])[0],
      journal: (item["container-title"] || [""])[0] || item["short-container-title"]?.[0] || "",
      date: item.published?.["date-parts"]?.[0]?.join("-") || item.created?.["date-parts"]?.[0]?.join("-") || "",
      abstract: (item.abstract || "").replace(/<[^>]+>/g, "").slice(0, 2000),
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ""),
      keywords: item.subject || [],
      source: "Crossref",
      doi: item.DOI || "",
    }));
  } catch (e) {
    console.error(`[WARN] Crossref search failed: ${e.message}`);
    return [];
  }
}

async function searchOpenAlex(maxPapers = 15) {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const dateFrom = d.toISOString().split("T")[0];
  const url = `${OPENALEX_API}?search=${encodeURIComponent("selective mutism")}&filter=type:article,from_publication_date:${dateFrom}&sort=publication_date:desc&per_page=${maxPapers}`;
  try {
    const data = await fetchJSON(url, 30000);
    const results = data?.results || [];
    return results.map((r) => ({
      pmid: r.pmid || "",
      title: r.title || "",
      journal: r.primary_location?.source?.display_name || "",
      date: r.publication_date || "",
      abstract: reconstructAbstract(r.abstract_inverted_index),
      url: r.doi ? `https://doi.org/${r.doi.replace("https://doi.org/", "")}` : r.id || "",
      keywords: r.concepts?.slice(0, 5).map((c) => c.display_name) || [],
      source: "OpenAlex",
      doi: r.doi?.replace("https://doi.org/", "") || "",
    }));
  } catch (e) {
    console.error(`[WARN] OpenAlex search failed: ${e.message}`);
    return [];
  }
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return "";
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(" ").slice(0, 2000);
}

async function searchSemanticScholar(maxPapers = 15) {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const dateFrom = d.toISOString().split("T")[0];
  const url = `${SEMANTIC_SCHOLAR_API}?query=${encodeURIComponent('"selective mutism"')}&year=${dateFrom}-&limit=${maxPapers}&fields=title,abstract,journal,externalIds,url,publicationDate`;
  try {
    const data = await fetchJSON(url, 30000);
    const results = data?.data || [];
    return results.map((r) => ({
      pmid: r.externalIds?.PubMed || "",
      title: r.title || "",
      journal: r.journal?.name || "",
      date: r.publicationDate || "",
      abstract: (r.abstract || "").slice(0, 2000),
      url: r.externalIds?.PubMed ? `https://pubmed.ncbi.nlm.nih.gov/${r.externalIds.PubMed}/` : r.url || "",
      keywords: [],
      source: "SemanticScholar",
      doi: r.externalIds?.DOI || "",
    }));
  } catch (e) {
    console.error(`[WARN] Semantic Scholar search failed: ${e.message}`);
    return [];
  }
}

async function searchERIC(maxPapers = 10) {
  const query = '"selective mutism" OR "elective mutism"';
  const url = `${ERIC_API}?search=${encodeURIComponent(query)}&rows=${maxPapers}&sort=dateadded%20desc&format=json`;
  try {
    const data = await fetchJSON(url, 30000);
    const results = data?.response?.docs || [];
    return results.map((r) => ({
      pmid: "",
      title: r.title || "",
      journal: r.source || "",
      date: r.publicationdateyear || "",
      abstract: (r.description || "").slice(0, 2000),
      url: r.url || "",
      keywords: r.subject || [],
      source: "ERIC",
      doi: r.doi || "",
    }));
  } catch (e) {
    console.error(`[WARN] ERIC search failed: ${e.message}`);
    return [];
  }
}

function deduplicatePapers(allPapers) {
  const seen = new Map();
  const deduped = [];
  for (const paper of allPapers) {
    if (!paper.title || paper.title.length < 10) continue;
    const key = paper.doi
      ? `doi:${paper.doi.toLowerCase()}`
      : paper.pmid
        ? `pmid:${paper.pmid}`
        : `title:${paper.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80)}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      deduped.push(paper);
    }
  }
  return deduped;
}

async function main() {
  const opts = parseArgs();
  console.error(`[INFO] Fetching papers from last ${opts.days} days (max ${opts.maxPapers})...`);

  const allPapers = [];

  // PubMed (multiple queries)
  const allPMIDs = new Set();
  for (const q of SEARCH_QUERIES) {
    console.error(`[INFO] PubMed query: ${q.name}`);
    const pmids = await searchPubMedPMIDs(q.query, 15);
    pmids.forEach((id) => allPMIDs.add(id));
  }
  console.error(`[INFO] PubMed: ${allPMIDs.size} unique PMIDs`);
  const pubmedPapers = await fetchPubMedDetails([...allPMIDs]);
  allPapers.push(...pubmedPapers);

  // Other databases in parallel
  const [europepmcPapers, crossrefPapers, openalexPapers, semanticPapers, ericPapers] =
    await Promise.allSettled([
      searchEuropePMC(15),
      searchCrossref(15),
      searchOpenAlex(15),
      searchSemanticScholar(15),
      searchERIC(10),
    ]);

  for (const result of [europepmcPapers, crossrefPapers, openalexPapers, semanticPapers, ericPapers]) {
    if (result.status === "fulfilled") {
      allPapers.push(...result.value);
    }
  }

  const deduped = deduplicatePapers(allPapers);
  console.error(`[INFO] Total after dedup: ${deduped.length} papers`);

  const limited = deduped.slice(0, opts.maxPapers);

  const output = {
    date: new Date(Date.now() + 8 * 3600000).toISOString().split("T")[0],
    count: limited.length,
    papers: limited,
  };

  const json = JSON.stringify(output, null, 2);

  if (opts.output) {
    const fs = await import("node:fs");
    fs.writeFileSync(opts.output, json, "utf-8");
    console.error(`[INFO] Saved to ${opts.output}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
