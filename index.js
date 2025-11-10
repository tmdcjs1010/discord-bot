const express = require("express");
const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("✅ Bot running + heartbeat alive"));
app.listen(PORT, () => console.log(`🌐 Web server on :${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const SPOILER_CHANNEL_ID = "1421086622773936300";

// ---------- 로그인 함수 ----------
async function loginBot() {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ Discord bot logged in successfully");
  } catch (err) {
    console.error("❌ Login failed:", err.message);
    console.log("🔁 Retrying login in 10s...");
    setTimeout(loginBot, 10000);
  }
}

// ---------- 30분마다 강제 재로그인 ----------
// ---------- 1분마다 ping (세션 유지용) ----------
setInterval(() => {
  try {
    if (!client || !client.ws) return; // 초기화 중일 땐 skip
    const latency = typeof client.ws.ping === "number" ? client.ws.ping : null;

    if (latency !== null) {
      console.log(`💓 Keepalive ping (1min) – ${latency}ms`);
    } else {
      console.log("💓 Keepalive ping (1min) – waiting for ws ready...");
    }

    if (client.isReady()) {
      client.user.setPresence({ status: "online" });
    }
  } catch (err) {
    // 이제 이 에러는 거의 안 뜸
    console.error("Ping check error (ignored):", err.message);
  }
}, 60 * 1000);

// ---------- 1분마다 ping (세션 유지용) ----------
setInterval(() => {
  try {
    client.ws.ping(); // 게이트웨이에 ping
    console.log("💓 Keepalive ping (1min)");
  } catch (err) {
    console.error("Ping error:", err.message);
  }
}, 60 * 1000);

// ---------- 디스코드 이벤트 ----------
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`🎯 Target channel: ${SPOILER_CHANNEL_ID}`);
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot || msg.channel.id !== SPOILER_CHANNEL_ID) return;

    const me = await msg.guild.members.fetchMe();
    const perms = msg.channel.permissionsFor(me);
    if (!perms?.has(["ViewChannel","SendMessages","ReadMessageHistory"])) return;

    const canManage = perms.has("ManageMessages");
    const canAttach = perms.has("AttachFiles");

    const prefix = `${msg.member?.displayName ?? msg.author.username}: `;
    const text = (msg.content ?? "").trim();
    const spoilerText = text ? `||${text}||` : "";

    const files = [];
    for (const [, att] of msg.attachments) {
      if (!canAttach) continue;
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      files.push(new AttachmentBuilder(buf, { name: `SPOILER_${att.name}` }));
    }

    if (!spoilerText && files.length === 0) return;
    await msg.channel.send({ content: `${prefix}${spoilerText}`, files });
    if (canManage) await msg.delete().catch(()=>{});
  } catch (err) {
    console.error("💥 Message handler error:", err.message);
  }
});

// ---------- 예외 처리 ----------
process.on("unhandledRejection", (r) => console.error("🚨 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("💥 Uncaught:", e));
client.on("error", (e) => {
  console.error("⚙️ Discord client error:", e.message);
  setTimeout(loginBot, 5000);
});
client.on("shardDisconnect", () => {
  console.warn("⚠️ Shard disconnected → re-login");
  setTimeout(loginBot, 5000);
});

loginBot();
setInterval(() => console.log("⏱️ heartbeat – bot should be alive"), 10 * 60 * 1000);
