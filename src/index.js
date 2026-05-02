import "dotenv/config";
import { installTelegramCommandsMenu } from "./bot.js";

console.log("This project is configured for Vercel webhook mode.");
console.log("Deploy to Vercel, then run: npm run set-webhook");

if (process.argv.includes("--commands")) {
  await installTelegramCommandsMenu();
  console.log("Telegram commands menu updated.");
}
