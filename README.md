# IR Item Request Bot

A Telegram bot for employees to request inventory and for administrators to manage approvals, stock, pickups, and returns. It runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/) and stores data in [Cloudflare D1](https://developers.cloudflare.com/d1/).

## Features

- Employee self-registration with administrator approval
- Item requests with stock reserved while awaiting a decision
- Admin approval or rejection, with optional rejection reason
- Pickup confirmation and due dates for loanable items
- Partial returns with administrator confirmation
- Stock management, low-stock notices, CSV export, and an audit trail
- Daily reminders for overdue returns and unconfirmed pickups

## What you need

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers and D1 enabled
- [Node.js](https://nodejs.org/) and npm, for `npx wrangler`
- A Telegram account and a bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram numeric user ID, to configure administrator access (you can obtain it from a Telegram ID bot)

## Install and configure

1. Download or clone this repository, then open a terminal in the project folder:

   ```sh
   git clone <repository-url>
   cd <repository-folder>
   ```

2. Install Wrangler and sign in to the Cloudflare account where you want to host the bot:

   ```sh
   npm install --global wrangler
   wrangler login
   ```

3. Create a D1 database:

   ```sh
   wrangler d1 create ir-item-request-db
   ```

   Copy the database ID Wrangler returns. Edit `wrangler.toml`: set `database_id` to that ID, and set `ADMIN_IDS` to your Telegram numeric ID. Multiple administrators can be listed as comma-separated IDs. Set `TZ_OFFSET` to your local UTC offset in hours (for example, `3` for UTC+3).

4. Create a bot with @BotFather using `/newbot`. Follow its prompts and copy the token. Optionally set the bot's display name with `/setname`.

5. Add the bot token and a strong, random webhook secret as Cloudflare Worker secrets. The webhook secret must be 1–256 characters, using only letters, numbers, underscores, and hyphens, as required by Telegram:

   ```sh
   wrangler secret put BOT_TOKEN
   wrangler secret put WEBHOOK_SECRET
   ```

   Enter the token and secret when prompted. Keep both private; do not commit them to source control.

## Initialize and deploy

For a **new database**, apply the complete schema once:

```sh
wrangler d1 execute ir-item-request-db --remote --file=schema.sql
```

Then deploy the Worker:

```sh
wrangler deploy
```

Register the Telegram webhook by opening the following URL in a browser, replacing the hostname with your deployed Worker hostname and `YOUR_WEBHOOK_SECRET` with the exact secret you entered above:

```text
https://<your-worker-hostname>/setup?key=YOUR_WEBHOOK_SECRET
```

Telegram should respond with JSON containing `"ok": true`. Treat this URL as sensitive while it contains the secret. The webhook is registered with Telegram and normally only needs to be set up once; repeat this step if you change the secret or Worker hostname.

If you already have a database from an **older version** of this bot, do not apply the full schema again. Apply the migration once instead:

```sh
wrangler d1 execute ir-item-request-db --remote --file=migrations/0002_partial_returns.sql
```

This migration adds fields needed to track partial returns. Do not run it on a fresh database initialized from the current `schema.sql`, because the fields are already present there.

## Use the bot

1. Open your bot in Telegram and send `/start`.
2. A new employee sends their employee ID (optionally with department), for example `EMP-104 / Finance`.
3. An administrator approves the registration in the bot.
4. Add inventory with an admin command, then employees can tap **Request an item**, choose an item, enter a quantity, and confirm.
5. Administrators approve or reject requests. Approved employees confirm pickup in Telegram. For returnable items, employees report returns and administrators confirm the quantity received.

Only IDs listed in `ADMIN_IDS` can use administrator functions. The bot talks to users through Telegram private chats.

## Administrator commands

Send these commands from an administrator Telegram account:

| Command | Purpose |
| --- | --- |
| `/help` | Show command help |
| `/additem Name;qty;unit;yes/no;category` | Add inventory; `yes` marks it returnable |
| `/restock ID qty` | Add stock to an item |
| `/removeitem ID` | Hide an item from requests while retaining history |
| **Pending requests** menu | Review and handle pending requests |
| `/history ID` | Show recent transactions for an item ID |
| `/user ID` | Show a user's details |
| `/req ID` | Show a request's details |
| `/block ID` / `/unblock ID` | Block or restore a user's access |
| `/export` | Send a CSV export of transactions |
| `/audit` | Review recent audit log entries |

Example: `/additem Laptop Dell;5;pcs;yes;IT` adds five returnable Dell laptops. Use `no` for consumables such as stationery. The bot also has a **🧾 Transactions** menu for browsing recent activity.

## Configuration reference

`wrangler.toml` defines the Worker name, D1 binding, administrator IDs, timezone offset, and daily scheduled reminder. The schedule is set to `0 6 * * *` UTC (09:00 at UTC+3). Change the cron expression if you want another reminder time. `BOT_TOKEN` and `WEBHOOK_SECRET` are secrets and are configured separately with `wrangler secret put`.

## Troubleshooting

- **Telegram does not respond:** confirm the deployment succeeded, both secrets are set for the same Cloudflare environment, and the webhook setup URL returned `"ok": true`.
- **Webhook setup returns `forbidden`:** the `key` must exactly match `WEBHOOK_SECRET`.
- **Database errors or missing tables:** confirm the D1 `database_id` in `wrangler.toml`, then apply `schema.sql` to a fresh database or the migration to an older one.
- **Admin commands are ignored:** confirm your numeric Telegram ID is in `ADMIN_IDS` and redeploy after changing `wrangler.toml`.
- **Changes do not appear:** redeploy the Worker with `wrangler deploy`.

## Data and security

Requests, stock changes, and administrative actions are stored in D1, including an audit log. The bot keeps historical records when an item is hidden. Protect access to your Cloudflare account and D1 database, restrict administrator IDs to trusted operators, and never publish bot tokens or webhook secrets.

## License

No license is currently included. Add a `LICENSE` file before redistributing this project if you want to grant others explicit reuse rights.
