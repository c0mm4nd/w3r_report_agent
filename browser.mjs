/**
 * browser.mjs — Playwright-based browser tools for the research agent
 *
 * Exports:
 *   fetchHotTopics()          Fetch hot topics from ai.6551.io
 *   searchWeb(query)          DuckDuckGo or Brave search → text results
 *   fetchPage(url)            Fetch & extract text content from URL
 *   takeScreenshot(url, desc) Screenshot a page → { localPath, buffer }
 *   closeBrowser()            Teardown shared browser instance
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const WORK_DIR = process.env.WORK_DIR ?? "/tmp/web3r-agent";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY ?? "";

// Shared browser instance (lazy init)
let _browser = null;
let _screenshotIdx = 0;

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return _browser;
}

async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Realistic user agent
  await page.setExtraHTTPHeaders({
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  return page;
}

// ── Hot Topics ─────────────────────────────────────────────────────────────────

export async function fetchHotTopics() {
  const res = await fetch("https://ai.6551.io/open/free_hot?category=web3", {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Hot topics fetch failed: ${res.status}`);
  const json = await res.json();

  // Response shape: { news: { items: [...] } }
  // Each item: { title, summary_en, summary_zh, link, score, grade, coins, ... }
  const raw = Array.isArray(json)
    ? json
    : (json.news?.items ?? json.data ?? json.list ?? json.items ?? json.result ?? []);

  return raw.slice(0, 30).map((item, i) => ({
    rank: i + 1,
    // title field can be very long (full tweet text) — use summary_en as the clean title
    title: (item.summary_en ?? item.summary_zh ?? item.title ?? "").slice(0, 200),
    description: item.summary_zh ?? item.summary_en ?? "",
    url: item.link ?? item.url ?? item.href ?? item.source ?? "",
    hot: Number(item.score ?? item.hot ?? item.heat ?? 0),
    grade: item.grade ?? "",
    coins: (item.coins ?? []).join(", "),
  }));
}

// ── Web Search ─────────────────────────────────────────────────────────────────

export async function searchWeb(query) {
  if (BRAVE_API_KEY) {
    return braveSearch(query);
  }
  return duckDuckGoSearch(query);
}

async function braveSearch(query) {
  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return duckDuckGoSearch(query); // Fallback

  const data = await res.json();
  const results = data.web?.results ?? [];
  return results
    .map(r => `**${r.title}**\n${r.url}\n${r.description ?? ""}`)
    .join("\n\n---\n\n");
}

async function duckDuckGoSearch(query) {
  const page = await newPage();
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );

    const results = await page.$$eval(".result", (els) =>
      els.slice(0, 8).map((el) => ({
        title: el.querySelector(".result__title a")?.textContent?.trim() ?? "",
        url:
          el.querySelector(".result__url")?.textContent?.trim() ??
          el.querySelector(".result__title a")?.href ?? "",
        snippet: el.querySelector(".result__snippet")?.textContent?.trim() ?? "",
      }))
    );

    if (results.length === 0) return `No results found for: ${query}`;
    return results
      .filter((r) => r.title)
      .map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`)
      .join("\n\n---\n\n");
  } catch (e) {
    return `Search error: ${e.message}`;
  } finally {
    await page.close();
  }
}

// ── Page Fetch ─────────────────────────────────────────────────────────────────

export async function fetchPage(url) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    // Remove noise
    await page.$$eval(
      "script, style, noscript, nav, footer, header, .cookie-banner, .ad, iframe",
      (els) => els.forEach((el) => el.remove())
    );

    const title = await page.title().catch(() => "");
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const clean = text.replace(/\n{3,}/g, "\n\n").trim();

    // Truncate to 8 000 chars to stay within token budget
    const truncated = clean.length > 8000 ? clean.slice(0, 8000) + "\n...[truncated]" : clean;

    return `# ${title}\nURL: ${url}\n\n${truncated}`;
  } catch (e) {
    return `Error fetching ${url}: ${e.message}`;
  } finally {
    await page.close();
  }
}

// ── Page Image Extraction ──────────────────────────────────────────────────────

/**
 * Extract real images from a web page (og:image, article images, project logos).
 * Returns up to `maxImages` results: [ { src, alt, buffer, contentType } ]
 */
export async function extractPageImages(url, maxImages = 2) {
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    const candidates = await page.evaluate(() => {
      const imgs = [];

      // 1. OG / Twitter card image — highest priority (article thumbnail / project logo)
      const ogSrc =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        document.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
        document.querySelector('meta[name="twitter:image:src"]')?.getAttribute("content");
      if (ogSrc) imgs.push({ src: ogSrc, alt: document.title || "", priority: 10 });

      // 2. Prominent <img> inside article / main content (skip icons & avatars)
      const selectors = ["article img", "main img", ".post-content img", ".article-body img", ".content img", "img"];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const src = el.src || el.dataset.src || el.getAttribute("data-lazy-src") || "";
          if (!src || src.startsWith("data:")) continue;
          const w = el.naturalWidth || el.width || parseInt(el.getAttribute("width") || "0");
          const h = el.naturalHeight || el.height || parseInt(el.getAttribute("height") || "0");
          if ((w > 0 && w < 100) || (h > 0 && h < 100)) continue; // skip tiny icons
          if (src.match(/avatar|icon|logo.*\d{2,3}x\d{2,3}|emoji|spinner|placeholder/i)) continue;
          imgs.push({ src, alt: el.alt || el.title || "", priority: 1 });
        }
        if (imgs.length >= 6) break;
      }
      return imgs;
    });

    // Deduplicate
    const seen = new Set();
    const unique = candidates.filter((c) => {
      if (!c.src || seen.has(c.src)) return false;
      seen.add(c.src);
      return true;
    });
    unique.sort((a, b) => b.priority - a.priority);

    const results = [];
    for (const candidate of unique.slice(0, maxImages * 3)) {
      if (results.length >= maxImages) break;
      try {
        const absUrl = new URL(candidate.src, url).href;
        const response = await page.request.get(absUrl, { timeout: 12000 });
        if (!response.ok()) continue;
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.startsWith("image/")) continue;
        const buffer = await response.body();
        if (buffer.length < 2000) continue; // skip tracking pixels / tiny icons
        results.push({ src: absUrl, alt: candidate.alt, buffer, contentType: ct });
      } catch {
        // skip failed downloads silently
      }
    }

    return results;
  } catch (e) {
    return [];
  } finally {
    await page.close();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
