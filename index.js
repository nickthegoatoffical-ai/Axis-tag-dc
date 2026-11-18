// ===================== GUARDIAN BOT =====================
// Anti-spam, anti-@-spam, anti-nuke, ghosttime, auto mod-logs channel.
// Paste your bot token on the TOKEN line below. That's the only setup.

const TOKEN = process.env.DISCORD_TOKEN || "MTUwMTAxODkzNDcxMzkwOTM0OQ.GPo3ER.jzg02fFvDSO5nylUfow8wbgNd9e4V23PhqUZLw";

// ---------- settings (edit freely) ----------
const CFG = {
  LOG_CHANNEL_NAME: "modlogs",        // auto-created if missing
  SPAM_MESSAGES: 10,                  // this many messages...
  SPAM_WINDOW_MS: 5000,               // ...inside this window = spam
  TIMEOUT_MS: 24 * 60 * 60 * 1000,    // 1 day timeout
  MENTION_LIMIT_PER_MSG: 5,           // users+roles mentioned in ONE message
  MENTION_LIMIT_WINDOW: 8,            // total mentions inside the window below
  MENTION_WINDOW_MS: 10000,
  NUKE_LIMIT: 3,                      // destructive actions...
  NUKE_WINDOW_MS: 10000,              // ...inside this window = nuke
  PUNISH_HUMAN_NUKERS: false,         // true = also ban non-bot nukers (never the server owner)
  EXEMPT_STAFF_FROM_SPAM: true,       // staff (Manage Messages / Admin) skip spam checks
};

const fs = require("fs");
const path = require("path");
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType,
  AuditLogEvent, EmbedBuilder, REST, Routes, SlashCommandBuilder,
} = require("discord.js");

if (!TOKEN || TOKEN.startsWith("PASTE_")) {
  console.error("Put your bot token on the TOKEN line at the top of index.js");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- tiny persistent store for ghosttime ----------
const STORE = path.join(__dirname, "ghost.json");
let ghost = {}; // { guildId: [userId, ...] }
try { ghost = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { ghost = {}; }
const saveGhost = () => { try { fs.writeFileSync(STORE, JSON.stringify(ghost)); } catch (e) { console.error("save failed", e.message); } };
const isGhosted = (g, u) => (ghost[g] || []).includes(u);

// ---------- logging ----------
async function getLogChannel(guild) {
  let ch = guild.channels.cache.find(c => c.name === CFG.LOG_CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (ch) return ch;
  try {
    ch = await guild.channels.create({
      name: CFG.LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: "Guardian Bot moderation logs",
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
      ],
      reason: "Guardian Bot auto-created log channel",
    });
    return ch;
  } catch (e) { console.error(`[${guild.name}] cannot create log channel:`, e.message); return null; }
}
async function log(guild, title, desc, color = 0xff4141) {
  const ch = await getLogChannel(guild);
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp()] }).catch(() => {});
}

// ---------- helpers ----------
const isStaff = m => m && m.permissions.has(PermissionFlagsBits.ManageMessages) ;
const bucket = (map, key, windowMs) => {
  const now = Date.now();
  const arr = (map.get(key) || []).filter(t => now - t.t < windowMs);
  map.set(key, arr);
  return arr;
};

// ---------- anti spam + anti @ spam + ghosttime ----------
const msgHist = new Map();     // key -> [{t, id, ch}]
const mentionHist = new Map(); // key -> [{t, n}]
const punishing = new Set();

async function punishSpammer(message, reason, history) {
  const key = `${message.guild.id}:${message.author.id}`;
  if (punishing.has(key)) return;
  punishing.add(key);
  setTimeout(() => punishing.delete(key), 15000);

  const member = message.member;
  let result = "timed out for 1 day";
  try { await member.timeout(CFG.TIMEOUT_MS, reason); }
  catch (e) { result = `could NOT time out (${e.message}). Move my role above theirs.`; }

  // clean up their recent messages
  for (const h of (history || [])) {
    const ch = message.guild.channels.cache.get(h.ch);
    if (ch) ch.messages.delete(h.id).catch(() => {});
  }
  log(message.guild, "🚫 Auto-mod", `**User:** ${message.author} (\`${message.author.id}\`)\n**Reason:** ${reason}\n**Action:** ${result}`);
}

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot || !message.member) return;

  // ghosttime: delete instantly
  if (isGhosted(message.guild.id, message.author.id)) {
    message.delete().catch(() => {});
    return;
  }
  if (CFG.EXEMPT_STAFF_FROM_SPAM && isStaff(message.member)) return;

  const key = `${message.guild.id}:${message.author.id}`;

  // anti spam
  const hist = bucket(msgHist, key, CFG.SPAM_WINDOW_MS);
  hist.push({ t: Date.now(), id: message.id, ch: message.channel.id });
  if (hist.length >= CFG.SPAM_MESSAGES) {
    const copy = hist.slice(); msgHist.set(key, []);
    return punishSpammer(message, `Spam: ${copy.length} messages in under ${CFG.SPAM_WINDOW_MS / 1000}s`, copy);
  }

  // anti @ spam
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  const everyone = message.mentions.everyone && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone);
  const mh = bucket(mentionHist, key, CFG.MENTION_WINDOW_MS);
  if (mentions) mh.push({ t: Date.now(), n: mentions });
  const total = mh.reduce((a, b) => a + b.n, 0);
  if (mentions >= CFG.MENTION_LIMIT_PER_MSG || total >= CFG.MENTION_LIMIT_WINDOW || everyone) {
    mentionHist.set(key, []);
    message.delete().catch(() => {});
    return punishSpammer(message, `Mention spam (${mentions} in one message, ${total} recently${everyone ? ", @everyone/@here" : ""})`, []);
  }
});

// ---------- anti nuke ----------
const nukeHist = new Map(); // guildId:executorId -> [{t}]
const banned = new Set();

async function executorOf(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find(e => (!targetId || e.targetId === targetId) && Date.now() - e.createdTimestamp < 8000);
    return entry ? entry.executor : null;
  } catch { return null; }
}

async function countAction(guild, type, targetId, label) {
  const exec = await executorOf(guild, type, targetId);
  if (!exec || exec.id === client.user.id || exec.id === guild.ownerId) return;

  const key = `${guild.id}:${exec.id}`;
  const h = bucket(nukeHist, key, CFG.NUKE_WINDOW_MS);
  h.push({ t: Date.now() });
  if (h.length < CFG.NUKE_LIMIT || banned.has(key)) return;

  if (!exec.bot && !CFG.PUNISH_HUMAN_NUKERS) {
    banned.add(key); setTimeout(() => banned.delete(key), 60000);
    return log(guild, "⚠️ Possible nuke by a human", `${exec} (\`${exec.id}\`) did ${h.length} destructive actions (${label}) in ${CFG.NUKE_WINDOW_MS / 1000}s. Not auto-banned (PUNISH_HUMAN_NUKERS is off).`, 0xffa500);
  }
  banned.add(key); setTimeout(() => banned.delete(key), 60000);

  let result = "";
  try {
    const member = await guild.members.fetch(exec.id).catch(() => null);
    // strip dangerous roles first so it can't keep going while the ban lands
    if (member) await member.roles.set([], "Anti-nuke").catch(() => {});
    await guild.members.ban(exec.id, { reason: `Anti-nuke: ${h.length} destructive actions (${label}) in ${CFG.NUKE_WINDOW_MS / 1000}s`, deleteMessageSeconds: 0 });
    result = "🔨 **Banned instantly** (roles stripped first).";
  } catch (e) { result = `❌ Could not ban: ${e.message}. Put my role at the very top of the role list.`; }

  log(guild, "🛡️ ANTI-NUKE TRIGGERED", `**Executor:** ${exec.bot ? "🤖 bot" : "👤 user"} ${exec} (\`${exec.id}\`)\n**Last action:** ${label}\n**Count:** ${h.length} in ${CFG.NUKE_WINDOW_MS / 1000}s\n${result}`);
}

client.on("channelDelete", ch => ch.guild && countAction(ch.guild, AuditLogEvent.ChannelDelete, ch.id, `deleted channel #${ch.name}`));
client.on("channelCreate", ch => ch.guild && countAction(ch.guild, AuditLogEvent.ChannelCreate, ch.id, `created channel #${ch.name}`));
client.on("roleDelete", r => countAction(r.guild, AuditLogEvent.RoleDelete, r.id, `deleted role @${r.name}`));
client.on("roleCreate", r => countAction(r.guild, AuditLogEvent.RoleCreate, r.id, `created role @${r.name}`));
client.on("guildBanAdd", b => countAction(b.guild, AuditLogEvent.MemberBanAdd, b.user.id, `banned ${b.user.tag}`));
client.on("webhookUpdate", ch => ch.guild && countAction(ch.guild, AuditLogEvent.WebhookCreate, null, "created webhook"));

// make sure the log channel always exists
client.on("channelDelete", ch => { if (ch.guild && ch.name === CFG.LOG_CHANNEL_NAME) setTimeout(() => getLogChannel(ch.guild), 3000); });

// ---------- slash commands ----------
const P = PermissionFlagsBits;
const commands = [
  new SlashCommandBuilder().setName("ghosttime").setDescription("Every message this person sends is instantly deleted")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true)).setDefaultMemberPermissions(P.ManageMessages),
  new SlashCommandBuilder().setName("unghosttime").setDescription("Turn ghosttime off for someone")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true)).setDefaultMemberPermissions(P.ManageMessages),
  new SlashCommandBuilder().setName("ghostlist").setDescription("See who is in ghosttime").setDefaultMemberPermissions(P.ManageMessages),
  new SlashCommandBuilder().setName("purge").setDescription("Bulk delete recent messages")
    .addIntegerOption(o => o.setName("amount").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption(o => o.setName("user").setDescription("Only this user's messages")).setDefaultMemberPermissions(P.ManageMessages),
  new SlashCommandBuilder().setName("lock").setDescription("Lock this channel").setDefaultMemberPermissions(P.ManageChannels),
  new SlashCommandBuilder().setName("unlock").setDescription("Unlock this channel").setDefaultMemberPermissions(P.ManageChannels),
  new SlashCommandBuilder().setName("slowmode").setDescription("Set slowmode")
    .addIntegerOption(o => o.setName("seconds").setDescription("0 = off").setMinValue(0).setMaxValue(21600).setRequired(true)).setDefaultMemberPermissions(P.ManageChannels),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Minutes").setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")).setDefaultMemberPermissions(P.ModerateMembers),
  new SlashCommandBuilder().setName("untimeout").setDescription("Remove a timeout")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true)).setDefaultMemberPermissions(P.ModerateMembers),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")).setDefaultMemberPermissions(P.KickMembers),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member")
    .addUserOption(o => o.setName("user").setDescription("Who").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")).setDefaultMemberPermissions(P.BanMembers),
].map(c => c.toJSON());

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() || !i.guild) return;
  const reply = (content, ephemeral = true) => i.reply({ content, ephemeral }).catch(() => {});
  const user = i.options.getUser("user");
  const target = user ? await i.guild.members.fetch(user.id).catch(() => null) : null;
  const guard = () => {
    if (!target) { reply("❌ That person isn't in the server."); return false; }
    if (target.id === i.user.id) { reply("❌ Not yourself."); return false; }
    if (target.id === i.guild.ownerId) { reply("❌ Can't touch the owner."); return false; }
    if (i.user.id !== i.guild.ownerId && target.roles.highest.position >= i.member.roles.highest.position) { reply("❌ Their role is equal/higher than yours."); return false; }
    return true;
  };
  try {
    switch (i.commandName) {
      case "ghosttime": {
        if (!guard()) return;
        const list = (ghost[i.guild.id] ||= []);
        if (!list.includes(user.id)) list.push(user.id);
        saveGhost();
        reply(`👻 ${user} is now in **ghosttime**. Every message they send gets deleted.`, false);
        log(i.guild, "👻 Ghosttime ON", `${user} by ${i.user}`, 0x8888ff); break;
      }
      case "unghosttime": {
        ghost[i.guild.id] = (ghost[i.guild.id] || []).filter(x => x !== user.id);
        saveGhost();
        reply(`✅ ${user} is out of ghosttime.`, false);
        log(i.guild, "👻 Ghosttime OFF", `${user} by ${i.user}`, 0x55cc88); break;
      }
      case "ghostlist": {
        const l = ghost[i.guild.id] || [];
        reply(l.length ? l.map(x => `<@${x}>`).join("\n") : "Nobody is in ghosttime."); break;
      }
      case "purge": {
        await i.deferReply({ ephemeral: true });
        let msgs = await i.channel.messages.fetch({ limit: 100 });
        if (user) msgs = msgs.filter(m => m.author.id === user.id);
        const del = await i.channel.bulkDelete([...msgs.values()].slice(0, i.options.getInteger("amount")), true);
        i.editReply(`🧹 Deleted ${del.size} messages.`);
        log(i.guild, "🧹 Purge", `${i.user} deleted ${del.size} in ${i.channel}`, 0x5599ff); break;
      }
      case "lock": case "unlock": {
        const lock = i.commandName === "lock";
        await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: lock ? false : null });
        reply(lock ? "🔒 Channel locked." : "🔓 Channel unlocked.", false);
        log(i.guild, lock ? "🔒 Lock" : "🔓 Unlock", `${i.channel} by ${i.user}`, 0x5599ff); break;
      }
      case "slowmode": {
        const s = i.options.getInteger("seconds");
        await i.channel.setRateLimitPerUser(s);
        reply(s ? `🐌 Slowmode ${s}s.` : "Slowmode off.", false); break;
      }
      case "timeout": {
        if (!guard()) return;
        const mins = i.options.getInteger("minutes"), why = i.options.getString("reason") || "No reason";
        await target.timeout(mins * 60000, `${why} (by ${i.user.tag})`);
        reply(`⏳ ${user} timed out for ${mins} min.`, false);
        log(i.guild, "⏳ Timeout", `${user} for ${mins}m by ${i.user}\n${why}`, 0xffa500); break;
      }
      case "untimeout": {
        if (!guard()) return;
        await target.timeout(null);
        reply(`✅ ${user} timeout removed.`, false); break;
      }
      case "kick": {
        if (!guard()) return;
        const why = i.options.getString("reason") || "No reason";
        await target.kick(`${why} (by ${i.user.tag})`);
        reply(`👢 Kicked ${user.tag}.`, false);
        log(i.guild, "👢 Kick", `${user.tag} by ${i.user}\n${why}`, 0xffa500); break;
      }
      case "ban": {
        if (!guard()) return;
        const why = i.options.getString("reason") || "No reason";
        await target.ban({ reason: `${why} (by ${i.user.tag})` });
        reply(`🔨 Banned ${user.tag}.`, false);
        log(i.guild, "🔨 Ban", `${user.tag} by ${i.user}\n${why}`); break;
      }
    }
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message}`;
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {}); else reply(msg);
  }
});

// ---------- startup ----------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
  client.user.setActivity("over the server 🛡️");
  try { await new REST({ version: "10" }).setToken(TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands }); console.log("Slash commands registered"); }
  catch (e) { console.error("command registration failed", e.message); }
  for (const g of client.guilds.cache.values()) getLogChannel(g);
});
client.on("guildCreate", g => getLogChannel(g));
process.on("unhandledRejection", e => console.error("unhandled", e));

client.login(TOKEN);
