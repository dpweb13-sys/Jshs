// bot.js
require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");

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

// UTIL: extract numeric tokens from text
function extractNumbersFromText(text) {
  if (!text) return [];
  const tokens = text.split(/[\s,;|,]+/).filter(Boolean);
  const nums = tokens
    .map(t => t.replace(/\D/g, ""))
    .filter(Boolean);
  return nums;
}

// UTIL: chunk array
function chunkArray(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) {
    res.push(arr.slice(i, i + size));
  }
  return res;
}

// Core processing function
async function processNumbersAndRespond(ctx, allNumbers) {
  try {
    // Normalize & dedupe
    const numbersRaw = allNumbers.map(n => n.replace(/\D/g, "")).filter(Boolean);
    const deduped = Array.from(new Set(numbersRaw)); // remove duplicates

    if (deduped.length === 0) {
      return ctx.reply("⚠️ কোনো নম্বর পাওয়া যায়নি। দয়া করে plain text বা .txt ফাইলে country-code সহ নম্বর দিন (তবে যদি তুমি country-code না দাও, বট যেভাবে আছে সেভাবে চেক করে)।");
    }

    if (deduped.length > MAX_INPUT_NUMBERS) {
      return ctx.reply(`⚠️ আপনি অতি বৃহৎ ইনপুট দিয়েছেন। সর্বোচ্চ ${MAX_INPUT_NUMBERS} নম্বর একবারে পাঠাতে পারবেন।`);
    }

    // Partition valid vs invalid length (we won't auto-prefix; user input 그대로 ব্যবহার)
    const validCandidates = deduped.filter(n => n.length >= 5); // keep pretty much any numeric token; but will still check with API
    const invalidCandidates = deduped.filter(n => n.length < 5);

    if (validCandidates.length === 0) {
      return ctx.reply(`⚠️ কোনো পর্যাপ্ত দৈর্ঘ্যের নম্বর পাওয়া যায়নি। মোট পাওয়া: ${deduped.length}`);
    }

    // Build batches
    const batches = chunkArray(validCandidates, BATCH_SIZE);
    const url = `https://api.maytapi.com/api/${MAYTAPI_PRODUCT_ID}/${DEVICE_ID}/checkPhones`;

    // No intermediate progress messages — do all work, then final summary & file
    let totalChecked = 0;
    let wpCount = 0;
    let nonWpCount = 0;
    const nonWpList = [];
    const errorList = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // Try up to 2 attempts with a small backoff
      let respData = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await axios.post(
            url,
            { numbers: batch },
            {
              headers: {
                accept: "application/json",
                "x-maytapi-key": MAYTAPI_KEY,
                "Content-Type": "application/json"
              },
              timeout: 60000
            }
          );
          respData = resp.data?.data || [];
          break;
        } catch (err) {
          lastErr = err;
          // small backoff before retry
          await new Promise(r => setTimeout(r, 500));
        }
      }

      if (!respData) {
        // mark as error for all in this batch
        batch.forEach(n => {
          errorList.push(n);
          nonWpList.push(`${n} (error)`);
          nonWpCount++;
          totalChecked++;
        });
      } else {
        // iterate respData aligned with batch
        for (let j = 0; j < batch.length; j++) {
          const num = batch[j];
          const r = respData[j];
          const isValid = r && (r.valid === true || r.status === "valid" || (r.status && r.status.toLowerCase() === "valid"));
          if (isValid) {
            wpCount++;
          } else {
            nonWpCount++;
            nonWpList.push(num);
          }
          totalChecked++;
        }
      }

      // rate limit pause between batches (except after last)
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }
    }

    // Build single summary message
    let summary =
      `🔔 Final Result\n\n` +
      `🔢 Total Provided: ${deduped.length}\n` +
      `🔎 Checked: ${totalChecked}\n` +
      `✅ WhatsApp Found: ${wpCount}\n` +
      `❌ WhatsApp Not Found: ${nonWpCount}\n`;

    if (invalidCandidates.length > 0) {
      summary += `\n⚠️ Ignored (very short tokens): ${invalidCandidates.length}`;
    }
    if (errorList.length > 0) {
      summary += `\n⚠️ Some batches failed and were marked as error: ${errorList.length}`;
    }

    // send summary message in chat
    await ctx.reply(summary);

    // if non-WP list exists, send as .txt file
    if (nonWpList.length > 0) {
      const fileContent = nonWpList.join("\n");
      const buffer = Buffer.from(fileContent, "utf-8");
      await ctx.replyWithDocument({ source: buffer, filename: "non_wp_numbers.txt" });
    }
  } catch (err) {
    console.error("processNumbersAndRespond error:", err?.response?.data || err?.message || err);
    await ctx.reply("⚠️ Internal error while processing numbers. Try again later.");
  }
}

// TEXT handler
bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text || "";
    if (!text) return;
    // ignore commands (besides /start)
    if (text.trim().startsWith("/")) {
      if (text.trim().startsWith("/start")) {
        return ctx.reply(
          "👋 Bot ready!\n\n" +
          "Send numbers as plain text (space/comma/newline separated) or upload a .txt file.\n" +
          "Note: bot will NOT auto-add country codes — send numbers exactly as you want them checked."
        );
      }
      return;
    }

    const extracted = extractNumbersFromText(text);
    await processNumbersAndRespond(ctx, extracted);
  } catch (err) {
    console.error("text handler error:", err);
    await ctx.reply("⚠️ Error handling message.");
  }
});

// DOCUMENT (.txt) handler
bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    if (!doc || !doc.file_name) {
      return ctx.reply("⚠️ কোনো ফাইল পাওয়া যায়নি।");
    }

    if (!doc.file_name.toLowerCase().endsWith(".txt")) {
      return ctx.reply("⚠️ শুধু .txt ফাইল আপলোড করুন (plain text)।");
    }

    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(fileLink.href, { responseType: "arraybuffer", timeout: 30000 });
    const text = res.data.toString("utf-8");
    const extracted = extractNumbersFromText(text);

    await processNumbersAndRespond(ctx, extracted);
  } catch (err) {
    console.error("document handler error:", err);
    await ctx.reply("⚠️ Error processing uploaded file. Ensure it's a plain .txt file.");
  }
});

// /start command
bot.command("start", (ctx) => {
  ctx.reply(
    "👋 Bot ready!\n\n" +
    "Send numbers as plain text (space/comma/newline separated) or upload a .txt file.\n" +
    "Note: bot will NOT auto-add country codes — send numbers exactly as you want them checked."
  );
});

// launch bot
bot.launch()
  .then(() => console.log("✅ Bot started."))
  .catch(err => {
    console.error("Bot launch error:", err);
    process.exit(1);
  });

// graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
