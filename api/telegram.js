import bot from "../src/bot.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Grokamotos Telegram webhook is online.");
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const actualSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (actualSecret !== expectedSecret) {
      return res.status(401).send("Unauthorized");
    }
  }

  try {
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!update || typeof update !== "object") {
      return res.status(400).send("Bad Request");
    }

    await bot.handleUpdate(update);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Telegram webhook error:", error);
    // Telegram will retry non-2xx responses. Return 200 so one broken update
    // does not create an infinite retry loop.
    return res.status(200).send("OK");
  }
}
