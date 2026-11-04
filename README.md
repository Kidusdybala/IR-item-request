# IR item Request (Telegram + Cloudflare Workers + D1)

This project runs the **IR item Request** Telegram bot. Set the bot's display name to `IR item Request` with **@BotFather** (`/setname`). The bot username is configured separately with `/setusername` and must be unique.

## Deployment

The production Worker is deployed at <https://ir-item-request.buddykk07.workers.dev>. It uses a dedicated D1 database named `ir-item-request-db`; the existing `inventory-db` is separate and untouched. The admin Telegram ID is set in `wrangler.toml`.

To deploy an update, install Wrangler if needed, authenticate to the right Cloudflare account, then run:

```sh
npm install -g wrangler
wrangler login
wrangler deploy
```

The D1 schema is already installed. For a fresh database, run `wrangler d1 execute ir-item-request-db --remote --file=schema.sql` once. When upgrading an existing database to support partial returns, run `wrangler d1 execute ir-item-request-db --remote --file=migrations/0002_partial_returns.sql` once. `BOT_TOKEN` and `WEBHOOK_SECRET` are Cloudflare Worker secrets and must never be committed. To rotate the bot token, replace it with `wrangler secret put BOT_TOKEN`, set a new random `WEBHOOK_SECRET` the same way, then register the webhook at `https://ir-item-request.buddykk07.workers.dev/setup?key=THE_NEW_WEBHOOK_SECRET` using the exact new value you entered.

Open the bot in Telegram and send `/start`. Add inventory with `/additem Laptop Dell;5;pcs;yes;IT`.

## How it works
- **User**: /start → sends employee ID → admin approves → taps **Request an item** → item button → types quantity → confirms. To return a loan, the user types the quantity being returned and the admin confirms that amount.
- **Admin** gets Approve / Reject buttons (reject can include a reason). Stock is reserved atomically at request time.
- After approval the user taps **I received it** (confirmation linked to their Telegram ID). Returnable items get a due date; the user reports the return and the admin confirms.
- Every action is saved in `requests` and `audit_log`. Nothing is deleted.
- Daily cron at 09:00 Africa/Nairobi reminds about overdue returns and unconfirmed pickups.

## Admin commands
/help · /additem · /restock · /removeitem · /history ID · /user ID · /req ID · /block · /unblock · /export (CSV) · /audit

Admins can also open **🧾 Transactions** from the bot menu to browse paginated audit activity, including requests, decisions, receipts, returns, and stock changes.
