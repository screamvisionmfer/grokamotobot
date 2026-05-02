import "dotenv/config";
import { bot, installTelegramCommandsMenu } from "../src/bot.js";

const explicitUrl = process.env.WEBHOOK_URL;
const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/telegram` : "";
const webhookUrl = explicitUrl || vercelUrl;

if (!webhookUrl) {
  throw new Error("Set WEBHOOK_URL=https://your-vercel-domain.vercel.app/api/telegram before running this script.");
}

const options = {
  drop_pending_updates: true
};

if (process.env.TELEGRAM_WEBHOOK_SECRET) {
  options.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
}

await bot.telegram.setWebhook(webhookUrl, options);
await installTelegramCommandsMenu();

const info = await bot.telegram.getWebhookInfo();
console.log("Webhook set:", info.url);
console.log("Pending updates:", info.pending_update_count);
console.log("Commands menu updated.");
