// Telegram-Weckalarm: "benachrichtige mich, wenn dieses Wallet nach langer
// Ruhe wieder aktiv wird". Zwei Haelften:
//
//   1. Webhook (hier, handleTelegramWebhook) - nimmt /watch, /unwatch,
//      /mywatch entgegen, laeuft im Worker (schnelle, seltene Anfragen,
//      unproblematisch fuers 10ms-CPU-Limit).
//   2. Versand (benachrichtigeSleeperWakes) - laeuft NICHT im Worker, sondern
//      im Ingest-Job (GitHub Action, alle 30 Min, siehe src/ingest.js): dort
//      gibt es ohnehin schon die frisch erkannten sleeper_wake-Ereignisse,
//      und Actions haben kein CPU-Limit, das eine handvoll HTTP-Calls an die
//      Telegram-API gefaehrden koennte.
//
// Bewusst kein eigener Cron-Job dafuer noetig - der Ingest laeuft schon.

const TG_API = "https://api.telegram.org/bot";
const MAX_JE_CHAT = 15; // Deckel gegen Missbrauch/Tippfehler-Spam
const ADRESSE_RE = /^0x[0-9a-f]{40}$/;

export async function sendTelegramMessage(token, chatId, text) {
  const res = await fetch(TG_API + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Telegram sendMessage fehlgeschlagen: " + res.status + " " + body);
  }
  return res.json();
}

function kurzAdr(a) {
  return a.slice(0, 8) + "…" + a.slice(-6);
}

/**
 * Nach dem Ingest: fuer jedes sleeper_wake-Ereignis alle Abonnenten dieser
 * Adresse benachrichtigen. `wakeEvents` sind rohe Events aus runIngest
 * (type === "sleeper_wake"), meta noch als JSON-String.
 */
export async function benachrichtigeSleeperWakes(env, db, wakeEvents, log = () => {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !wakeEvents?.length) return { versendet: 0 };
  let versendet = 0;
  for (const ev of wakeEvents) {
    const subs = (
      await db.prepare("SELECT chat_id FROM telegram_subscriptions WHERE address = ?")
        .bind(ev.address).all()
    ).results;
    if (!subs.length) continue;

    let meta = {};
    try { meta = JSON.parse(ev.meta ?? "{}"); } catch { /* ignoriere kaputtes meta */ }

    const text =
      "🔔 <b>Wake-up alarm</b>\n\n" +
      "A wallet you're watching just moved" +
      (meta.ruhetage ? " after " + meta.ruhetage + " days of silence" : "") + ".\n\n" +
      "<code>" + ev.address + "</code>" +
      (meta.ruhend_mit_etn
        ? "\nBalance before waking up: " + Math.round(meta.ruhend_mit_etn).toLocaleString("en-US") + " ETN"
        : "") +
      "\n\nhttps://blockexplorer.electroneum.com/address/" + ev.address;

    for (const s of subs) {
      try {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, s.chat_id, text);
        versendet++;
      } catch (e) {
        log("  Telegram-Versand an chat " + s.chat_id + " fehlgeschlagen: " + e.message);
      }
    }
  }
  return { versendet };
}

async function anzahlAbos(db, chatId) {
  const r = await db
    .prepare("SELECT COUNT(*) n FROM telegram_subscriptions WHERE chat_id = ?")
    .bind(chatId).first();
  return r?.n ?? 0;
}

async function befehlAusfuehren(db, chatId, text) {
  const teile = text.trim().split(/\s+/);
  const befehl = (teile[0] ?? "").toLowerCase().replace(/@\w+$/, ""); // /watch@BotName -> /watch

  if (befehl === "/start") {
    // Deep-Link-Payload: t.me/<Bot>?start=<addressOhne0x> - Telegram haengt
    // den Payload als zweites Wort an /start an.
    const payload = teile[1];
    if (payload && /^[0-9a-f]{40}$/i.test(payload)) {
      return befehlAusfuehren(db, chatId, "/watch 0x" + payload.toLowerCase());
    }
    return "👋 Welcome to the ETN Radar wake-up alarm.\n\n" +
      "I'll ping you here when a wallet you're watching moves after being dormant a long time.\n\n" +
      "<b>/watch 0xAddress</b> — start watching a wallet\n" +
      "<b>/unwatch 0xAddress</b> — stop watching it\n" +
      "<b>/mywatch</b> — list what you're watching\n" +
      "<b>/stop</b> — remove everything";
  }

  if (befehl === "/watch") {
    const adr = (teile[1] ?? "").toLowerCase();
    if (!ADRESSE_RE.test(adr)) return "That doesn't look like a wallet address. Usage: <b>/watch 0x…</b>";
    const bisher = await anzahlAbos(db, chatId);
    if (bisher >= MAX_JE_CHAT) return "You're already watching " + MAX_JE_CHAT + " wallets — that's the limit. Use /unwatch to free up a slot.";
    await db
      .prepare(
        "INSERT INTO telegram_subscriptions (chat_id, address, created_at) VALUES (?,?,?)" +
          " ON CONFLICT(chat_id, address) DO NOTHING"
      )
      .bind(chatId, adr, new Date().toISOString())
      .run();
    return "🔔 Watching <code>" + kurzAdr(adr) + "</code> — you'll hear from me if it wakes up from a long sleep.";
  }

  if (befehl === "/unwatch") {
    const adr = (teile[1] ?? "").toLowerCase();
    if (!ADRESSE_RE.test(adr)) return "Usage: <b>/unwatch 0x…</b>";
    await db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ? AND address = ?")
      .bind(chatId, adr).run();
    return "Stopped watching <code>" + kurzAdr(adr) + "</code>.";
  }

  if (befehl === "/mywatch" || befehl === "/list") {
    const rows = (
      await db.prepare("SELECT address FROM telegram_subscriptions WHERE chat_id = ? ORDER BY created_at ASC")
        .bind(chatId).all()
    ).results;
    if (!rows.length) return "You're not watching any wallets yet. Try <b>/watch 0x…</b>";
    return "Watching " + rows.length + " wallet(s):\n" + rows.map((r) => "• <code>" + kurzAdr(r.address) + "</code>").join("\n");
  }

  if (befehl === "/stop") {
    await db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId).run();
    return "Removed everything you were watching. Send /watch 0x… any time to start again.";
  }

  return "Not sure what you mean. Try <b>/watch 0x…</b>, <b>/unwatch 0x…</b>, <b>/mywatch</b> or <b>/stop</b>.";
}

/** Verifiziert (falls konfiguriert) das Telegram-Webhook-Secret und beantwortet einen Update. */
export async function handleTelegramWebhook(request, env, db) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const kopf = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (kopf !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  }
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("not configured", { status: 501 });

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;
  if (!chatId || typeof text !== "string") return new Response("ok"); // nichts zu tun (z.B. edited_message)

  try {
    const antwort = await befehlAusfuehren(db, chatId, text);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, antwort);
  } catch (e) {
    // Telegram erwartet trotzdem 200, sonst wiederholt es die Zustellung endlos.
    console.error("Telegram-Webhook-Fehler:", e.message);
  }
  return new Response("ok");
}
