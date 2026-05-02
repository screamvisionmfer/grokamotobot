import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { load } from "cheerio";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const env = process.env;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLET_TEMPLATE_PATH = path.join(__dirname, "..", "assets", "wallet_template.png");
const STATS_TEMPLATE_PATH = path.join(__dirname, "..", "assets", "stats_template.png");
if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(env.BASE_RPC_URL || "https://mainnet.base.org");

const ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)"
];

const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_MINT_URL = "https://grokamotos.nfts2.me";
const DEFAULT_WEBSITE_URL = "https://www.unofficialgrokamotos.com/";
const DEFAULT_WALLET_API = "https://www.unofficialgrokamotos.com/api/wallet";
const DEFAULT_TOKEN_SIGNAL_GIF = "https://www.unofficialgrokamotos.com/effects/drb-token-signal.gif";
const DEFAULT_DRB_DEX_URL = "https://dexscreener.com/base/0x5116773e18a9c7bb03ebb961b38678e45e238923";
const DEFAULT_DRB_TOKEN_ADDRESS = "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2";
const DEFAULT_DRB_BASESCAN_TOKEN_URL = `https://basescan.org/token/${DEFAULT_DRB_TOKEN_ADDRESS}`;
const DEFAULT_BLOCKSCOUT_BASE_API = "https://base.blockscout.com/api/v2";

function getDrbTokenAddress() {
  if (env.DRB_TOKEN_ADDRESS) return env.DRB_TOKEN_ADDRESS;
  const fromBaseScan = String(env.DRB_BASESCAN_TOKEN_URL || DEFAULT_DRB_BASESCAN_TOKEN_URL).match(/0x[a-fA-F0-9]{40}/)?.[0];
  return fromBaseScan || DEFAULT_DRB_TOKEN_ADDRESS;
}

function envNum(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function ipfsCidPath(uri = "") {
  if (uri.startsWith("ipfs://ipfs/")) return uri.replace("ipfs://ipfs/", "");
  if (uri.startsWith("ipfs://")) return uri.replace("ipfs://", "");
  return "";
}

function ipfsToHttp(uri = "") {
  const cidPath = ipfsCidPath(uri);
  if (cidPath) return "https://ipfs.io/ipfs/" + cidPath;
  return uri;
}

function ipfsGatewayUrls(uri = "") {
  const cidPath = ipfsCidPath(uri);
  if (!cidPath) return [uri].filter(Boolean);
  return [
    "https://ipfs.io/ipfs/" + cidPath,
    "https://gateway.pinata.cloud/ipfs/" + cidPath,
    "https://nftstorage.link/ipfs/" + cidPath,
    "https://dweb.link/ipfs/" + cidPath,
    "https://w3s.link/ipfs/" + cidPath,
    "https://cloudflare-ipfs.com/ipfs/" + cidPath
  ];
}

function isIpfsUri(uri = "") {
  return String(uri).startsWith("ipfs://");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = envNum("HTTP_TIMEOUT_MS", 12000)) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function inferImageExt(contentType = "", url = "") {
  const type = String(contentType).toLowerCase();
  const cleanUrl = String(url).split("?")[0].toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("png")) return "png";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  const match = cleanUrl.match(/\.(png|jpe?g|gif|webp)$/i);
  if (match) return match[1].replace("jpeg", "jpg");
  return "png";
}

async function convertImageBufferToPng(buffer) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return canvas.toBuffer("image/png");
}

async function sendDownloadedImage(targetChatId, downloaded, options) {
  const ext = downloaded.ext || inferImageExt(downloaded.contentType, downloaded.url);

  if (ext === "webp") {
    try {
      const pngBuffer = await convertImageBufferToPng(downloaded.source);
      await bot.telegram.sendPhoto(targetChatId, { source: pngBuffer, filename: "grokamoto-mint.png" }, options);
      return true;
    } catch (e) {
      console.error("Mint WEBP->PNG conversion/send error:", e.message);
    }
  }

  try {
    await bot.telegram.sendPhoto(targetChatId, { source: downloaded.source, filename: `grokamoto-mint.${ext}` }, options);
    return true;
  } catch (e) {
    console.error("Mint image buffer photo send error:", e.message);
  }

  try {
    await bot.telegram.sendDocument(targetChatId, { source: downloaded.source, filename: `grokamoto-mint.${ext}` }, options);
    return true;
  } catch (e) {
    console.error("Mint image document send error:", e.message);
    return false;
  }
}

function parseDataJson(uri = "") {
  if (!uri.startsWith("data:application/json")) return null;
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  const meta = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  const text = meta.includes(";base64")
    ? Buffer.from(body, "base64").toString("utf8")
    : decodeURIComponent(body);
  return JSON.parse(text);
}

function dataImageToPhoto(uri = "") {
  if (!uri.startsWith("data:image/")) return null;
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  const meta = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (!meta.includes(";base64")) return null;
  const ext = (meta.match(/^data:image\/([^;]+)/)?.[1] || "png").replace("jpeg", "jpg");
  return { source: Buffer.from(body, "base64"), filename: `grokamoto-mint.${ext}` };
}

function escapeHtml(str = "") {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shortAddress(addr = "") {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "unknown";
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pick(obj, paths, fallback) {
  for (const path of paths) {
    let cur = obj;
    for (const p of path.split(".")) cur = cur?.[p];
    if (cur !== undefined && cur !== null) return cur;
  }
  return fallback;
}

async function fetchJson(url) {
  const dataJson = parseDataJson(url);
  if (dataJson) return dataJson;

  let lastError = null;
  for (const candidate of ipfsGatewayUrls(url)) {
    try {
      const res = await fetchWithTimeout(candidate, { headers: { "user-agent": "grokamotos-bot" } });
      if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${candidate}`);
      return res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`Fetch failed: ${url}`);
}

async function fetchBufferFromUrl(url) {
  let lastError = null;
  for (const candidate of ipfsGatewayUrls(url)) {
    try {
      console.log(`Fetching NFT image via bot: ${candidate}`);
      const res = await fetchWithTimeout(candidate, {
        headers: {
          "user-agent": "Mozilla/5.0 grokamotos-bot",
          "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
      });
      if (!res.ok) throw new Error(`Image fetch failed ${res.status}: ${candidate}`);
      const contentType = res.headers.get("content-type") || "";
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const ext = inferImageExt(contentType, candidate);
      console.log(`NFT image downloaded: ${buffer.length} bytes, type=${contentType || "unknown"}, ext=${ext}`);
      return { source: buffer, filename: `grokamoto-mint.${ext}`, contentType, ext, url: candidate };
    } catch (e) {
      lastError = e;
      console.error(`NFT image fetch failed (${candidate}):`, e.message);
    }
  }
  throw lastError || new Error(`Image fetch failed: ${url}`);
}

function traitsText(attributes = []) {
  if (!Array.isArray(attributes)) return "";
  return attributes
    .filter(a => String(a?.trait_type || "").trim().toLowerCase() !== "trait count")
    .slice(0, 12)
    .map(a => `• ${a.trait_type || "Trait"}: ${a.value}`)
    .join("\n");
}

function baseButtons(extraRows = []) {
  const rows = [
    [Markup.button.url("Mint", env.MINT_URL || DEFAULT_MINT_URL), Markup.button.url("Website", env.WEBSITE_URL || DEFAULT_WEBSITE_URL)],
    ...extraRows
  ];
  return Markup.inlineKeyboard(rows);
}

async function sendMint({ tokenId, buyer, txHash, metadata, chatId }) {
  const targetChatId = chatId || env.TELEGRAM_CHAT_ID;
  if (!targetChatId) throw new Error("TELEGRAM_CHAT_ID is missing");

  const name = metadata?.name || `Grokamoto #${tokenId}`;
  const image = metadata?.image || "";
  const traits = traitsText(metadata?.attributes);
  const caption = [
    "🟢 <b>NEW GROKAMOTO MINTED</b>",
    "",
    `<b>${escapeHtml(name)}</b>`,
    `Mint price: <b>${env.MINT_PRICE_ETH || "0.00333"} ETH</b>`,
    traits ? `\n<b>Traits:</b>\n${escapeHtml(traits)}` : "",
    "",
    "Satoshi #Grokamotos Has Money"
  ].filter(Boolean).join("\n");

  const txButton = txHash
    ? [[Markup.button.url("BaseScan Tx", `https://basescan.org/tx/${txHash}`)]]
    : [[Markup.button.url("NFT Contract", `https://basescan.org/address/${env.CONTRACT_ADDRESS}`)]];
  const options = { caption, parse_mode: "HTML", ...baseButtons(txButton) };

  const dataPhoto = dataImageToPhoto(image);
  if (dataPhoto) {
    try {
      await bot.telegram.sendPhoto(targetChatId, dataPhoto, options);
      return;
    } catch (e) {
      console.error("Mint data-image send error:", e.message);
    }
  }

  if (image && isIpfsUri(image)) {
    try {
      const downloadedPhoto = await fetchBufferFromUrl(image);
      if (await sendDownloadedImage(targetChatId, downloadedPhoto, options)) return;
    } catch (e) {
      console.error("Mint IPFS image download/send error:", e.message);
    }
  }

  if (image && !isIpfsUri(image)) {
    for (const imageUrl of ipfsGatewayUrls(image)) {
      if (!imageUrl) continue;
      try {
        await bot.telegram.sendPhoto(targetChatId, imageUrl, options);
        return;
      } catch (e) {
        console.error(`Mint image URL send error (${imageUrl}):`, e.message);
      }
    }
  }

  if (image) {
    try {
      const downloadedPhoto = await fetchBufferFromUrl(image);
      if (await sendDownloadedImage(targetChatId, downloadedPhoto, options)) return;
    } catch (e) {
      console.error("Mint image buffer send error:", e.message);
    }
  }

  await bot.telegram.sendMessage(targetChatId, caption, { parse_mode: "HTML", ...baseButtons(txButton) });
}

async function fetchTokenMetadata(contract, tokenId) {
  const tokenUri = await contract.tokenURI(tokenId);
  const metadata = await fetchJson(tokenUri);
  return { tokenUri, metadata };
}

async function processMintLog(contract, log, chatId = null) {
  const parsed = contract.interface.parseLog(log);
  const tokenId = parsed.args.tokenId.toString();
  const buyer = parsed.args.to;
  console.log(`Mint found: tokenId=${tokenId}, buyer=${buyer}, tx=${log.transactionHash}`);
  const { metadata } = await fetchTokenMetadata(contract, tokenId);
  await sendMint({ tokenId, buyer, txHash: log.transactionHash, metadata, chatId });
}

async function findLatestMintLog() {
  if (!env.CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS is missing");

  const contractAddress = ethers.getAddress(env.CONTRACT_ADDRESS);
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const zeroTopic = ethers.zeroPadValue(ZERO, 32);
  const confirmations = Math.max(0, envNum("LAST_MINT_CONFIRMATIONS", 1));
  const latest = await provider.getBlockNumber();
  const safeLatest = Math.max(0, latest - confirmations);
  const lookback = Math.max(1, envNum("LAST_MINT_LOOKBACK_BLOCKS", 500000));
  const step = Math.max(100, envNum("LAST_MINT_BLOCK_STEP", 10000));
  const fromLimit = Math.max(0, safeLatest - lookback);

  console.log(`Searching last mint from block ${safeLatest} down to ${fromLimit}`);

  for (let toBlock = safeLatest; toBlock >= fromLimit; toBlock -= step) {
    const fromBlock = Math.max(fromLimit, toBlock - step + 1);
    try {
      const logs = await provider.getLogs({
        address: contractAddress,
        fromBlock,
        toBlock,
        topics: [transferTopic, zeroTopic]
      });

      if (logs.length) {
        logs.sort((a, b) => {
          if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
          return (b.index ?? b.logIndex ?? 0) - (a.index ?? a.logIndex ?? 0);
        });
        console.log(`Last mint found in block ${logs[0].blockNumber}, tx=${logs[0].transactionHash}`);
        return logs[0];
      }
    } catch (e) {
      console.error(`Last mint scan error ${fromBlock}-${toBlock}:`, e.message);
    }
  }

  return null;
}

function normalizeWalletData(raw) {
  const wethBalance = pick(raw, ["weth.balance", "wethBalance", "weth", "balances.weth"], 0);
  const wethUsd = pick(raw, ["weth.usdValue", "wethUsdValue", "wethUsd", "usd.weth"], 0);
  const drbBalance = pick(raw, ["drb.balance", "drbBalance", "drb", "balances.drb"], 0);
  const drbUsd = pick(raw, ["drb.usdValue", "drbUsdValue", "drbUsd", "usd.drb"], 0);
  const totalUsd = pick(raw, ["totalUsdValue", "totalUsd", "total", "wallet.totalUsd"], num(wethUsd) + num(drbUsd));
  return { wethBalance: num(wethBalance), wethUsd: num(wethUsd), drbBalance: num(drbBalance), drbUsd: num(drbUsd), totalUsd: num(totalUsd) };
}

async function getWalletData() {
  const res = await fetch(env.WALLET_API_URL || DEFAULT_WALLET_API, { headers: { "user-agent": "grokamotos-bot" } });
  if (!res.ok) throw new Error(`Wallet API failed: ${res.status}`);
  return normalizeWalletData(await res.json());
}

function compactUsd(v) {
  const x = num(v);
  if (Math.abs(x) >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (Math.abs(x) >= 1_000) return `$${(x / 1_000).toFixed(2)}K`;
  return `$${x.toFixed(2)}`;
}

function compactToken(v) {
  const x = num(v);
  if (Math.abs(x) >= 1_000_000_000) return `${(x / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(x) >= 1_000_000) return `${(x / 1_000_000).toFixed(2)}M`;
  if (Math.abs(x) >= 1_000) return `${(x / 1_000).toFixed(2)}K`;
  return x.toFixed(2);
}




function writeFitted(ctx, text, box, maxSize, opts = {}) {
  const { x, y, w, h } = box;
  const value = String(text);
  let size = maxSize;
  const family = opts.font || "Arial Black, Impact, Arial";
  const weight = opts.weight || "900";
  const maxWidth = w * 0.94;

  ctx.save();
  ctx.textAlign = opts.align || "center";
  ctx.textBaseline = "middle";

  while (size > 18) {
    ctx.font = weight + " " + size + "px " + family;
    if (ctx.measureText(value).width <= maxWidth) break;
    size -= 4;
  }

  const tx = opts.align === "left" ? x : opts.align === "right" ? x + w : x + w / 2;
  const ty = y + h / 2 + (opts.offsetY || 0);

  ctx.lineWidth = opts.strokeWidth ?? Math.max(3, Math.round(size * 0.055));
  ctx.strokeStyle = opts.stroke || "rgba(0,0,0,0.92)";
  ctx.fillStyle = opts.color || "#9BFF4C";
  ctx.shadowColor = opts.shadow || "rgba(110,255,70,0.58)";
  ctx.shadowBlur = opts.blur ?? 8;

  if (ctx.lineWidth > 0) ctx.strokeText(value, tx, ty);
  ctx.fillText(value, tx, ty);
  ctx.restore();
}



const PIXEL_FONT = {
  "0": ["111","101","101","101","101","101","111"],
  "1": ["010","110","010","010","010","010","111"],
  "2": ["111","001","001","111","100","100","111"],
  "3": ["111","001","001","111","001","001","111"],
  "4": ["101","101","101","111","001","001","001"],
  "5": ["111","100","100","111","001","001","111"],
  "6": ["111","100","100","111","101","101","111"],
  "7": ["111","001","001","010","010","010","010"],
  "8": ["111","101","101","111","101","101","111"],
  "9": ["111","101","101","111","001","001","111"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01111","10000","10000","10000","10000","10000","01111"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01111","10000","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["111","010","010","010","010","010","111"],
  "J": ["00111","00010","00010","00010","10010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","11001","10101","10011","10001","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","10101","01010"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  ".": ["0","0","0","0","0","0","1"],
  ",": ["0","0","0","0","0","1","1"],
  ":": ["0","1","1","0","1","1","0"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  "-": ["0","0","0","1","0","0","0"],
  "+": ["000","010","010","111","010","010","000"],
  "%": ["10001","00010","00100","01000","10000","10001","00000"],
  "$": ["01110","10100","10100","01110","00101","00101","01110"],
  "#": ["01010","11111","01010","01010","11111","01010","01010"],
  "≈": ["0000","0101","1010","0000","0101","1010","0000"],
  " ": ["0","0","0","0","0","0","0"]
};

function pixelMeasure(text) {
  const chars = String(text).toUpperCase().split("");
  let width = 0;
  for (const ch of chars) {
    const glyph = PIXEL_FONT[ch] || PIXEL_FONT[" "];
    const glyphWidth = Math.max(...glyph.map(row => row.length));
    width += glyphWidth + 1;
  }
  return Math.max(width - 1, 1);
}

function drawPixelString(ctx, text, x, y, scale, color, alpha = 1) {
  let cx = x;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (const ch of String(text).toUpperCase()) {
    const glyph = PIXEL_FONT[ch] || PIXEL_FONT[" "];
    const glyphWidth = Math.max(...glyph.map(row => row.length));
    for (let row = 0; row < glyph.length; row++) {
      const bits = glyph[row].padEnd(glyphWidth, "0");
      for (let col = 0; col < glyphWidth; col++) {
        if (bits[col] === "1") ctx.fillRect(cx + col * scale, y + row * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }
    cx += (glyphWidth + 1) * scale;
  }
  ctx.restore();
}

function drawGlowText(ctx, text, box, size, opts = {}) {
  const { x, y, w, h } = box;
  const value = String(text ?? "").toUpperCase();
  const pxWidth = pixelMeasure(value);
  const pxHeight = 7;
  const requestedScale = Math.max(2, Math.floor(size / 7));
  const scale = Math.max(2, Math.floor(Math.min(requestedScale, (w * 0.92) / pxWidth, (h * 0.76) / pxHeight)));
  const textW = pxWidth * scale;
  const textH = pxHeight * scale;

  let tx = x + (w - textW) / 2;
  if (opts.align === "left") tx = x;
  if (opts.align === "right") tx = x + w - textW;
  const ty = y + (h - textH) / 2 + (opts.offsetY || 0);

  const color = opts.color || "#8DFF35";
  ctx.save();
  ctx.shadowColor = opts.shadow || "rgba(77,255,35,0.75)";
  ctx.shadowBlur = opts.blur ?? 14;

  const strokeColor = opts.stroke || "rgba(0,0,0,0.92)";
  const stroke = Math.max(1, Math.round(scale * 0.45));
  drawPixelString(ctx, value, tx - stroke, ty, scale, strokeColor, 0.95);
  drawPixelString(ctx, value, tx + stroke, ty, scale, strokeColor, 0.95);
  drawPixelString(ctx, value, tx, ty - stroke, scale, strokeColor, 0.95);
  drawPixelString(ctx, value, tx, ty + stroke, scale, strokeColor, 0.95);
  drawPixelString(ctx, value, tx, ty, scale, color, 1);
  ctx.restore();
}


function coverProgressBarArea(ctx) {
  // New template already has a decorative bar baked in. We cover only the inner slots
  // and redraw real segments from live WETH / DRB USD share.
  ctx.save();
  ctx.fillStyle = "rgba(2, 7, 5, 0.96)";
  ctx.fillRect(328, 682, 1142, 54);
  ctx.restore();
}

function drawDataBattleBar(ctx, x, y, w, h, pct) {
  const p = Math.max(0, Math.min(1, pct));
  const segments = 30;
  const gap = 6;
  const segW = (w - gap * (segments - 1)) / segments;
  const filled = Math.round(p * segments);

  ctx.save();
  for (let i = 0; i < segments; i++) {
    const sx = x + i * (segW + gap);
    const isWeth = i < filled;
    const grad = ctx.createLinearGradient(sx, y, sx, y + h);

    if (isWeth) {
      grad.addColorStop(0, "#8DFF35");
      grad.addColorStop(0.55, "#35D914");
      grad.addColorStop(1, "#126900");
    } else {
      grad.addColorStop(0, "#FFFFFF");
      grad.addColorStop(0.55, "#D7D7D7");
      grad.addColorStop(1, "#858585");
    }

    ctx.fillStyle = grad;
    ctx.fillRect(sx, y, segW, h);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.95)";
    ctx.strokeRect(sx, y, segW, h);
  }

  const splitX = x + w * p;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(splitX, y - 18);
  ctx.lineTo(splitX, y + h + 18);
  ctx.stroke();
  ctx.restore();
}

async function drawWalletImage(data) {
  const W = 2048;
  const H = 1152;
  const template = await loadImage(WALLET_TEMPLATE_PATH);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(template, 0, 0, W, H);

  const total = Math.max(data.wethUsd + data.drbUsd, 1);
  const wethPct = data.wethUsd / total;
  const drbPct = data.drbUsd / total;
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // Small timestamp in the free top-right space.
  drawGlowText(ctx, now, { x: 1600, y: 78, w: 350, h: 42 }, 28, {
    align: "right",
    weight: "900",
    font: "Consolas, Courier New, monospace",
    color: "#80FF4A",
    shadow: "rgba(77,255,35,0.35)",
    blur: 3,
    strokeWidth: 2
  });

  // WETH amount — strictly inside the left WETH cell.
  drawGlowText(ctx, compactToken(data.wethBalance), { x: 740, y: 315, w: 500, h: 175 }, 104, {
    color: "#8DFF35",
    blur: 10,
    strokeWidth: 5
  });

  // WETH USD row — only in the empty right part of the USD VALUE row.
  drawGlowText(ctx, "≈ " + compactUsd(data.wethUsd), { x: 922, y: 540, w: 315, h: 72 }, 38, {
    font: "Consolas, Courier New, monospace",
    color: "#D8FFD0",
    blur: 4,
    strokeWidth: 3
  });

  // WETH share — small, inside the same token cell. No progress bar.
  drawGlowText(ctx, (wethPct * 100).toFixed(1) + "%", { x: 740, y: 448, w: 500, h: 48 }, 32, {
    font: "Consolas, Courier New, monospace",
    color: "#91FF5A",
    blur: 3,
    strokeWidth: 2
  });

  // DRB amount — strictly inside the right DRB cell.
  drawGlowText(ctx, compactToken(data.drbBalance), { x: 1340, y: 315, w: 500, h: 175 }, 104, {
    color: "#8DFF35",
    blur: 10,
    strokeWidth: 5
  });

  // DRB USD row — only in the empty right part of the USD VALUE row.
  drawGlowText(ctx, "≈ " + compactUsd(data.drbUsd), { x: 1522, y: 540, w: 315, h: 72 }, 38, {
    font: "Consolas, Courier New, monospace",
    color: "#D8FFD0",
    blur: 4,
    strokeWidth: 3
  });

  // DRB share — small, inside the same token cell. No progress bar.
  drawGlowText(ctx, (drbPct * 100).toFixed(1) + "%", { x: 1340, y: 448, w: 500, h: 48 }, 32, {
    font: "Consolas, Courier New, monospace",
    color: "#91FF5A",
    blur: 3,
    strokeWidth: 2
  });

  // Total wallet value — centered inside the large bottom cell.
  drawGlowText(ctx, compactUsd(data.totalUsd), { x: 780, y: 800, w: 1030, h: 215 }, 140, {
    color: "#8DFF35",
    blur: 14,
    strokeWidth: 7
  });

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawTokenCard(ctx, x, y, w, h, label, value, usd, color) {
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, "rgba(255,255,255,0.10)");
  grad.addColorStop(1, "rgba(255,255,255,0.035)");
  ctx.fillStyle = grad;
  roundRect(ctx, x, y, w, h, 24, true, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 24, false, true);
  ctx.fillStyle = color;
  ctx.font = "bold 28px Arial";
  ctx.fillText(label, x + 34, y + 48);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 70px Arial";
  ctx.fillText(value, x + 34, y + 118);
  ctx.fillStyle = "rgba(255,255,255,0.68)";
  ctx.font = "24px Arial";
  ctx.fillText(usd, x + 38, y + 150);
}
function walletButtons() {
  const rows = [
    [
      Markup.button.url("Buy DRB", env.DRB_DEX_URL || DEFAULT_DRB_DEX_URL),
      Markup.button.url("BaseScan", env.BASESCAN_WALLET_URL || `https://basescan.org/address/${env.CONTRACT_ADDRESS || ""}`)
    ]
  ];
  return Markup.inlineKeyboard(rows);
}


function stripHtmlNoise(text = "") {
  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMoneyAfterLabel(text, label) {
  const safeLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${safeLabel}\\s*[:\\-]?\\s*(\\$\\s*[0-9][0-9,.]*(?:\\s*[KMB])?)`, "i");
  return stripHtmlNoise(text).match(re)?.[1] || null;
}

function extractNumberAfterLabel(text, label) {
  const safeLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${safeLabel}\\s*[:\\-]?\\s*([0-9][0-9,]*)`, "i");
  return stripHtmlNoise(text).match(re)?.[1] || null;
}

function extractBaseScanField(lines, label, validator = () => true) {
  const wanted = String(label).toLowerCase();
  const stopLabel = /^(max total supply|holders|transfers|market|price|onchain market cap|circulating supply market cap|fully diluted market cap|other info|contract|decimals|official site|social profiles)$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (lower === wanted || lower.startsWith(wanted + " ") || lower.startsWith(wanted + ":")) {
      const inlineValue = line.slice(label.length).replace(/^\s*:\s*/, "").trim();
      if (inlineValue && validator(inlineValue)) return inlineValue;

      for (let j = i + 1; j < Math.min(lines.length, i + 16); j++) {
        const candidate = lines[j];
        if (!candidate) continue;
        if (stopLabel.test(candidate) && candidate.toLowerCase() !== wanted) continue;
        if (validator(candidate)) return candidate;
      }
    }
  }

  return null;
}

function normalizeBaseScanPrice(value) {
  const m = stripHtmlNoise(value).match(/\$\s*[0-9][0-9,]*(?:\.[0-9]+)?(?:\s*[KMB])?/i);
  return m ? m[0].replace(/\s+/g, "") : "N/A";
}

function normalizeBaseScanMoney(value) {
  const m = stripHtmlNoise(value).match(/\$\s*[0-9][0-9,]*(?:\.[0-9]+)?(?:\s*[KMB])?/i);
  return m ? m[0].replace(/\s+/g, "") : "N/A";
}

function normalizeBaseScanHolders(value) {
  const m = stripHtmlNoise(value).match(/[0-9][0-9,]*/);
  return m ? m[0] : "N/A";
}

function formatUsdPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  let decimals = 4;
  if (n < 0.01) decimals = 6;
  if (n < 0.0001) decimals = 8;
  if (n < 0.000001) decimals = 12;

  return "$" + n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUsdMarketCap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  if (n >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2).replace(/\.00$/, "") + "B";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(2).replace(/\.00$/, "") + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function scrapeBaseScanTokenData() {
  const url = env.DRB_BASESCAN_TOKEN_URL || DEFAULT_DRB_BASESCAN_TOKEN_URL;

  const res = await fetchWithTimeout(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "pragma": "no-cache"
    }
  }, envNum("BASESCAN_TIMEOUT_MS", 12000));

  if (!res.ok) throw new Error(`BaseScan token page failed: ${res.status}`);

  const html = await res.text();
  const $ = load(html);
  const bodyText = $("body").text().replace(/\u00a0/g, " ");
  const flatText = stripHtmlNoise(bodyText);
  const lines = bodyText
    .split(/\n+/)
    .map(v => v.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const priceRaw =
    extractMoneyAfterLabel(flatText, "Price") ||
    extractBaseScanField(lines, "Price", v => /\$\s*[0-9]/.test(v));

  const holdersRaw =
    flatText.match(/Holders\s+([0-9][0-9,]*)\s*\(/i)?.[1] ||
    extractNumberAfterLabel(flatText, "Holders") ||
    extractBaseScanField(lines, "Holders", v => /^[0-9][0-9,]*(?:\s|\(|$)/.test(v));

  const marketCapRaw =
    extractMoneyAfterLabel(flatText, "Onchain Market Cap") ||
    extractMoneyAfterLabel(flatText, "Circulating Supply Market Cap") ||
    extractMoneyAfterLabel(flatText, "Fully Diluted Market Cap") ||
    extractBaseScanField(lines, "Onchain Market Cap", v => /\$\s*[0-9]/.test(v)) ||
    extractBaseScanField(lines, "Circulating Supply Market Cap", v => /\$\s*[0-9]/.test(v)) ||
    extractBaseScanField(lines, "Fully Diluted Market Cap", v => /\$\s*[0-9]/.test(v));

  return {
    priceUsd: normalizeBaseScanPrice(priceRaw),
    marketCap: normalizeBaseScanMoney(marketCapRaw),
    holders: normalizeBaseScanHolders(holdersRaw)
  };
}

async function getDexScreenerTokenData() {
  const token = getDrbTokenAddress();
  const url = env.DEXSCREENER_TOKEN_API || `https://api.dexscreener.com/latest/dex/tokens/${token}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "user-agent": "Mozilla/5.0 grokamotos-bot",
      "accept": "application/json"
    }
  }, envNum("DEX_TIMEOUT_MS", 10000));
  if (!res.ok) throw new Error(`DexScreener token API failed: ${res.status}`);

  const json = await res.json();
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  const basePairs = pairs.filter(p => String(p?.chainId || "").toLowerCase() === "base");
  const candidates = basePairs.length ? basePairs : pairs;
  const best = candidates.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];

  return {
    priceUsd: formatUsdPrice(best?.priceUsd),
    marketCap: formatUsdMarketCap(best?.marketCap || best?.fdv),
    holders: "N/A"
  };
}

function formatInteger(value) {
  const raw = String(value ?? "").replace(/[^0-9]/g, "");
  if (!raw) return "N/A";
  const n = Number(raw);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function getBlockScoutTokenData() {
  const token = getDrbTokenAddress();
  const base = String(env.BLOCKSCOUT_BASE_API || DEFAULT_BLOCKSCOUT_BASE_API).replace(/\/+$/, "");
  const url = env.BLOCKSCOUT_TOKEN_INFO_URL || `${base}/tokens/${token}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      "user-agent": "Mozilla/5.0 grokamotos-bot",
      "accept": "application/json"
    }
  }, envNum("BLOCKSCOUT_TIMEOUT_MS", 10000));

  if (!res.ok) throw new Error(`Blockscout token info failed: ${res.status}`);
  const json = await res.json();

  return {
    priceUsd: formatUsdPrice(json?.exchange_rate),
    marketCap: formatUsdMarketCap(json?.circulating_market_cap),
    holders: formatInteger(json?.holders_count)
  };
}

async function getDrbMarketData() {
  let baseScan = { priceUsd: "N/A", marketCap: "N/A", holders: "N/A" };
  let dex = { priceUsd: "N/A", marketCap: "N/A", holders: "N/A" };
  let blockScout = { priceUsd: "N/A", marketCap: "N/A", holders: "N/A" };

  try {
    baseScan = await scrapeBaseScanTokenData();
  } catch (e) {
    console.error("BaseScan token scrape error:", e.message);
  }

  if (baseScan.priceUsd === "N/A" || baseScan.marketCap === "N/A") {
    try {
      dex = await getDexScreenerTokenData();
    } catch (e) {
      console.error("DexScreener fallback error:", e.message);
    }
  }

  if (baseScan.holders === "N/A" || (baseScan.priceUsd === "N/A" && dex.priceUsd === "N/A") || (baseScan.marketCap === "N/A" && dex.marketCap === "N/A")) {
    try {
      blockScout = await getBlockScoutTokenData();
    } catch (e) {
      console.error("Blockscout fallback error:", e.message);
    }
  }

  return {
    priceUsd: baseScan.priceUsd !== "N/A" ? baseScan.priceUsd : (dex.priceUsd !== "N/A" ? dex.priceUsd : blockScout.priceUsd),
    marketCap: baseScan.marketCap !== "N/A" ? baseScan.marketCap : (dex.marketCap !== "N/A" ? dex.marketCap : blockScout.marketCap),
    holders: baseScan.holders !== "N/A" ? baseScan.holders : blockScout.holders
  };
}


function walletCaption(market) {
  return [
    "📡 <b>GROK'S FEE WALLET</b>",
    "",
    `💵 <b>Price:</b> <code>${escapeHtml(market.priceUsd)}</code>`,
    `📊 <b>Market Cap:</b> <code>${escapeHtml(market.marketCap)}</code>`,
    `👥 <b>Holders:</b> <code>${escapeHtml(market.holders)}</code>`,
    "",
    "Satoshi #Grokamotos Has Money"
  ].join("\n");
}

async function sendWalletSignal(ctxOrChatId) {
  const data = await getWalletData();
  const image = await drawWalletImage(data);
  const market = await getDrbMarketData();
  const caption = walletCaption(market);
  const options = { caption, parse_mode: "HTML", ...walletButtons() };
  if (typeof ctxOrChatId === "string") return bot.telegram.sendPhoto(ctxOrChatId, { source: image, filename: "grok-wallet-signal.png" }, options);
  return ctxOrChatId.replyWithPhoto({ source: image, filename: "grok-wallet-signal.png" }, options);
}

async function getMintStats() {
  if (!env.CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS is missing");
  const contract = new ethers.Contract(env.CONTRACT_ADDRESS, ERC721_ABI, provider);
  let minted = null;
  try {
    minted = Number(await contract.totalSupply());
  } catch {
    // fallback: count mint logs. For old contracts this can be slow on public RPC.
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const zeroTopic = ethers.zeroPadValue(ZERO, 32);
    const fromBlock = env.DEPLOY_BLOCK ? Number(env.DEPLOY_BLOCK) : 0;
    const latest = await provider.getBlockNumber();
    let count = 0;
    const step = Number(env.STATS_BLOCK_STEP || 50000);
    for (let start = fromBlock; start <= latest; start += step) {
      const end = Math.min(start + step - 1, latest);
      const logs = await provider.getLogs({ address: env.CONTRACT_ADDRESS, fromBlock: start, toBlock: end, topics: [transferTopic, zeroTopic] });
      count += logs.length;
    }
    minted = count;
  }
  const supply = Number(env.COLLECTION_SUPPLY || 2026);
  const left = Math.max(supply - minted, 0);
  const pct = supply > 0 ? ((minted / supply) * 100).toFixed(2) : "0.00";
  return { minted, supply, left, pct };
}


async function drawStatsImage(stats) {
  const W = 2048;
  const H = 1366;
  const template = await loadImage(STATS_TEMPLATE_PATH);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(template, 0, 0, W, H);

  const valueStyle = {
    font: "Consolas, Courier New, monospace",
    color: "#B9FF76",
    shadow: "rgba(100,255,45,0.65)",
    blur: 8,
    strokeWidth: 4,
    weight: "900"
  };

  // Exact right dashed value cells in the 2048×1366 stats template.
  drawGlowText(ctx, String(stats.minted), { x: 1586, y: 292, w: 330, h: 120 }, 76, valueStyle);
  drawGlowText(ctx, String(stats.left), { x: 1586, y: 526, w: 330, h: 120 }, 76, valueStyle);
  drawGlowText(ctx, String(stats.supply), { x: 1586, y: 760, w: 330, h: 120 }, 76, valueStyle);
  drawGlowText(ctx, String(stats.pct) + "%", { x: 1586, y: 996, w: 330, h: 120 }, 66, valueStyle);

  return canvas.toBuffer("image/png");
}

async function sendStatsSignal(ctxOrChatId) {
  const s = await getMintStats();
  const image = await drawStatsImage(s);
  const caption = [
    "📊 <b>GROKAMOTOS MINT STATS</b>",
    "",
    `<b>Minted:</b> <code>${s.minted}</code>`,
    `<b>Remaining:</b> <code>${s.left}</code>`,
    `<b>Total supply:</b> <code>${s.supply}</code>`,
    `<b>Progress:</b> <code>${s.pct}%</code>`,
    "",
    "Satoshi #Grokamotos Has Money"
  ].join("\n");

  const photo = { source: image, filename: "grokamotos-mint-stats.png" };
  const options = { caption, parse_mode: "HTML", ...baseButtons() };
  if (typeof ctxOrChatId === "string") return bot.telegram.sendPhoto(ctxOrChatId, photo, options);
  return ctxOrChatId.replyWithPhoto(photo, options);
}

bot.start(ctx => ctx.reply("Grokamotos bot online. Commands: /wallet /stats /mint /site /links /help"));

bot.help(ctx => ctx.reply([
  "OG Grokamoto commands:",
  "/wallet — wallet dashboard card",
  "/stats — minted / supply stats",
  "/lastmint — latest minted Grokamoto",
  "/mint — mint link",
  "/site — project website",
  "/links — useful links",
  "/help — command list"
].join("\n")));

bot.command("wallet", async (ctx) => {
  try {
    const waitMsg = await ctx.reply("Generating DRB wallet signal...");
    await sendWalletSignal(ctx);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  } catch (e) {
    console.error("/wallet error:", e);
    await ctx.reply(`Wallet command error: ${e.message}`);
  }
});

bot.command("mint", async (ctx) => {
  await ctx.reply("Mint Unofficial Grokamotos on Base:", baseButtons());
});

bot.command("site", async (ctx) => {
  await ctx.reply("Unofficial Grokamotos website:", Markup.inlineKeyboard([[Markup.button.url("Open Website", env.WEBSITE_URL || DEFAULT_WEBSITE_URL)]]));
});

bot.command("links", async (ctx) => {
  const rows = [
    [Markup.button.url("Mint", env.MINT_URL || DEFAULT_MINT_URL), Markup.button.url("Website", env.WEBSITE_URL || DEFAULT_WEBSITE_URL)],
    [Markup.button.url("DRB Task Force", env.DRB_TASK_FORCE_URL || "https://drbtaskforce.com/wallet/")]
  ];
  if (env.BASESCAN_WALLET_URL) rows.push([Markup.button.url("BaseScan Wallet", env.BASESCAN_WALLET_URL)]);
  await ctx.reply("Useful Grokamotos / $DRB links:", Markup.inlineKeyboard(rows));
});

bot.command("stats", async (ctx) => {
  try {
    const waitMsg = await ctx.reply("Calculating Grokamotos mint stats...");
    await sendStatsSignal(ctx);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  } catch (e) {
    console.error("/stats error:", e);
    await ctx.reply(`Stats command error: ${e.message}\n\nIf totalSupply is not available, add DEPLOY_BLOCK to .env to scan mint logs faster.`);
  }
});

bot.command("lastmint", async (ctx) => {
  try {
    const waitMsg = await ctx.reply("Searching latest Grokamoto mint...");
    const latestLog = await findLatestMintLog();

    if (!latestLog) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      await ctx.reply("No recent mint found. Increase LAST_MINT_LOOKBACK_BLOCKS in .env if needed.");
      return;
    }

    const contract = new ethers.Contract(ethers.getAddress(env.CONTRACT_ADDRESS), ERC721_ABI, provider);
    await processMintLog(contract, latestLog, ctx.chat.id);
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  } catch (e) {
    console.error("/lastmint error:", e);
    await ctx.reply(`Last mint command error: ${e.message}`);
  }
});



function telegramCommandsMenu() {
  return [
    { command: "wallet", description: "Wallet dashboard card" },
    { command: "stats", description: "Minted / supply stats" },
    { command: "mint", description: "Mint link" },
    { command: "site", description: "Project website" },
    { command: "links", description: "Useful links" },
    { command: "help", description: "Command list" }
  ];
}

export async function installTelegramCommandsMenu() {
  await bot.telegram.setMyCommands(telegramCommandsMenu());
}

export { bot, sendWalletSignal, sendStatsSignal, getDrbMarketData, scrapeBaseScanTokenData, getBlockScoutTokenData };
export default bot;
