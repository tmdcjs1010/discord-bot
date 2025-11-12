// ---------- deps ----------
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  PermissionFlagsBits,
  Status, // v14
} = require("discord.js");

// ---------- tiny web server (Render port binding) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.send("✅ Bot running + heartbeat alive"));
app.listen(PORT, () => console.log(`🌐 Web server on :${PORT}`));

// ---------- discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- settings ----------
const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- login manager (no periodic force relogin) ----------
let loggingIn = false;

async function safeLogin(reason = "manual") {
  if (loggingIn) return;
  loggingIn = true;
  try {
    console.log(`🔐 safeLogin start (${reason})`);
    try {
      client.destroy();
    } catch {}
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ safeLogin success");
  } catch (e) {
    console.error("❌ safeLogin failed:", e?.message || e);
  } finally {
    loggingIn = false;
  }
}

async function loginBot() {
  return safeLogin("initial");
}

// ---------- 1min keepalive (Discord + Render self-ping) ----------
const fetchLazy = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

setInterval(async () => {
  try {
    if (!client?.ws || typeof client.ws.ping !== "number") {
      console.log("💓 Keepalive ping (1min) – waiting for ws ready...");
      return;
    }

    const latency = client.ws.ping;
    console.log(`💓 Keepalive ping (1min) – ${latency}ms`);

    if (client.isReady()) {
      try {
        client.user.setPresence({ status: "online" });
      } catch {}
    }

    const selfUrl =
      process.env.RENDER_EXTERNAL_URL || "https://discord-bot-atg4.onrender.com";
    await fetchLazy(selfUrl).then(() =>
      console.log("🌍 Self-ping sent to keep instance awake")
    );
  } catch (err) {
    console.error("Ping task error (ignored):", err?.message || err);
  }
}, 60 * 1000);

// ---------- watchdog: reconnect only when truly disconnected ----------
setInterval(() => {
  const s = client.ws?.status;
  if (s === Status.Disconnected) {
    console.warn("🛠️ Watchdog: Disconnected → safe re-login");
    safeLogin("watchdog");
  }
}, 45 * 1000);

// ---------- events ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

client.on("invalidated", () => {
  console.warn("🚫 Session invalidated → safe re-login");
  safeLogin("invalidated");
});

client.on("error", (e) => {
  console.error("⚙️ Discord client error:", e?.message || e);
  // 여기선 강제 재로그인 호출하지 않음(자동 재연결에 맡김)
});

client.on("shardReconnecting", (_, id) => {
  console.warn(`♻️ Shard ${id} reconnecting...`);
});
client.on("shardResume", (_, id) => {
  console.log(`🔗 Shard ${id} resumed`);
});

// ---------- spoiler relay ----------
client.on("messageCreate", async (msg) => {
  try {
    // 세션 준비 전/재로그인 공백 보호
    if (!client.isReady()) return;

    // 스레드는 처리 안 함(요청사항), 지정 채널만
    if (msg.author.bot || msg.channel.id !== SPOILER_CHANNEL_ID) return;

    const me = msg.guild.members.me;
    const perms = msg.channel.permissionsFor(me);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (!perms || !perms.has(required, true)) return;

    const canManage = perms.has(PermissionFlagsBits.ManageMessages, true);
    const canAttach = perms.has(PermissionFlagsBits.AttachFiles, true);

    const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
    const text = (msg.content ?? "").trim();

    // 이미 스포일러면 중복 감싸지 않음
    const alreadySpoiled = /^(\|\|)[\s\S]*\1$/.test(text);
    const spoilerText = text ? (alreadySpoiled ? text : `||${text}||`) : "";

    // 첨부 재업로드(스포일러 파일명)
    const files = [];
    for (const [, att] of msg.attachments) {
      if (!canAttach) continue;
      const res = await fetchLazy(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.name}` }));
    }

    if (!spoilerText && files.length === 0) return;

    await msg.channel.send({ content: `${prefix}${spoilerText}`, files });

    if (canManage) {
      await msg.delete().catch(() => {});
    }
  } catch (err) {
    console.error("💥 Message handler error:", err?.message || err);
  }
});

// ---------- hardening ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));

// ---------- start ----------
loginBot();
setInterval(
  () => console.log("⏱️ heartbeat – bot should be alive"),
  10 * 60 * 1000
);
