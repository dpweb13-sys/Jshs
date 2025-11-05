import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import fs from "fs";
import path from "path";
import express from "express";
import "dotenv/config";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API_URL = `https://api.maytapi.com/api/${process.env.MAYTAPI_PRODUCT_ID}/${process.env.MAYTAPI_PHONE_ID}/checkPhones`;

async function checkNumbers(numbers) {
  const chunkSize = 150;
  const results = [];

  for (let i = 0; i < numbers.length; i += chunkSize) {
    const part = numbers.slice(i, i + chunkSize);

    const res = await axios.post(
      API_URL,
      { numbers: part },
      { headers: { "x-maytapi-key": process.env.MAYTAPI_KEY } }
    );

    results.push(...res.data.data);
  }
  return results;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // ✅ User sent TXT file
  if (msg.document && msg.document.mime_type === "text/plain") {
    const file = await bot.getFile(msg.document.file_id);
    const filePath = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    bot.sendMessage(chatId, "📥 File Received\nProcessing...");

    const fileData = await axios.get(filePath);
    var numbers = fileData.data.toString().split(/\r?\n/).filter(Boolean);
  }
  else {
    // ✅ User sent normal text numbers
    const text = msg.text.trim();
    numbers = text.split(/[\s,]+/).filter(Boolean);
  }

  bot.sendMessage(chatId, `🔍 Checking ${numbers.length} numbers...\nPlease wait...`);

  try {
    const results = await checkNumbers(numbers);

    const valid = results.filter(x => x.valid).map(x => x.id._serialized);
    const invalid = results.filter(x => !x.valid).map(x => (x.id.user ?? x.id));

    // ✅ Create invalid list text file
    const fileName = `invalid_${Date.now()}.txt`;
    fs.writeFileSync(fileName, invalid.join("\n"));

    const summary = `
✅ **WhatsApp Check Summary**
━━━━━━━━━━━━━━
📌 Total Numbers: ${numbers.length}
🟢 WhatsApp Found: ${valid.length}
🔴 WhatsApp Not Found: ${invalid.length}
━━━━━━━━━━━━━━
`;

    await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });

    if (invalid.length > 0) {
      await bot.sendDocument(chatId, fileName, { caption: "📄 Numbers without WhatsApp" });
    }

    fs.unlinkSync(fileName);

  } catch (err) {
    bot.sendMessage(chatId, "❌ Error checking numbers.\nCheck API or Contact Admin");
    console.log(err.message);
  }
});

// ✅ Keep bot online (for Render / UptimeRobot)
const app = express();
app.get("/", (req, res) => res.send("Bot is Running ✅"));
app.listen(3000, () => console.log("Server running on port 3000"));
