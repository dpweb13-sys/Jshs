require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAYTAPI_PRODUCT_ID = process.env.MAYTAPI_PRODUCT_ID;
const DEVICE_ID = process.env.DEVICE_ID;
const MAYTAPI_KEY = process.env.MAYTAPI_KEY;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "150", 10);
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || "1000", 10);
const MAX_INPUT_NUMBERS = parseInt(process.env.MAX_INPUT_NUMBERS || "2000", 10);

// ====== VALIDATE ======
if (!BOT_TOKEN || !MAYTAPI_PRODUCT_ID || !DEVICE_ID || !MAYTAPI_KEY) {
  console.error("❌ Missing environment variables (.env)।");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Extract numbers
function extractNumbers(text) {
  return text
    .split(/[\s,\n;|]+/)
    .map(n => n.replace(/\D/g, ""))
    .filter(n => n.length > 0);
}

// Chunk array
function chunk(arr, size) {
  let out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function processNumbers(ctx, allNumbers) {
  try {
    const numbers = Array.from(new Set(allNumbers.map(n => n.trim()).filter(Boolean)));
    if (!numbers.length) return ctx.reply("⚠️ কোনো নম্বর পাওয়া যায়নি।");

    if (numbers.length > MAX_INPUT_NUMBERS)
      return ctx.reply(`⚠️ একবারে সর্বোচ্চ ${MAX_INPUT_NUMBERS} নম্বর চেক করা যাবে।`);

    const batches = chunk(numbers, BATCH_SIZE);
    const url = `https://api.maytapi.com/api/${MAYTAPI_PRODUCT_ID}/${DEVICE_ID}/checkPhones`;

    let wpFound = 0;
    let wpNotFound = [];
    let checked = 0;

    for (let batch of batches) {
      let resp;
      try {
        resp = await axios.post(
          url,
          { numbers: batch },
          {
            headers: {
              accept: "application/json",
              "x-maytapi-key": MAYTAPI_KEY,
              "Content-Type": "application/json"
            },
            timeout: 45000
          }
        );
      } catch {
        batch.forEach(n => wpNotFound.push(n)); 
        continue;
      }

      resp.data.data.forEach((r, i) => {
        const num = batch[i];
        if (r.valid === true || r.status === "valid") wpFound++;
        else wpNotFound.push(num);
        checked++;
      });

      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    const summary =
      `✅ *Result Completed*\n\n` +
      `🔢 Total Input: *${numbers.length}*\n` +
      `🔎 Checked: *${checked}*\n` +
      `✅ WhatsApp Found: *${wpFound}*\n` +
      `❌ Not Found: *${wpNotFound.length}*\n`;

    await ctx.reply(summary, { parse_mode: "Markdown" });

    if (wpNotFound.length) {
      const content = wpNotFound.join("\n");
      await ctx.replyWithDocument({ source: Buffer.from(content), filename: "not_found.txt" });
    }

  } catch (e) {
    console.error(e);
    ctx.reply("⚠️ Error occurred. Try again later.");
  }
}

// Text messages
bot.on("text", async (ctx) => {
  const nums = extractNumbers(ctx.message.text);
  await processNumbers(ctx, nums);
});

// TXT file support
bot.on("document", async (ctx) => {
  const file = ctx.message.document;
  if (!file.file_name.endsWith(".txt"))
    return ctx.reply("⚠️ শুধু `.txt` ফাইল পাঠান।");

  const link = await ctx.telegram.getFileLink(file.file_id);
  const res = await axios.get(link.href);
  const nums = extractNumbers(res.data);
  await processNumbers(ctx, nums);
});

// /start
bot.start((ctx) =>
  ctx.reply("👋 Bot is Ready.\n\nSimply send numbers OR upload .txt file.\nBot will check WhatsApp availability.\nNo country code auto-add.\nNumbers → যেভাবে পাঠাবে ঠিক সেভাবেই চেক হবে ✅")
);

// Launch bot
bot.launch();
console.log("✅ Bot Started");

// ====== Render Keep Alive ======
const app = express();
app.get("/", (req, res) => res.send("Bot Running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌍 Uptime server active"));
