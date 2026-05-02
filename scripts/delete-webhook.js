import "dotenv/config";
import { bot } from "../src/bot.js";

await bot.telegram.deleteWebhook({ drop_pending_updates: true });
console.log("Webhook deleted.");
