import 'dotenv/config';
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';

const DISCORD_TAG = 'discord';
const DEFAULT_PUBLIC_APP_URL = 'https://ddraw.ca';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const GALLERY_READY_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

let client = null;
let roomManager = null;
let readyPromise = null;

function getPublicAppUrl() {
  return (process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || DEFAULT_PUBLIC_APP_URL).replace(/\/+$/, '');
}

function getGalleryUrl(item) {
  return `${getPublicAppUrl()}/gallery/${encodeURIComponent(item.id)}`;
}

function hasDiscordTag(item) {
  return Array.isArray(item?.tags) && item.tags.includes(DISCORD_TAG);
}

function getReadyTimeoutMs() {
  const configured = Number(process.env.DISCORD_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_READY_TIMEOUT_MS;
}

function wait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function withTimeout(promise, timeoutMs) {
  if (!promise) return null;
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => null)
  ]);
}

function waitForClientReadyEvent(activeClient, timeoutMs) {
  if (!activeClient || timeoutMs <= 0) return Promise.resolve(null);
  if (activeClient.isReady?.()) return Promise.resolve(activeClient);

  return new Promise(resolve => {
    let settled = false;
    let timer = null;

    const finish = (bot) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeClient.off?.('ready', onReady);
      activeClient.off?.('shardReady', onShardReady);
      activeClient.off?.('invalidated', onInvalidated);
      resolve(bot?.isReady?.() ? bot : null);
    };

    const onReady = () => finish(activeClient);
    const onShardReady = () => {
      if (activeClient.isReady?.()) finish(activeClient);
    };
    const onInvalidated = () => finish(null);

    timer = setTimeout(() => finish(activeClient), timeoutMs);
    timer.unref?.();

    activeClient.once?.('ready', onReady);
    activeClient.on?.('shardReady', onShardReady);
    activeClient.once?.('invalidated', onInvalidated);
  });
}

async function getReadyDiscordClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? getReadyTimeoutMs();
  if (client?.isReady?.()) return client;

  const startedAt = Date.now();
  if (!client && !readyPromise && options.startIfNeeded !== false) {
    const bot = await withTimeout(initDiscordBot(), timeoutMs);
    if (bot?.isReady?.()) return bot;
  }

  if (client?.isReady?.()) return client;

  if (readyPromise) {
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const bot = await withTimeout(readyPromise, remaining || timeoutMs);
    if (bot?.isReady?.()) return bot;
  }

  const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
  return waitForClientReadyEvent(client, remaining);
}

function scheduleGalleryRetry(item, attempt) {
  const delayMs = GALLERY_READY_RETRY_DELAYS_MS[attempt];
  if (!delayMs) return false;

  console.warn(`[Discord] Gallery post delayed: bot is not ready; retrying in ${Math.round(delayMs / 1000)}s`);
  const timer = setTimeout(() => {
    postGalleryItemToDiscord(item, { attempt: attempt + 1 }).catch(err => {
      console.error('[Discord] Gallery post retry failed:', err);
    });
  }, delayMs);
  timer.unref?.();
  return true;
}

function getPublicRooms() {
  if (!roomManager) return [];
  return roomManager
    .getRoomList(false)
    .filter(room => !room.locked && room.userCount > 0)
    .sort((a, b) => b.userCount - a.userCount || a.id.localeCompare(b.id));
}

function formatStatusText() {
  const rooms = getPublicRooms();
  const activeUsers = rooms.reduce((sum, room) => sum + room.userCount, 0);

  if (rooms.length === 0) {
    return 'No public rooms are active right now.';
  }

  const roomLines = rooms
    .slice(0, 10)
    .map(room => `- ${room.id}: ${room.userCount} user${room.userCount === 1 ? '' : 's'}`);
  const remaining = rooms.length > roomLines.length
    ? `\n...and ${rooms.length - roomLines.length} more room${rooms.length - roomLines.length === 1 ? '' : 's'}.`
    : '';

  return `Currently drawing: ${activeUsers} user${activeUsers === 1 ? '' : 's'} across ${rooms.length} public room${rooms.length === 1 ? '' : 's'}.\n${roomLines.join('\n')}${remaining}`;
}

async function registerCommands() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) return;

  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show active public Ddraw rooms.')
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(`[Discord] Registered slash commands${guildId ? ` for guild ${guildId}` : ' globally'}`);
}

export async function initDiscordBot(options = {}) {
  if (client?.isReady?.()) return client;
  if (readyPromise) return readyPromise;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('[Discord] Bot disabled: DISCORD_BOT_TOKEN is not set');
    return null;
  }

  roomManager = options.roomManager || roomManager;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  readyPromise = new Promise((resolve) => {
    client.once('ready', async () => {
      console.log(`[Discord] Logged in as ${client.user.tag}`);
      try {
        await registerCommands();
      } catch (err) {
        if (err?.code === 50001) {
          console.warn('[Discord] Skipping slash command registration: bot is missing access to DISCORD_GUILD_ID. Invite the bot to that guild or clear DISCORD_GUILD_ID for global command registration.');
          resolve(client);
          return;
        }
        console.error('[Discord] Failed to register slash commands:', err);
      }

      resolve(client);
    });

    client.login(token).catch(err => {
      console.error('[Discord] Login failed:', err);
      client?.destroy?.();
      client = null;
      readyPromise = null;
      resolve(null);
    });
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'status') return;

    try {
      await interaction.reply({
        content: formatStatusText(),
        ephemeral: false
      });
    } catch (err) {
      console.error('[Discord] Failed to reply to /status:', err);
    }
  });

  client.on('error', err => {
    console.error('[Discord] Client error:', err);
  });

  return readyPromise;
}

export function setDiscordRoomManager(nextRoomManager) {
  roomManager = nextRoomManager;
}

export async function postGalleryItemToDiscord(item, options = {}) {
  if (!hasDiscordTag(item)) return;

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn('[Discord] Skipping gallery post: DISCORD_BOT_TOKEN is not set');
    return;
  }

  const channelId = process.env.DISCORD_GALLERY_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Discord] Skipping gallery post: DISCORD_GALLERY_CHANNEL_ID is not set');
    return;
  }

  const bot = await getReadyDiscordClient();
  if (!bot?.isReady?.()) {
    if (scheduleGalleryRetry(item, options.attempt || 0)) return;
    console.warn('[Discord] Skipping gallery post: bot is not ready');
    return;
  }

  try {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      console.warn(`[Discord] Gallery channel ${channelId} is not text-based`);
      return;
    }

    const title = item.title || 'Untitled';
    const galleryUrl = getGalleryUrl(item);
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setURL(galleryUrl)
      .setDescription(`by ${item.author || 'Anonymous'}`)
      .setImage(item.url)
      .setThumbnail(item.thumbUrl || item.url)
      .setColor(0x8ad7ff)
      .setTimestamp(item.createdAt ? new Date(item.createdAt) : new Date());

    await channel.send({
      content: `New Ddraw gallery post: ${galleryUrl}`,
      embeds: [embed]
    });
  } catch (err) {
    console.error('[Discord] Failed to post gallery item:', err);
  }
}

export async function postReleaseUpdateToDiscord(versionInfo) {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn('[Discord] Skipping release update: DISCORD_BOT_TOKEN is not set');
    return false;
  }

  const channelId = process.env.DISCORD_UPDATES_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Discord] Skipping release update: DISCORD_UPDATES_CHANNEL_ID is not set');
    return false;
  }

  const bot = await getReadyDiscordClient();
  if (!bot?.isReady?.()) {
    console.warn('[Discord] Skipping release update: bot is not ready');
    return false;
  }

  const latest = String(versionInfo?.latest || '').trim();
  if (!latest) {
    console.warn('[Discord] Skipping release update: missing latest version');
    return false;
  }

  try {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      console.warn(`[Discord] Updates channel ${channelId} is not text-based`);
      return false;
    }

    const notes = String(versionInfo?.notes || '').trim() || 'No release notes provided.';
    const downloadUrl = String(versionInfo?.downloadUrl || getPublicAppUrl()).trim();
    const releaseDate = versionInfo?.releaseDate ? new Date(versionInfo.releaseDate) : new Date();

    const embed = new EmbedBuilder()
      .setTitle(`Ddraw ${latest}`)
      .setURL(downloadUrl)
      .setDescription(notes.slice(0, 4000))
      .setColor(0x00d4aa)
      .setTimestamp(Number.isNaN(releaseDate.getTime()) ? new Date() : releaseDate);

    await channel.send({
      content: `Ddraw ${latest} is live.`,
      embeds: [embed]
    });
    return true;
  } catch (err) {
    console.error('[Discord] Failed to post release update:', err);
    return false;
  }
}
