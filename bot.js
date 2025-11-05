// bot.js
require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");

// ✅ ADD FOR UPTIME ROBOT
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is Running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌍 Uptime Server Active"));

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAYTAPI_PRODUCT_ID = process.env.MAYTAPI_PRODUCT_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const MAYTAPI_KEY = process.env.MAYTAPI_KEY;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "150", 10);
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "1000", 10);
const MAX_INPUT_NUMBERS = parseInt(process.env.MAX_INPUT_NUMBERS || "2000", 10);

if (!BOT_TOKEN || !MAYTAPI_PRODUCT_ID || !DEVICE_ID || !MAYTAPI_KEY) {
  console.error("Missing required env vars. Fill .env from .env.example.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// UTIL: extract numeric tokens
function extractNumbersFromText(text) {
  if (!text) return [];
  const tokens = text.split(/[\s,;|,]+/).filter(Boolean);
  const nums = tokens.map(t => t.replace(/\D/g, "")).filter(Boolean);
  return nums;
}

// UTIL: chunk array
function chunkArray(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// MAIN PROCESS
async function processNumbersAndRespond(ctx, allNumbers) {
  try {
    const numbersRaw = allNumbers.map(n => n.replace(/\D/g, "")).filter(Boolean);
    const deduped = Array.from(new Set(numbersRaw));

    if (deduped.length === 0) return ctx.reply("⚠️ কোনো নম্বর পাওয়া যায়নি।");

    if (deduped.length > MAX_INPUT_NUMBERS)
      return ctx.reply(`⚠️ সর্বোচ্চ ${MAX_INPUT_NUMBERS} নম্বর পাঠানো যাবে।`);

    const validCandidates = deduped.filter(n => n.length >= 5);
    const invalidCandidates = deduped.filter(n => n.length < 5);

    const batches = chunkArray(validCandidates, BATCH_SIZE);
    const url = `https://api.maytapi.com/api/${MAYTAPI_PRODUCT_ID}/${DEVICE_ID}/checkPhones`;

    let totalChecked = 0, wpCount = 0, nonWpCount = 0;
    const nonWpList = [], errorList = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      let respData = null, lastErr = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await axios.post(url, { numbers: batch }, {
            headers: {
              accept: "application/json",
              "x-maytapi-key": MAYTAPI_KEY,
              "Content-Type": "application/json"
            },
            timeout: 60000
          });
          respData = resp.data?.data || [];
          break;
        } catch (err) {
          lastErr = err;
          await new Promise(r => setTimeout(r, 500));
        }
      }

      if (!respData) {
        batch.forEach(n => { errorList.push(n); nonWpList.push(`${n} (error)`); nonWpCount++; totalChecked++; });
      } else {
        for (let j = 0; j < batch.length; j++) {
          const num = batch[j];
          const r = respData[j];
          const isValid = r && (r.valid === true || r.status?.toLowerCase() === "valid");
          if (isValid) wpCount++; else { nonWpCount++; nonWpList.push(num); }
          totalChecked++;
        }
      }

      if (i < batches.length - 1) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    let summary =
      `🔔 Final Result\n\n` +
      `🔢 Total Provided: ${deduped.length}\n` +
      `🔎 Checked: ${totalChecked}\n` +
      `✅ WhatsApp Found: ${wpCount}\n` +
      `❌ Not on WhatsApp: ${nonWpCount}\n`;

    if (invalidCandidates.length) summary += `\n⚠️ Ignored (short): ${invalidCandidates.length}`;
    if (errorList.length) summary += `\n⚠️ Errors: ${errorList.length}`;

    await ctx.reply(summary);

    if (nonWpList.length) {
      const buffer = Buffer.from(nonWpList.join("\n"), "utf-8");
      await ctx.replyWithDocument({ source: buffer, filename: "non_wp_numbers.txt" });
    }
  } catch (err) {
    console.error("Error:", err);
    await ctx.reply("⚠️ Internal error.");
  }
}

// TEXT input
bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/start"))
    return ctx.reply("👋 Send numbers or .txt file.\nCountry code auto add হবে না।");

  const extracted = extractNumbersFromText(text);
  await processNumbersAndRespond(ctx, extracted);
});

// TXT file
bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    if (!doc.file_name.endsWith(".txt")) return ctx.reply("⚠️ Only .txt allowed.");

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(fileLink.href, { responseType: "arraybuffer" });
    const text = res.data.toString("utf-8");
    const extracted = extractNumbersFromText(text);

    await processNumbersAndRespond(ctx, extracted);
  } catch (err) {
    console.error("File Error:", err);
    ctx.reply("⚠️ File processing error.");
  }
});

// Start Bot
bot.launch()
  .then(() => console.log("✅ Bot Started"))
  .catch(err => console.error("Bot Launch Error:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
