// ---------- deps ----------
const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

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

// ---------- login with retry ----------
async function loginBot() {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ Discord bot logged in successfully");
  } catch (err) {
    console.error("❌ Login failed:", err?.message || err);
    console.log("🔁 Retrying login in 10s...");
    setTimeout(loginBot, 10_000);
  }
}

// ---------- 30min forced re-login ----------
setInterval(() => {
  console.log("🔄 Auto re-login (30min refresh)");
  try { client.destroy(); } catch {}
  loginBot();
}, 30 * 60 * 1000);

// ---------- 1min keepalive (Discord + Render self-ping) ----------
const fetchLazy = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

setInterval(async () => {
  try {
    // ws 준비 안됐으면 건너뜀
    if (!client?.ws || typeof client.ws.ping !== "number") {
      console.log("💓 Keepalive ping (1min) – waiting for ws ready...");
      return;
    }

    const latency = client.ws.ping;
    console.log(`💓 Keepalive ping (1min) – ${latency}ms`);

    // presence 갱신(가벼운 패킷) → 게이트웨이 세션 유지
    if (client.isReady()) client.user.setPresence({ status: "online" });

    // Render가 idle로 보지 않도록 자기 자신에게 HTTP 요청
    const selfUrl =
      process.env.RENDER_EXTERNAL_URL || "https://discord-bot-atg4.onrender.com";
    await fetchLazy(selfUrl).then(() =>
      console.log("🌍 Self-ping sent to keep instance awake")
    );
  } catch (err) {
    // 초기화 타이밍 등에서는 조용히 통과
    console.error("Ping task error (ignored):", err?.message || err);
  }
}, 60 * 1000);

// ---------- events ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || msg.channel.id !== SPOILER_CHANNEL_ID) return;

    const me = await msg.guild.members.fetchMe();
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has(["ViewChannel", "SendMessages", "ReadMessageHistory"])) return;

    const canManage = perms.has("ManageMessages");
    const canAttach = perms.has("AttachFiles");

    const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
    const text = (msg.content ?? "").trim();
    const spoilerText = text ? `||${text}||` : "";

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
    if (canManage) await msg.delete().catch(() => {});
  } catch (err) {
    console.error("💥 Message handler error:", err?.message || err);
  }
});

// ---------- hardening ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));
client.on("error", (e) => {
  console.error("⚙️ Discord client error:", e?.message || e);
  setTimeout(loginBot, 5_000);
});
client.on("shardDisconnect", () => {
  console.warn("⚠️ Shard disconnected → re-login");
  setTimeout(loginBot, 5_000);
});

// ---------- start ----------
loginBot();
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
