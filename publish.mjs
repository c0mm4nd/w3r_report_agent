/**
 * publish.mjs — Web3Research API client
 *
 * Handles SIWE authentication, image upload, and report publish/update.
 *
 * Usage:
 *   const client = await createClient();
 *   const imageUrl = await client.uploadImage(buffer, "chart.png");
 *   await client.publishReport("report-name", markdownContent);
 */

import { Wallet } from "ethers";
import { SiweMessage } from "siwe";

const BASE_URL = process.env.BASE_URL ?? "https://web3resear.ch";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "1");

// ── Auth ───────────────────────────────────────────────────────────────────────

async function siweAuth(privateKey) {
  const wallet = new Wallet(privateKey);
  const address = wallet.address;

  // 1. Get nonce
  const nonceRes = await fetch(`${BASE_URL}/api/auth/siwe/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: address, chainId: CHAIN_ID }),
  });
  if (!nonceRes.ok) throw new Error(`Nonce failed: ${await nonceRes.text()}`);
  const { nonce } = await nonceRes.json();

  // 2. Sign
  const msg = new SiweMessage({
    domain: new URL(BASE_URL).host,
    address,
    statement: "Sign in Web3Research",
    uri: BASE_URL,
    version: "1",
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
  });
  const prepared = msg.prepareMessage();
  const signature = await wallet.signMessage(prepared);

  // 3. Verify
  const verifyRes = await fetch(`${BASE_URL}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: prepared, signature, walletAddress: address, chainId: CHAIN_ID }),
  });
  if (!verifyRes.ok) throw new Error(`SIWE verify failed: ${await verifyRes.text()}`);

  const setCookie = verifyRes.headers.get("set-cookie") ?? "";
  const cookieMatch = setCookie.match(/((?:__Secure-)?better-auth\.session_token=[^;]+)/);
  if (!cookieMatch) throw new Error("No session token in response:\n" + setCookie);

  return { cookie: cookieMatch[1], address };
}

// ── Client factory ─────────────────────────────────────────────────────────────

export async function createClient() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY env var is required");

  const { cookie, address } = await siweAuth(privateKey);
  console.log(`[publish] Authenticated as ${address}`);

  async function api(path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${path} → ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  // ── Image upload ─────────────────────────────────────────────────────────────

  async function uploadImage(buffer, filename = "image.png") {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
    const contentType = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    }[ext] ?? "image/png";

    // Get presigned URL
    const { url: uploadUrl, key } = await api("/api/s3/upload", { filename, contentType });

    // Upload — presigned URL expires in 60s, do it immediately
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buffer,
    });
    if (!putRes.ok) throw new Error(`S3 PUT failed: ${putRes.status}`);

    return `https://s3.web3resear.ch/${key}`;
  }

  // ── Report publish ───────────────────────────────────────────────────────────

  async function publishReport(name, markdownContent, metaOverrides = {}) {
    // Extract first H1 heading from markdown for use as display title
    const h1Match = markdownContent.match(/^#\s+(.+)$/m);
    const h1Title = h1Match ? h1Match[1].trim() : null;
    // Delete existing report with same name (idempotent daily run)
    const existing = await fetch(`${BASE_URL}/api/${address}/reports/${name}`);
    if (existing.ok) {
      const { id: existingId } = await existing.json();
      await api("/api/reports/delete", { reportId: existingId }).catch((e) =>
        console.warn(`[publish] Delete warning: ${e.message}`)
      );
      console.log(`[publish] Deleted existing report "${name}"`);
    }

    // Create
    const report = await api("/api/reports/create", { name });
    console.log(`[publish] Created report id=${report.id}`);

    // Save content (server auto-converts Markdown → Tiptap)
    await api("/api/reports/version/create", { reportId: report.id, content: markdownContent });
    console.log("[publish] Content saved");

    // Make public + set OG meta
    const defaultMeta = {
      description: `Daily Web3 research report — ${new Date().toISOString().slice(0, 10)}`,
      ...(h1Title ? { ogTitle: h1Title, title: h1Title } : {}),
    };
    await api("/api/reports/update", {
      id: report.id,
      updated: { public: true, meta: { ...defaultMeta, ...metaOverrides } },
    });
    console.log("[publish] Report set to public");

    return `${BASE_URL}/${address}/reports/${name}`;
  }

  // ── List previous reports ────────────────────────────────────────────────────

  async function listReports() {
    const res = await fetch(`${BASE_URL}/api/${address}/reports`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) return [];
    const reports = await res.json();
    return Array.isArray(reports) ? reports : [];
  }

  return { uploadImage, publishReport, listReports, address, api };
}
