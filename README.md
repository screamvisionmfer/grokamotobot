# OG Grokamoto Telegram Bot — Vercel webhook

This version is prepared for Vercel Serverless Functions and Telegram webhook mode.

## Kept commands

- `/wallet` — generates PNG from `assets/wallet_template.png` and sends caption with Price / Market Cap / Holders
- `/stats` — generates PNG from `assets/stats_template.png`
- `/mint` — mint link
- `/site` — website link
- `/links` — useful links
- `/help` — command list

`/lastmint` is also still present from the old bot, but polling, `bot.launch()`, live mint watcher loops and `setInterval` auto-posting were removed for Vercel webhook mode.

## Files that matter

- `api/telegram.js` — Telegram webhook endpoint for Vercel
- `src/bot.js` — existing bot logic, commands, PNG generation and BaseScan parsing
- `assets/wallet_template.png` — wallet template
- `assets/stats_template.png` — stats template
- `scripts/set-webhook.js` — sets Telegram webhook after deploy
- `scripts/delete-webhook.js` — removes Telegram webhook if needed

## Vercel env vars

Add these in Vercel Project Settings → Environment Variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
CONTRACT_ADDRESS=0xF9F77957152B4A26F3872e5b388c6dd8139B400c
BASE_RPC_URL=https://mainnet.base.org
COLLECTION_SUPPLY=2026
MINT_PRICE_ETH=0.00333
MINT_URL=https://grokamotos.nfts2.me
WEBSITE_URL=https://www.unofficialgrokamotos.com/
WALLET_API_URL=https://www.unofficialgrokamotos.com/api/wallet
BASESCAN_WALLET_URL=https://basescan.org/address/0xb1058c959987e3513600eb5b4fd82aeee2a0e4f9
DRB_BASESCAN_TOKEN_URL=https://basescan.org/token/0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2
DRB_DEX_URL=https://dexscreener.com/base/0x5116773e18a9c7bb03ebb961b38678e45e238923
DRB_TASK_FORCE_URL=https://drbtaskforce.com/wallet/
```

Optional:

```env
TELEGRAM_WEBHOOK_SECRET=random_long_string
WEBHOOK_URL=https://your-vercel-domain.vercel.app/api/telegram
DEPLOY_BLOCK=
STATS_BLOCK_STEP=50000
LAST_MINT_LOOKBACK_BLOCKS=500000
LAST_MINT_BLOCK_STEP=10000
```

## Deploy

```bash
npm install
vercel --prod
```

After deploy, set webhook:

```bash
WEBHOOK_URL=https://your-vercel-domain.vercel.app/api/telegram npm run set-webhook
```

If you use `TELEGRAM_WEBHOOK_SECRET`, set it locally too when running `set-webhook`, and add the same value in Vercel env vars.

## Market data source

`/wallet` caption parses the public BaseScan token page from `DRB_BASESCAN_TOKEN_URL` for:

- Price
- Market Cap
- Holders

No paid API keys are used.
