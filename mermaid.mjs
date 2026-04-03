/**
 * mermaid.mjs — Render Mermaid diagram code → PNG buffer via Playwright
 *
 * Uses a self-contained HTML page with mermaid.js loaded from CDN.
 * Falls back gracefully if rendering fails.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const WORK_DIR = process.env.WORK_DIR ?? "/tmp/web3r-agent";

let _mermaidIdx = 0;

/**
 * Render a mermaid diagram code string to a PNG buffer.
 * @param {string} code  Mermaid diagram source (without the ```mermaid fences)
 * @returns {Promise<Buffer|null>}  PNG buffer, or null if rendering failed
 */
export async function renderMermaid(code) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });

    // Inline HTML — mermaid loaded from CDN
    // White background, generous padding, dark theme for readability
    const escapedCode = code
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #ffffff; padding: 32px; font-family: -apple-system, sans-serif; }
    .mermaid-wrap {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
      display: inline-block;
      min-width: 400px;
    }
  </style>
</head>
<body>
  <div class="mermaid-wrap">
    <div class="mermaid" id="diagram">${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  </div>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      themeVariables: {
        background: '#ffffff',
        primaryColor: '#3b82f6',
        secondaryColor: '#f3f4f6',
        tertiaryColor: '#fef3c7',
        primaryTextColor: '#1f2937',
        lineColor: '#6b7280',
      },
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });
  </script>
</body>
</html>`;

    await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for mermaid to render the SVG
    try {
      await page.waitForSelector(".mermaid svg", { timeout: 15000 });
    } catch {
      // Mermaid might have failed — return null
      console.warn("[mermaid] SVG not found, rendering may have failed");
      return null;
    }

    // Short pause for fonts / animations
    await page.waitForTimeout(500);

    const element = await page.$(".mermaid-wrap");
    if (!element) return null;

    const buffer = await element.screenshot({ type: "png" });

    await mkdir(join(WORK_DIR, "mermaid"), { recursive: true });
    const idx = ++_mermaidIdx;
    const localPath = join(WORK_DIR, "mermaid", `diagram-${idx}.png`);
    await writeFile(localPath, buffer);

    return buffer;
  } finally {
    await browser.close();
  }
}

/**
 * Extract all mermaid code blocks from a markdown string.
 * @returns {{ blocks: Array<{full:string, code:string}>, clean: string }}
 */
export function extractMermaidBlocks(markdown) {
  const regex = /```mermaid\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push({ full: match[0], code: match[1].trim() });
  }
  return blocks;
}
