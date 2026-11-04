# IR item Request (Telegram + Cloudflare Workers + D1)

This project runs the **IR item Request** Telegram bot. Set the bot's display name to `IR item Request` with **@BotFather** (`/setname`). The bot username is configured separately with `/setusername` and must be unique.

## Deploy (10 minutes)

1. In **@BotFather**, create the bot (or rotate the token if it has been shared), set its display name to `IR item Request`, and copy its current token.
2. Get the admin's numeric Telegram ID and replace `REPLACE_WITH_ADMIN_TELEGRAM_ID` in `wrangler.toml`. For multiple admins, separate IDs with commas.
3. Install Wrangler if needed, log in, and create the D1 database:
   ```
   npm install -g wrangler
   wrangler login
   wrangler d1 create item-bot-db          # copy the database_id into wrangler.toml
   ```
   Replace `PASTE_YOUR_D1_ID_HERE` in `wrangler.toml` with the returned ID. Then run:
   ```
   wrangler d1 execute item-bot-db --remote --file=schema.sql
   wrangler secret put BOT_TOKEN           # paste the current BotFather token when prompted
   wrangler secret put WEBHOOK_SECRET      # use a random value, at least 32 letters/digits/_/-
   wrangler deploy
   ```
4. Register the Telegram webhook once. Open `https://ir-item-request.<your-subdomain>.workers.dev/setup?key=YOUR_WEBHOOK_SECRET` in a browser. It should return `{"ok":true,...}`. If your Workers URL differs, use that URL instead.
5. Open the bot in Telegram and send `/start`. Add inventory with `/additem Laptop Dell;5;pcs;yes;IT`.

Keep `BOT_TOKEN` and `WEBHOOK_SECRET` in Wrangler secrets; do not put them in source control. If a token has been exposed, revoke it with **@BotFather** and use the replacement token.

## How it works
- **User**: /start → sends employee ID → admin approves → taps **Request an item** → item button → quantity button → confirm. No typing.
- **Admin** gets Approve / Reject buttons (reject can include a reason). Stock is reserved atomically at request time.
- After approval the user taps **I received it** (confirmation linked to their Telegram ID). Returnable items get a due date; the user reports the return and the admin confirms.
- Every action is saved in `requests` and `audit_log`. Nothing is deleted.
- Daily cron at 09:00 Africa/Nairobi reminds about overdue returns and unconfirmed pickups.

## Admin commands
/help · /additem · /restock · /removeitem · /history ID · /user ID · /req ID · /block · /unblock · /export (CSV) · /audit
