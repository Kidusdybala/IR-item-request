// Telegram Item Request Bot — Cloudflare Workers + D1
// Secrets: BOT_TOKEN, WEBHOOK_SECRET   Vars: ADMIN_IDS, TZ_OFFSET   Binding: DB

const PAGE = 8;
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const btn = (text, data) => ({ text, callback_data: data });
const MENU = btn('🏠 Menu', 'm');
const now = () => new Date().toISOString();
const admins = env => (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (env, id) => admins(env).includes(String(id));
const fmt = (iso, env) => iso
  ? new Date(new Date(iso).getTime() + (Number(env.TZ_OFFSET) || 0) * 3600000).toISOString().slice(0, 16).replace('T', ' ')
  : '—';
const STATUS = {
  pending: '⏳ Pending', approved: '🟢 Approved – collect it', rejected: '❌ Rejected',
  cancelled: '🚫 Cancelled', received: '📦 Received', return_pending: '↩️ Return pending', returned: '✅ Returned',
};

// ───────────────────────── entry points ─────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const update = await req.json();
      ctx.waitUntil(handle(update, env).catch(e => console.error('handler error', e)));
      return new Response('ok');
    }
    if (url.pathname === '/setup') { // one-time: registers the webhook
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      return Response.json(await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      }));
    }
    return new Response('Item request bot is running.');
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(reminders(env)); },
};

async function handle(u, env) {
  if (u.callback_query) return onCallback(u.callback_query, env);
  if (u.message) return onMessage(u.message, env);
}

// ───────────────────────── telegram helpers ─────────────────────────
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.error(method, JSON.stringify(j));
  return j;
}
const send = (env, chat_id, text, kb) => tg(env, 'sendMessage', {
  chat_id, text: text.slice(0, 4000), parse_mode: 'HTML',
  reply_markup: kb ? { inline_keyboard: kb } : undefined,
});
const notifyAdmins = (env, text, kb) => Promise.all(admins(env).map(id => send(env, id, text, kb)));

// ctx.reply edits the tapped message (clean UI) or sends a new one
function mk(env, chatId, msgId, from) {
  return {
    env, chatId, from,
    async reply(text, kb) {
      if (msgId) {
        const j = await tg(env, 'editMessageText', {
          chat_id: chatId, message_id: msgId, text: text.slice(0, 4000), parse_mode: 'HTML',
          reply_markup: { inline_keyboard: kb || [] },
        });
        if (j.ok || /not modified/.test(j.description || '')) return;
      }
      return send(env, chatId, text, kb);
    },
  };
}

// ───────────────────────── db helpers ─────────────────────────
const audit = (env, actor, action, entity, entityId, details) =>
  env.DB.prepare('INSERT INTO audit_log (ts,actor_id,action,entity,entity_id,details) VALUES (?,?,?,?,?,?)')
    .bind(now(), actor, action, entity, entityId ?? null, details ?? null).run();

const setState = (env, id, s) => env.DB.prepare('INSERT INTO sessions (telegram_id,state) VALUES (?,?) ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state').bind(id, s).run();
const getState = (env, id) => env.DB.prepare('SELECT state FROM sessions WHERE telegram_id=?').bind(id).first().then(r => r?.state);
const clearState = (env, id) => env.DB.prepare('DELETE FROM sessions WHERE telegram_id=?').bind(id).run();

async function upsertUser(env, from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
  const admin = isAdmin(env, from.id);
  await env.DB.prepare(
    `INSERT INTO users (telegram_id,username,full_name,status) VALUES (?,?,?,?)
     ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name`
  ).bind(from.id, from.username || null, name, admin ? 'approved' : 'new').run();
  if (admin) await env.DB.prepare("UPDATE users SET status='approved' WHERE telegram_id=? AND status!='approved'").bind(from.id).run();
  return env.DB.prepare('SELECT * FROM users WHERE telegram_id=?').bind(from.id).first();
}

const getReq = (env, id) => env.DB.prepare(
  `SELECT r.*, u.full_name, u.employee_id, i.returnable, i.unit, i.loan_days
   FROM requests r JOIN users u ON u.telegram_id=r.user_id JOIN items i ON i.id=r.item_id WHERE r.id=?`
).bind(id).first();

const userCard = u => `Name: ${esc(u.full_name)}\nUsername: ${u.username ? '@' + esc(u.username) : '—'}\nTelegram ID: <code>${u.telegram_id ?? u.user_id}</code>\nEmployee ID: ${esc(u.employee_id || '—')}`;
const reqLine = (r, env) => `#${r.id} · ${esc(r.item_name)} ×${r.qty} — ${STATUS[r.status] || r.status} (${fmt(r.requested_at, env)})`;

// ───────────────────────── messages ─────────────────────────
async function onMessage(m, env) {
  if (m.chat.type !== 'private' || !m.from) return;
  const user = await upsertUser(env, m.from);
  const ctx = mk(env, m.chat.id, null, m.from);
  const text = (m.text || '').trim();
  const admin = isAdmin(env, m.from.id);

  if (/^\/(start|menu)\b/.test(text)) {
    await clearState(env, m.from.id);
    return (!admin && user.status !== 'approved') ? gate(ctx, user) : menu(ctx, user);
  }
  const st = await getState(env, m.from.id);
  if (st === 'reg' && user.status === 'new') return register(ctx, user, text);
  if (!admin && user.status !== 'approved') return gate(ctx, user);
  if (admin && text.startsWith('/')) return adminCommand(ctx, text);
  if (admin && st?.startsWith('rej:')) { await clearState(env, m.from.id); return finishReject(ctx, Number(st.slice(4)), text); }
  return menu(ctx, user);
}

async function gate(ctx, user) {
  if (user.status === 'blocked') return ctx.reply('🚫 Your access is blocked. Please contact the administrator.');
  if (user.status === 'pending') return ctx.reply('⏳ Your registration is waiting for admin approval. You will be notified.');
  await setState(ctx.env, user.telegram_id, 'reg');
  return ctx.reply('👋 Welcome! To register, send your <b>employee ID</b> (and department if you like), e.g.\n<code>EMP-104 / Finance</code>');
}

async function register(ctx, user, text) {
  if (!text || text.startsWith('/') || text.length > 100) return ctx.reply('Please send your employee ID as plain text (max 100 characters).');
  const { env } = ctx;
  await env.DB.prepare("UPDATE users SET employee_id=?, status='pending' WHERE telegram_id=?").bind(text, user.telegram_id).run();
  await clearState(env, user.telegram_id);
  await audit(env, user.telegram_id, 'register', 'user', user.telegram_id, text);
  await notifyAdmins(env, `👤 <b>New registration</b>\n${userCard({ ...user, employee_id: text })}`,
    [[btn('✅ Approve', `a:ua:${user.telegram_id}`), btn('🚫 Reject', `a:ur:${user.telegram_id}`)]]);
  return ctx.reply('✅ Thanks! Your registration was sent to the admin. You will be notified once approved.');
}

async function menu(ctx, user) {
  const rows = [
    [btn('📦 Request an item', 'ri:0')],
    [btn('📋 My requests', 'my'), btn('🎒 Items I hold', 'hold')],
  ];
  if (isAdmin(ctx.env, ctx.from.id)) rows.push(
    [btn('⏳ Pending requests', 'a:pend'), btn('👥 Pending users', 'a:users')],
    [btn('📊 Stock', 'a:stock'), btn('🔄 Currently out', 'a:out')],
  );
  return ctx.reply(`👋 Hello <b>${esc(user.full_name)}</b>!\nWhat would you like to do?` + (isAdmin(ctx.env, ctx.from.id) ? '\n\nAdmin commands: /help' : ''), rows);
}

// ───────────────────────── callbacks ─────────────────────────
async function onCallback(cq, env) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!cq.message) return;
  const user = await upsertUser(env, cq.from);
  const ctx = mk(env, cq.message.chat.id, cq.message.message_id, cq.from);
  const admin = isAdmin(env, cq.from.id);
  const p = (cq.data || '').split(':');
  if (!admin && user.status !== 'approved') return gate(ctx, user);

  switch (p[0]) {
    case 'm': await clearState(env, cq.from.id); return menu(ctx, user);
    case 'ri': return showItems(ctx, Number(p[1]) || 0);
    case 'it': return pickQty(ctx, Number(p[1]));
    case 'q': return confirmScreen(ctx, Number(p[1]), Number(p[2]));
    case 'ok': return createRequest(ctx, Number(p[1]), Number(p[2]));
    case 'my': return myRequests(ctx);
    case 'hold': return myHoldings(ctx);
    case 'cx': return cancelRequest(ctx, Number(p[1]));
    case 'rcv': return confirmReceipt(ctx, Number(p[1]));
    case 'ret': return requestReturn(ctx, Number(p[1]));
    case 'a': return admin ? adminCb(ctx, p) : null;
  }
}

// ───────────────────────── user flow: pick from buttons ─────────────────────────
async function showItems(ctx, page) {
  const { results } = await ctx.env.DB.prepare(
    'SELECT id,name,unit,available_qty FROM items WHERE active=1 AND available_qty>0 ORDER BY name LIMIT ? OFFSET ?'
  ).bind(PAGE + 1, page * PAGE).all();
  if (!results.length && page === 0) return ctx.reply('😕 No items are available right now.', [[MENU]]);
  const rows = results.slice(0, PAGE).map(i => [btn(`${i.name} — ${i.available_qty} ${i.unit}`, `it:${i.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ Prev', `ri:${page - 1}`));
  if (results.length > PAGE) nav.push(btn('Next ➡️', `ri:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([MENU]);
  return ctx.reply('📦 <b>Available items</b>\nTap the item you need:', rows);
}

async function pickQty(ctx, itemId) {
  const it = await ctx.env.DB.prepare('SELECT * FROM items WHERE id=? AND active=1').bind(itemId).first();
  if (!it || it.available_qty < 1) return ctx.reply('Sorry, this item is no longer available.', [[btn('⬅️ Items', 'ri:0')]]);
  const opts = [1, 2, 3, 4, 5, 10, 20, 50].filter(n => n <= it.available_qty);
  if (!opts.includes(it.available_qty) && it.available_qty <= 100) opts.push(it.available_qty);
  const rows = [];
  for (let i = 0; i < opts.length; i += 4) rows.push(opts.slice(i, i + 4).map(n => btn(String(n), `q:${itemId}:${n}`)));
  rows.push([btn('⬅️ Back', 'ri:0')]);
  return ctx.reply(`<b>${esc(it.name)}</b>\nAvailable: ${it.available_qty} ${esc(it.unit)}${it.returnable ? `\n🔁 Returnable (${it.loan_days} days)` : ''}\n\nHow many do you need?`, rows);
}

async function confirmScreen(ctx, itemId, qty) {
  const it = await ctx.env.DB.prepare('SELECT * FROM items WHERE id=? AND active=1').bind(itemId).first();
  if (!it || qty < 1 || qty > it.available_qty) return ctx.reply('Stock changed. Please choose again.', [[btn('⬅️ Items', 'ri:0')]]);
  return ctx.reply(`Please confirm your request:\n\n<b>${esc(it.name)}</b> × ${qty} ${esc(it.unit)}`,
    [[btn('✅ Send request', `ok:${itemId}:${qty}`)], [btn('❌ Cancel', 'ri:0')]]);
}

async function createRequest(ctx, itemId, qty) {
  const { env, from } = ctx;
  if (!(qty >= 1)) return;
  const it = await env.DB.prepare('SELECT * FROM items WHERE id=? AND active=1').bind(itemId).first();
  if (!it) return ctx.reply('Item not found.', [[btn('⬅️ Items', 'ri:0')]]);
  // atomic stock reservation: prevents two people taking the last item
  const res = await env.DB.prepare('UPDATE items SET available_qty=available_qty-? WHERE id=? AND available_qty>=?').bind(qty, itemId, qty).run();
  if (!res.meta.changes) return ctx.reply('😕 Not enough stock anymore. Please choose again.', [[btn('⬅️ Items', 'ri:0')]]);
  const ins = await env.DB.prepare(
    "INSERT INTO requests (user_id,username,item_id,item_name,qty,status,requested_at) VALUES (?,?,?,?,?,'pending',?)"
  ).bind(from.id, from.username || null, itemId, it.name, qty, now()).run();
  const id = ins.meta.last_row_id;
  await audit(env, from.id, 'request', 'request', id, `${it.name} x${qty}`);
  const r = await getReq(env, id);
  await notifyAdmins(env, `🆕 <b>Request #${id}</b>\n${esc(it.name)} × ${qty} ${esc(it.unit)}\n\n${userCard(r)}`,
    [[btn('✅ Approve', `a:ap:${id}`), btn('❌ Reject', `a:rj:${id}`)]]);
  const left = it.available_qty - qty;
  if (left <= it.low_stock) await notifyAdmins(env, `⚠️ <b>Low stock</b>: ${esc(it.name)} — ${left} ${esc(it.unit)} left (ID ${it.id}). Use <code>/restock ${it.id} qty</code>`);
  return ctx.reply(`📨 Request <b>#${id}</b> sent!\n${esc(it.name)} × ${qty}\n\nStatus: ⏳ waiting for admin approval. I'll message you.`, [[btn('📋 My requests', 'my')], [MENU]]);
}

async function myRequests(ctx) {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM requests WHERE user_id=? ORDER BY id DESC LIMIT 10').bind(ctx.from.id).all();
  if (!results.length) return ctx.reply('You have no requests yet.', [[btn('📦 Request an item', 'ri:0')], [MENU]]);
  const rows = [];
  for (const r of results) {
    if (r.status === 'pending') rows.push([btn(`🚫 Cancel #${r.id}`, `cx:${r.id}`)]);
    if (r.status === 'approved') rows.push([btn(`📦 I received #${r.id}`, `rcv:${r.id}`)]);
  }
  rows.push([MENU]);
  return ctx.reply('📋 <b>Your last requests</b>\n\n' + results.map(r => reqLine(r, ctx.env)).join('\n'), rows);
}

async function myHoldings(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT r.* FROM requests r JOIN items i ON i.id=r.item_id
     WHERE r.user_id=? AND i.returnable=1 AND r.status IN ('received','return_pending') ORDER BY r.id DESC`
  ).bind(ctx.from.id).all();
  if (!results.length) return ctx.reply('🎒 You are not holding any returnable items.', [[MENU]]);
  const rows = results.filter(r => r.status === 'received').map(r => [btn(`↩️ Return #${r.id} (${r.item_name})`, `ret:${r.id}`)]);
  rows.push([MENU]);
  return ctx.reply('🎒 <b>Items you hold</b>\n\n' + results.map(r =>
    `#${r.id} · ${esc(r.item_name)} ×${r.qty}\n   since ${fmt(r.received_at, ctx.env)} · due ${fmt(r.due_at, ctx.env)}${r.status === 'return_pending' ? ' · ↩️ awaiting admin' : ''}`).join('\n'), rows);
}

async function cancelRequest(ctx, id) {
  const r = await getReq(ctx.env, id);
  if (!r || r.user_id !== ctx.from.id) return ctx.reply('Request not found.', [[MENU]]);
  const res = await ctx.env.DB.prepare("UPDATE requests SET status='cancelled', decided_at=? WHERE id=? AND status='pending'").bind(now(), id).run();
  if (!res.meta.changes) return ctx.reply('This request can no longer be cancelled.', [[btn('📋 My requests', 'my')]]);
  await ctx.env.DB.prepare('UPDATE items SET available_qty=available_qty+? WHERE id=?').bind(r.qty, r.item_id).run();
  await audit(ctx.env, ctx.from.id, 'cancel', 'request', id);
  await notifyAdmins(ctx.env, `🚫 ${esc(r.full_name)} cancelled request #${id} (${esc(r.item_name)} ×${r.qty}).`);
  return ctx.reply(`🚫 Request #${id} cancelled.`, [[btn('📋 My requests', 'my')], [MENU]]);
}

async function confirmReceipt(ctx, id) {
  const { env } = ctx;
  const r = await getReq(env, id);
  if (!r || r.user_id !== ctx.from.id) return ctx.reply('Request not found.', [[MENU]]);
  const due = r.returnable ? new Date(Date.now() + r.loan_days * 864e5).toISOString() : null;
  const res = await env.DB.prepare("UPDATE requests SET status='received', received_at=?, due_at=? WHERE id=? AND status='approved'").bind(now(), due, id).run();
  if (!res.meta.changes) return ctx.reply('This request is not waiting for receipt confirmation.', [[btn('📋 My requests', 'my')]]);
  if (!r.returnable) await env.DB.prepare('UPDATE items SET total_qty=MAX(0,total_qty-?) WHERE id=?').bind(r.qty, r.item_id).run(); // consumable
  await audit(env, ctx.from.id, 'received', 'request', id);
  await notifyAdmins(env, `📦 <b>${esc(r.full_name)}</b> confirmed receipt of #${id}: ${esc(r.item_name)} ×${r.qty}`);
  return ctx.reply(`✅ Receipt confirmed for #${id}.` + (due ? `\n🔁 Please return it by <b>${fmt(due, env)}</b>.` : ''),
    due ? [[btn('🎒 Items I hold', 'hold')], [MENU]] : [[MENU]]);
}

async function requestReturn(ctx, id) {
  const { env } = ctx;
  const res = await env.DB.prepare("UPDATE requests SET status='return_pending', return_requested_at=? WHERE id=? AND user_id=? AND status='received'").bind(now(), id, ctx.from.id).run();
  if (!res.meta.changes) return ctx.reply('Nothing to return for this request.', [[MENU]]);
  const r = await getReq(env, id);
  await audit(env, ctx.from.id, 'return_requested', 'request', id);
  await notifyAdmins(env, `↩️ <b>${esc(r.full_name)}</b> says they returned #${id}: ${esc(r.item_name)} ×${r.qty}. Please verify.`,
    [[btn('✅ Confirm returned', `a:ret:${id}`)]]);
  return ctx.reply('↩️ Return reported. Waiting for the admin to confirm.', [[MENU]]);
}

// ───────────────────────── admin callbacks ─────────────────────────
async function adminCb(ctx, p) {
  const id = Number(p[2]);
  switch (p[1]) {
    case 'pend': return pendingList(ctx);
    case 'users': return pendingUsers(ctx);
    case 'stock': return stockList(ctx);
    case 'out': return outList(ctx);
    case 'ua': case 'ur': return decideUser(ctx, id, p[1] === 'ua');
    case 'ap': return approve(ctx, id);
    case 'rj':
      await setState(ctx.env, ctx.from.id, `rej:${id}`);
      return ctx.reply(`❌ Rejecting #${id}. Type a reason now, or skip.`, [[btn('Skip reason', `a:rjs:${id}`)]]);
    case 'rjs': await clearState(ctx.env, ctx.from.id); return finishReject(ctx, id, '');
    case 'ret': return confirmReturn(ctx, id);
  }
}

async function decideUser(ctx, uid, ok) {
  const { env } = ctx;
  const res = await env.DB.prepare("UPDATE users SET status=? WHERE telegram_id=? AND status IN ('pending','new')").bind(ok ? 'approved' : 'blocked', uid).run();
  if (!res.meta.changes) return ctx.reply('Already handled.', [[btn('👥 Pending users', 'a:users')]]);
  await audit(env, ctx.from.id, ok ? 'user_approved' : 'user_rejected', 'user', uid);
  await send(env, uid, ok ? '✅ Your registration was approved! Tap /start to begin.' : '🚫 Your registration was rejected. Contact the administrator.');
  return ctx.reply(`${ok ? '✅ Approved' : '🚫 Rejected'} user <code>${uid}</code>.`, [[btn('👥 Pending users', 'a:users')], [MENU]]);
}

async function pendingUsers(ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM users WHERE status='pending' ORDER BY created_at LIMIT 5").all();
  if (!results.length) return ctx.reply('No users waiting for approval.', [[MENU]]);
  const rows = results.map(u => [btn(`✅ ${u.full_name}`, `a:ua:${u.telegram_id}`), btn('🚫', `a:ur:${u.telegram_id}`)]);
  rows.push([MENU]);
  return ctx.reply('👥 <b>Pending users</b>\n\n' + results.map(userCard).join('\n\n'), rows);
}

async function pendingList(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT r.*, u.full_name, u.employee_id FROM requests r JOIN users u ON u.telegram_id=r.user_id
     WHERE r.status='pending' ORDER BY r.id LIMIT 5`).all();
  if (!results.length) return ctx.reply('✅ No pending requests.', [[MENU]]);
  const rows = results.map(r => [btn(`✅ #${r.id}`, `a:ap:${r.id}`), btn(`❌ #${r.id}`, `a:rj:${r.id}`)]);
  rows.push([MENU]);
  return ctx.reply('⏳ <b>Pending requests</b>\n\n' + results.map(r =>
    `#${r.id} · ${esc(r.item_name)} ×${r.qty}\n   ${esc(r.full_name)} (${esc(r.employee_id || '—')}) · ${fmt(r.requested_at, ctx.env)}`).join('\n\n'), rows);
}

async function approve(ctx, id) {
  const { env } = ctx;
  const res = await env.DB.prepare("UPDATE requests SET status='approved', decided_at=?, decided_by=? WHERE id=? AND status='pending'").bind(now(), ctx.from.id, id).run();
  const r = await getReq(env, id);
  if (!r) return ctx.reply('Request not found.', [[MENU]]);
  if (!res.meta.changes) return ctx.reply(`#${id} was already handled: ${STATUS[r.status] || r.status}.`, [[btn('⏳ Pending', 'a:pend')]]);
  await audit(env, ctx.from.id, 'approved', 'request', id);
  await send(env, r.user_id, `🟢 <b>Request #${id} approved</b>\n${esc(r.item_name)} × ${r.qty}\n\nCollect it from the admin, then tap the button to confirm you received it.`,
    [[btn('📦 I received it', `rcv:${id}`)]]);
  return ctx.reply(`✅ Approved #${id}: ${esc(r.item_name)} ×${r.qty} for ${esc(r.full_name)}.\nThey were notified and must confirm receipt.`, [[btn('⏳ Pending', 'a:pend')], [MENU]]);
}

async function finishReject(ctx, id, reason) {
  const { env } = ctx;
  const res = await env.DB.prepare("UPDATE requests SET status='rejected', decided_at=?, decided_by=?, admin_note=? WHERE id=? AND status='pending'").bind(now(), ctx.from.id, reason || null, id).run();
  const r = await getReq(env, id);
  if (!r) return ctx.reply('Request not found.', [[MENU]]);
  if (!res.meta.changes) return ctx.reply(`#${id} was already handled: ${STATUS[r.status] || r.status}.`, [[btn('⏳ Pending', 'a:pend')]]);
  await env.DB.prepare('UPDATE items SET available_qty=available_qty+? WHERE id=?').bind(r.qty, r.item_id).run(); // release reserved stock
  await audit(env, ctx.from.id, 'rejected', 'request', id, reason);
  await send(env, r.user_id, `❌ <b>Request #${id} rejected</b>\n${esc(r.item_name)} × ${r.qty}${reason ? `\nReason: ${esc(reason)}` : ''}`);
  return ctx.reply(`❌ Rejected #${id}. Stock released.`, [[btn('⏳ Pending', 'a:pend')], [MENU]]);
}

async function confirmReturn(ctx, id) {
  const { env } = ctx;
  const res = await env.DB.prepare("UPDATE requests SET status='returned', returned_at=?, returned_confirmed_by=? WHERE id=? AND status IN ('received','return_pending')").bind(now(), ctx.from.id, id).run();
  const r = await getReq(env, id);
  if (!r) return ctx.reply('Request not found.', [[MENU]]);
  if (!res.meta.changes) return ctx.reply(`#${id} is not out (${STATUS[r.status] || r.status}).`, [[btn('🔄 Currently out', 'a:out')]]);
  await env.DB.prepare('UPDATE items SET available_qty=MIN(total_qty, available_qty+?) WHERE id=?').bind(r.qty, r.item_id).run();
  await audit(env, ctx.from.id, 'returned', 'request', id);
  await send(env, r.user_id, `✅ Return of #${id} (${esc(r.item_name)} ×${r.qty}) confirmed. Thank you!`);
  return ctx.reply(`✅ #${id} marked returned. Stock restored.`, [[btn('🔄 Currently out', 'a:out')], [MENU]]);
}

async function stockList(ctx) {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM items WHERE active=1 ORDER BY name LIMIT 40').all();
  if (!results.length) return ctx.reply('No items yet. Add one:\n<code>/additem Laptop Dell;5;pcs;yes;IT</code>', [[MENU]]);
  return ctx.reply('📊 <b>Stock</b>\n\n' + results.map(i =>
    `<code>${i.id}</code> · ${esc(i.name)} — <b>${i.available_qty}</b>/${i.total_qty} ${esc(i.unit)}${i.returnable ? ' 🔁' : ''}`).join('\n'), [[MENU]]);
}

async function outList(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT r.*, u.full_name, u.employee_id FROM requests r JOIN users u ON u.telegram_id=r.user_id JOIN items i ON i.id=r.item_id
     WHERE i.returnable=1 AND r.status IN ('received','return_pending') ORDER BY r.due_at LIMIT 15`).all();
  if (!results.length) return ctx.reply('Nothing is currently out.', [[MENU]]);
  const rows = results.map(r => [btn(`↩️ Mark returned #${r.id}`, `a:ret:${r.id}`)]);
  rows.push([MENU]);
  return ctx.reply('🔄 <b>Currently out</b>\n\n' + results.map(r =>
    `#${r.id} · ${esc(r.item_name)} ×${r.qty}\n   ${esc(r.full_name)} (${esc(r.employee_id || '—')}) · due ${fmt(r.due_at, ctx.env)}${r.due_at < now() ? ' ⚠️ OVERDUE' : ''}${r.status === 'return_pending' ? ' · returning' : ''}`).join('\n\n'), rows);
}

// ───────────────────────── admin text commands ─────────────────────────
const HELP = `<b>Admin commands</b>
<code>/additem Name;qty;unit;returnable yes/no;category</code>
   e.g. <code>/additem Laptop Dell;5;pcs;yes;IT</code>
<code>/restock ID qty</code> – add stock
<code>/removeitem ID</code> – hide item (history kept)
<code>/history ID</code> – transactions of an item
<code>/user TELEGRAM_ID</code> – transactions of a user
<code>/req ID</code> – full detail of one request
<code>/block ID</code> · <code>/unblock ID</code>
<code>/export</code> – CSV of all transactions
<code>/audit</code> – last 25 actions`;

async function adminCommand(ctx, text) {
  const { env, from } = ctx;
  const head = text.split(/\s+/)[0];
  const cmd = head.split('@')[0].toLowerCase();
  const arg = text.slice(head.length).trim();
  const num = s => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : NaN; };

  switch (cmd) {
    case '/additem': {
      const [name, qty, unit, ret, cat] = arg.split(';').map(s => s.trim());
      const q = num(qty);
      if (!name || !(q >= 0)) return ctx.reply('Usage:\n<code>/additem Name;qty;unit;returnable yes/no;category</code>');
      const r = /^(y|yes|1|true)$/i.test(ret || '') ? 1 : 0;
      const res = await env.DB.prepare('INSERT INTO items (name,category,unit,total_qty,available_qty,returnable) VALUES (?,?,?,?,?,?)')
        .bind(name, cat || null, unit || 'pcs', q, q, r).run();
      await audit(env, from.id, 'item_added', 'item', res.meta.last_row_id, `${name} x${q}`);
      return ctx.reply(`✅ Added <b>${esc(name)}</b> (ID ${res.meta.last_row_id}) — ${q} ${esc(unit || 'pcs')}${r ? ', returnable' : ', consumable'}.`);
    }
    case '/restock': {
      const [id, q] = arg.split(/\s+/).map(num);
      if (!(id > 0) || !(q > 0)) return ctx.reply('Usage: <code>/restock ID qty</code>');
      const res = await env.DB.prepare('UPDATE items SET total_qty=total_qty+?, available_qty=available_qty+? WHERE id=?').bind(q, q, id).run();
      if (!res.meta.changes) return ctx.reply('Item not found.');
      await audit(env, from.id, 'restock', 'item', id, `+${q}`);
      return ctx.reply(`✅ Item ${id} restocked by ${q}.`);
    }
    case '/removeitem': {
      const id = num(arg);
      const res = await env.DB.prepare('UPDATE items SET active=0 WHERE id=?').bind(id).run();
      await audit(env, from.id, 'item_removed', 'item', id);
      return ctx.reply(res.meta.changes ? `🗑 Item ${id} hidden (history kept).` : 'Item not found.');
    }
    case '/history': case '/user': {
      const id = num(arg);
      if (!id) return ctx.reply(`Usage: <code>${cmd} ID</code>`);
      const col = cmd === '/history' ? 'r.item_id' : 'r.user_id';
      const { results } = await env.DB.prepare(
        `SELECT r.*, u.full_name FROM requests r JOIN users u ON u.telegram_id=r.user_id WHERE ${col}=? ORDER BY r.id DESC LIMIT 20`).bind(id).all();
      if (!results.length) return ctx.reply('No records.');
      return ctx.reply('🧾 <b>History</b>\n\n' + results.map(r =>
        `#${r.id} · ${esc(r.item_name)} ×${r.qty} · ${esc(r.full_name)}${r.username ? ' @' + esc(r.username) : ''}\n   ${STATUS[r.status] || r.status} · ${fmt(r.requested_at, env)}`).join('\n'));
    }
    case '/req': {
      const r = await getReq(env, num(arg));
      if (!r) return ctx.reply('Request not found.');
      return ctx.reply(`🧾 <b>Request #${r.id}</b> — ${STATUS[r.status] || r.status}\n${esc(r.item_name)} × ${r.qty} ${esc(r.unit)}\n\n${userCard(r)}\n\nRequested: ${fmt(r.requested_at, env)}\nDecided: ${fmt(r.decided_at, env)} (by <code>${r.decided_by ?? '—'}</code>)\nReceived: ${fmt(r.received_at, env)}\nDue: ${fmt(r.due_at, env)}\nReturned: ${fmt(r.returned_at, env)} (by <code>${r.returned_confirmed_by ?? '—'}</code>)\nNote: ${esc(r.admin_note || '—')}`);
    }
    case '/block': case '/unblock': {
      const id = num(arg);
      const res = await env.DB.prepare('UPDATE users SET status=? WHERE telegram_id=?').bind(cmd === '/block' ? 'blocked' : 'approved', id).run();
      await audit(env, from.id, cmd.slice(1), 'user', id);
      return ctx.reply(res.meta.changes ? `Done: ${cmd.slice(1)} <code>${id}</code>.` : 'User not found.');
    }
    case '/audit': {
      const { results } = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 25').all();
      return ctx.reply('🗂 <b>Audit log</b>\n\n' + results.map(a =>
        `${fmt(a.ts, env)} · <code>${a.actor_id}</code> · ${esc(a.action)} ${esc(a.entity || '')}${a.entity_id ?? ''}${a.details ? ' · ' + esc(a.details) : ''}`).join('\n'));
    }
    case '/export': return exportCsv(ctx);
    default: return ctx.reply(HELP);
  }
}

async function exportCsv(ctx) {
  const { env } = ctx;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.status, r.item_id, r.item_name, r.qty, r.user_id, r.username, u.full_name, u.employee_id,
            r.requested_at, r.decided_at, r.decided_by, r.received_at, r.due_at, r.returned_at, r.returned_confirmed_by, r.admin_note
     FROM requests r JOIN users u ON u.telegram_id=r.user_id ORDER BY r.id`).all();
  if (!results.length) return ctx.reply('No transactions yet.');
  const cols = Object.keys(results[0]);
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\ufeff' + [cols.join(','), ...results.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  const fd = new FormData();
  fd.append('chat_id', String(ctx.chatId));
  fd.append('document', new Blob([csv], { type: 'text/csv' }), `transactions-${now().slice(0, 10)}.csv`);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
}

// ───────────────────────── daily reminders (cron) ─────────────────────────
async function reminders(env) {
  const t = now();
  const day = new Date(Date.now() - 20 * 3600e3).toISOString();
  const { results: late } = await env.DB.prepare(
    `SELECT r.*, u.full_name FROM requests r JOIN users u ON u.telegram_id=r.user_id
     WHERE r.status='received' AND r.due_at IS NOT NULL AND r.due_at<? AND (r.last_reminded_at IS NULL OR r.last_reminded_at<?)`).bind(t, day).all();
  for (const r of late) {
    await send(env, r.user_id, `⚠️ <b>Overdue:</b> ${esc(r.item_name)} ×${r.qty} (request #${r.id}) was due ${fmt(r.due_at, env)}. Please return it.`, [[btn('↩️ I returned it', `ret:${r.id}`)]]);
    await env.DB.prepare('UPDATE requests SET last_reminded_at=? WHERE id=?').bind(t, r.id).run();
  }
  if (late.length) await notifyAdmins(env, '⚠️ <b>Overdue items</b>\n\n' + late.map(r => `#${r.id} ${esc(r.item_name)} ×${r.qty} — ${esc(r.full_name)} (due ${fmt(r.due_at, env)})`).join('\n'));

  const old = new Date(Date.now() - 2 * 864e5).toISOString();
  const { results: waiting } = await env.DB.prepare(
    `SELECT * FROM requests WHERE status='approved' AND decided_at<? AND (last_reminded_at IS NULL OR last_reminded_at<?)`).bind(old, day).all();
  for (const r of waiting) {
    await send(env, r.user_id, `🔔 Request #${r.id} (${esc(r.item_name)} ×${r.qty}) was approved but you haven't confirmed receipt yet.`, [[btn('📦 I received it', `rcv:${r.id}`)]]);
    await env.DB.prepare('UPDATE requests SET last_reminded_at=? WHERE id=?').bind(t, r.id).run();
  }
}
