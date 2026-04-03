#!/usr/bin/env node
/**
 * agent.mjs — Web3 Daily Research Report Agent
 *
 * Flow:
 *   1. Fetch hot topics → Claude selects best topic
 *   2. Claude researches + writes report in ONE pass (WebSearch/WebFetch)
 *      → saves draft as  WORK_DIR/YYYYMMDD-<slug>-draft.md
 *   3. Playwright renders Mermaid blocks → PNG → uploads to S3
 *   4. Playwright screenshots key pages  → uploads to S3
 *   5. Replaces image refs in MD → saves WORK_DIR/YYYYMMDD-<slug>.md
 *   6. Publishes final MD to web3research via API
 */

import "dotenv/config";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

import { fetchHotTopics, extractPageImages, searchWeb, closeBrowser } from "./browser.mjs";
import { createClient } from "./publish.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR   = process.env.WORK_DIR   ?? "/tmp/web3r-agent";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const MODEL      = process.env.CLAUDE_MODEL ?? "sonnet";

// ── Helpers ────────────────────────────────────────────────────────────────────

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function dateSlug() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function loadPrompt(name, vars = {}) {
  let text = await readFile(join(__dirname, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, String(v ?? ""));
  return text;
}

/**
 * Run `claude -p` via stdin, return the result string (or structured_output object).
 */
async function callClaude(prompt, { allowedTools = [], jsonSchema = null, maxBudgetUsd = 5, timeoutMs = 5 * 60_000 } = {}) {
  const args = [
    "--print", "--output-format", "json",
    "--model", MODEL,
    "--max-budget-usd", String(maxBudgetUsd),
    "--no-session-persistence",
    "--dangerously-skip-permissions",
  ];
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
  if (jsonSchema)          args.push("--json-schema", JSON.stringify(jsonSchema));

  const { stdout, stderr } = await new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => err += d);
    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}\nstderr: ${err.slice(0, 400)}\nstdout: ${out.slice(0, 200)}`));
      else            resolve({ stdout: out, stderr: err });
    });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
  });

  if (stderr?.trim()) log(`  [claude] ${stderr.trim().slice(0, 120)}`);

  const parsed = JSON.parse(stdout);
  if (parsed.is_error) throw new Error(`claude error: ${parsed.result}`);
  return parsed.structured_output ?? parsed.result ?? "";
}

// ── Step 1: Hot topics ─────────────────────────────────────────────────────────

async function getHotTopics() {
  log("Fetching hot topics...");
  const topics = await fetchHotTopics();
  log(`Got ${topics.length} topics`);
  if (!topics.length) throw new Error("No topics returned");
  return topics;
}

// ── Step 2: Select topic ──────────────────────────────────────────────────────

/**
 * Parse previous report names (e.g. "web3-20260403-ethereum-lido-merge-en")
 * and return deduplicated topic slugs with dates, sorted newest first.
 */
function parsePreviousTopics(reports) {
  const seen = new Map(); // slug → date string
  for (const r of reports) {
    const m = (r.name ?? "").match(/^web3-(\d{8})-(.+?)-(en|zh)$/);
    if (!m) continue;
    const [, date, slug] = m;
    if (!seen.has(slug) || seen.get(slug) < date) seen.set(slug, date);
  }
  // Sort newest first, return "YYYY-MM-DD: slug" lines
  return [...seen.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, 30) // keep last ~30 unique topics
    .map(([slug, date]) => `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}: ${slug}`)
    .join("\n");
}

async function selectTopic(topics, previousTopicsText = "") {
  log("Selecting topic...");
  const list = topics.map(t =>
    `${t.rank}. [热度:${t.hot}] ${t.title}${t.url ? `\n   URL: ${t.url}` : ""}`
  ).join("\n");

  const schema = {
    type: "object",
    properties: {
      title:        { type: "string" },
      slug:         { type: "string" },
      why:          { type: "string" },
      is_followup:  { type: "boolean" },
      key_entities: { type: "array", items: { type: "string" } },
    },
    required: ["title", "slug", "why", "is_followup", "key_entities"],
  };

  const raw = await callClaude(
    await loadPrompt("select-topic", { topics: list, previous_topics: previousTopicsText }),
    { jsonSchema: schema }
  );

  const sel = (typeof raw === "object") ? raw : JSON.parse(raw.match(/(\{[\s\S]*\})/s)[1]);
  log(`Topic: "${sel.title.slice(0, 80)}"  slug: ${sel.slug}  followup: ${sel.is_followup}`);
  return sel;
}

// ── Step 3: Research + Write (single claude call) ─────────────────────────────

async function researchAndWrite(topic, reportsDir, isFollowup = false) {
  log(`Research + writing EN report (WebSearch/WebFetch enabled)${isFollowup ? " [FOLLOWUP MODE]" : ""}...`);

  const entities = (topic.key_entities ?? []);
  const followupNote = isFollowup
    ? "NOTE: This topic has been covered in a previous report. Write this as a **follow-up / expansion** — focus on NEW developments, updated data, and deeper angles not previously covered. Open with a brief recap (1 paragraph) then dive into what is new."
    : "";
  const prompt = await loadPrompt("research-and-write", {
    title:              topic.title.slice(0, 200),
    title_short:        topic.title.slice(0, 80),
    context:            (topic.why ?? "").slice(0, 400),
    key_entities:       entities.join(", "),
    key_entities_first: entities[0] ?? topic.title.slice(0, 50),
    followup_note:      followupNote,
  });

  const markdown = await callClaude(prompt, {
    allowedTools: ["WebSearch", "WebFetch"],
    maxBudgetUsd: 10,
    timeoutMs:    15 * 60_000,
  });

  const draftPath = join(reportsDir, `draft-en.md`);
  await writeFile(draftPath, markdown, "utf8");
  log(`Draft (EN) saved → ${draftPath}  (${markdown.length} chars)`);

  return { markdown, draftPath };
}

async function translateToZh(englishDraft, reportsDir, isFollowup = false) {
  log("Translating EN → ZH...");

  const followupNote = isFollowup
    ? "注意：此主题在近期报告中已有覆盖。本次为续写/扩展版本，需在开篇简要回顾后重点呈现新进展。"
    : "";
  const prompt = await loadPrompt("research-and-write-zh", {
    english_draft: englishDraft,
    followup_note: followupNote,
  });

  const markdown = await callClaude(prompt, {
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs:    10 * 60_000,
  });

  const draftPath = join(reportsDir, `draft-zh.md`);
  await writeFile(draftPath, markdown, "utf8");
  log(`Draft (ZH) saved → ${draftPath}  (${markdown.length} chars)`);

  return { markdown, draftPath };
}

// ── Step 4: Screenshots ───────────────────────────────────────────────────────

/**
 * Parse {{SCREENSHOT_N: https://url}} placeholders that Claude embeds in the draft.
 * Returns [ { index, url, placeholder } ]
 */
function parseScreenshotPlaceholders(markdown) {
  const refs = [];
  for (const m of markdown.matchAll(/\{\{SCREENSHOT_(\d+):\s*(https?:\/\/[^}\s]+)\}\}/g)) {
    refs.push({ index: parseInt(m[1], 10), url: m[2].trim(), placeholder: m[0] });
  }
  return refs;
}

async function capturePageImages(markdown, topic) {
  const placeholders = parseScreenshotPlaceholders(markdown);
  log(`Found ${placeholders.length} image placeholder(s) in draft`);

  const images = []; // [ { buffer, contentType, alt, src, placeholder } ]

  if (placeholders.length > 0) {
    // Extract real images from the pages Claude actually fetched during research
    for (const ref of placeholders.slice(0, 4)) {
      log(`  Extracting images from: ${ref.url}`);
      const extracted = await extractPageImages(ref.url, 1).catch(e => {
        log(`  Image extract failed (${ref.url}): ${e.message}`);
        return [];
      });
      if (extracted.length > 0) {
        images.push({ ...extracted[0], placeholder: ref.placeholder, index: ref.index, pageUrl: ref.url });
        log(`  Got image: ${extracted[0].src.slice(0, 80)}`);
      } else {
        log(`  No usable image found on ${ref.url} — placeholder will be removed`);
        images.push({ buffer: null, placeholder: ref.placeholder, index: ref.index, pageUrl: ref.url });
      }
    }
  } else {
    // Fallback: extract from first URLs in the draft (references, inline links)
    const urls = [...new Set(
      (markdown.match(/https?:\/\/[^\s"')\]>]+/g) ?? [])
        .filter(u => !u.includes("s3.web3resear.ch"))
    )].slice(0, 3);
    let idx = 1;
    for (const url of urls) {
      log(`  Fallback image extract: ${url}`);
      const extracted = await extractPageImages(url, 1).catch(() => []);
      if (extracted.length > 0) {
        images.push({ ...extracted[0], placeholder: null, index: idx++, pageUrl: url });
        log(`  Got image: ${extracted[0].src.slice(0, 80)}`);
        if (idx > 2) break; // max 2 fallback images
      }
    }
  }

  log(`Collected ${images.filter(i => i.buffer).length} image(s)`);
  return images;
}

// ── Step 5: Process images → upload → embed ───────────────────────────────────

async function processImages(markdown, pageImages, publisher) {
  log("Processing images...");
  let md = markdown;

  for (const img of pageImages) {
    if (!img?.buffer) {
      // No image found — remove the placeholder
      if (img?.placeholder) md = md.replace(img.placeholder, "");
      continue;
    }
    try {
      const ext = (img.contentType ?? "image/png").split("/")[1]?.split(";")[0] ?? "png";
      const filename = `img-${dateSlug()}-${img.index}.${ext}`;
      const s3url = await publisher.uploadImage(img.buffer, filename);
      log(`  Image ${img.index} → ${s3url}`);

      const alt = img.alt
        || (img.pageUrl ? new URL(img.pageUrl).hostname.replace(/^www\./, "") : `Image ${img.index}`);
      const imgMd = `![${alt}](${s3url})\n`;

      if (img.placeholder) {
        md = md.replace(img.placeholder, imgMd);
      } else {
        // Fallback: insert before References section, or at end
        const refIdx = md.lastIndexOf("\n## References");
        if (refIdx !== -1) {
          md = md.slice(0, refIdx) + "\n" + imgMd + md.slice(refIdx);
        } else {
          md += "\n" + imgMd;
        }
      }
    } catch (e) {
      log(`  Image upload failed: ${e.message}`);
      if (img.placeholder) md = md.replace(img.placeholder, "");
    }
  }

  // Clear any leftover placeholders
  md = md.replace(/\{\{SCREENSHOT_\d+:[^}]*\}\}/g, "");

  // Mermaid blocks are kept as-is (rendered natively by the Tiptap editor)

  return md;
}

// ── Step 6: Publish ───────────────────────────────────────────────────────────

async function publish(topic, markdown, reportsDir, publisher, lang = "en") {
  const slug = (topic.slug ?? "report")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 50);
  const reportName = `web3-${dateSlug()}-${slug}-${lang}`;

  // Save final MD to disk before publishing
  const finalPath = join(reportsDir, `${reportName}.md`);
  await writeFile(finalPath, markdown, "utf8");
  log(`Final MD (${lang}) saved → ${finalPath}`);

  log(`Publishing → ${reportName}`);
  const url = await publisher.publishReport(reportName, markdown, {
    description: `Web3 Research: ${topic.title.slice(0, 120)} — ${new Date().toISOString().slice(0, 10)}`,
  });
  return { url, reportName, finalPath };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const reportsDir = join(WORK_DIR, "reports");
  await mkdir(reportsDir, { recursive: true });

  log("=== Web3 Research Report Agent ===");
  log(`Model: ${MODEL}   Work dir: ${reportsDir}`);

  const publisher = await createClient().catch(e => { console.error("Auth:", e.message); process.exit(1); });

  try {
    // 1-2. Topics + selection (with previous topic history for deduplication)
    const topics = await getHotTopics();
    const previousReports = await publisher.listReports().catch(() => []);
    const previousTopicsText = parsePreviousTopics(previousReports);
    if (previousTopicsText) log(`Previous topics loaded (${previousReports.length} reports)`);
    const topic = await selectTopic(topics, previousTopicsText);

    // 3. Research + write EN, then translate to ZH
    const { markdown: draftEn } = await researchAndWrite(topic, reportsDir, topic.is_followup);
    const { markdown: draftZh } = await translateToZh(draftEn, reportsDir, topic.is_followup);

    // 4. Extract images from EN draft (ZH has identical placeholders, reuse same images)
    const enImages = await capturePageImages(draftEn, topic);
    const zhImages = enImages; // same URLs, no need to re-fetch

    // 5. Upload images + replace placeholders (mermaid kept as code fences)
    const finalEn = await processImages(draftEn, enImages, publisher);
    const finalZh = await processImages(draftZh, zhImages, publisher);

    // 6. Publish both
    const resEn = await publish(topic, finalEn, reportsDir, publisher, "en");
    const resZh = await publish(topic, finalZh, reportsDir, publisher, "zh");

    log("=== Done ===");
    log(`EN MD: ${resEn.finalPath}`);
    log(`ZH MD: ${resZh.finalPath}`);
    console.log(`\nEN_REPORT_URL=${resEn.url}`);
    console.log(`ZH_REPORT_URL=${resZh.url}`);
  } finally {
    await closeBrowser();
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
