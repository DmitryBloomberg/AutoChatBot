import { setTimeout as delay } from "node:timers/promises";
import {
  CONFIG_PATH,
  STATE_PATH,
  loadOrCreateConfig,
  readJsonFile,
  updateState,
} from "./config.mjs";
import { ensureOllama, generateReply } from "./ollama.mjs";
import {
  checkTelegramToken,
  getUpdates,
  sendBusinessReply,
  verifyTelegramSetup,
} from "./telegram.mjs";

const MAX_CONTEXT_MESSAGES = 10;
const contextByChat = new Map();

function usage() {
  return `Usage:
  bash start.sh                 Start using saved settings or configure the bot
  bash start.sh --reconfigure   Enter a new bot token or change model/settings

Settings: ${CONFIG_PATH}
Local polling state: ${STATE_PATH}`;
}

function updateConnectionState(state, connection) {
  if (!connection?.id) return;
  state.connections ??= {};
  state.connections[connection.id] = {
    enabled: Boolean(connection.is_enabled),
    userChatId: connection.user_chat_id ?? null,
    canReply: connection.rights?.can_reply !== false,
  };
}

async function establishInitialOffset(token, state) {
  if (Number.isInteger(state.offset)) return;

  process.stdout.write("Проверяю очередь Telegram, чтобы не отвечать на старые сообщения...\n");
  let offset;
  for (let page = 0; page < 100; page += 1) {
    const updates = await getUpdates(token, offset, 0);
    if (!updates.length) break;

    for (const update of updates) {
      if (update.business_connection) updateConnectionState(state, update.business_connection);
      offset = Math.max(offset ?? 0, update.update_id + 1);
    }
    state.offset = offset;
    await updateState(state);
  }

  if (Number.isInteger(offset)) {
    state.offset = offset;
    await updateState(state);
  } else {
    state.offset = 0;
    await updateState(state);
  }
}

function getConnection(state, connectionId) {
  return state.connections?.[connectionId] ?? null;
}

function contextFor(key) {
  if (!contextByChat.has(key)) contextByChat.set(key, []);
  return contextByChat.get(key);
}

async function handleBusinessMessage(token, config, state, message) {
  const connectionId = message.business_connection_id;
  const sender = message.from;
  const chatId = message.chat?.id;
  const connection = getConnection(state, connectionId);

  if (!connectionId || !chatId || message.chat?.type !== "private") return;
  if (connection?.enabled === false || connection?.canReply === false) return;
  if (!sender || sender.is_bot || sender.id === connection?.userChatId) return;

  const incomingText = (message.text ?? message.caption ?? "").trim();
  if (!incomingText) {
    process.stdout.write("Пропущено сообщение без текста (например, стикер или голосовое).\n");
    return;
  }

  const contextKey = `${connectionId}:${chatId}`;
  const context = contextFor(contextKey);

  try {
    const reply = await generateReply(config, context, incomingText);
    await sendBusinessReply(token, connectionId, chatId, reply);
    context.push(
      { role: "user", content: incomingText },
      { role: "assistant", content: reply },
    );
    if (context.length > MAX_CONTEXT_MESSAGES) {
      context.splice(0, context.length - MAX_CONTEXT_MESSAGES);
    }
    process.stdout.write("Ответ отправлен.\n");
  } catch (error) {
    process.stderr.write(`Не удалось обработать сообщение: ${error.message}\n`);
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const state = await readJsonFile(STATE_PATH, { connections: {} });
  const config = await loadOrCreateConfig(process.argv.slice(2), checkTelegramToken);

  await verifyTelegramSetup(config.botToken);
  process.stdout.write("Проверяю Ollama и локальную модель...\n");
  await ensureOllama(config.ollamaUrl, config.model);
  await establishInitialOffset(config.botToken, state);

  process.stdout.write(
    `Бот запущен. Модель: ${config.model}. Остановить: Ctrl+C.\n` +
      "Ответы доступны только для текстовых сообщений и подписей к фото в подключённых личных чатах.\n",
  );

  let offset = state.offset;
  while (true) {
    let updates;
    try {
      updates = await getUpdates(config.botToken, offset);
    } catch (error) {
      process.stderr.write(`${error.message} Повторная попытка через 5 секунд.\n`);
      await delay(5_000);
      continue;
    }

    for (const update of updates) {
      try {
        if (update.business_connection) {
          updateConnectionState(state, update.business_connection);
        }
        if (update.business_message) {
          await handleBusinessMessage(config.botToken, config, state, update.business_message);
        }
        offset = update.update_id + 1;
        state.offset = offset;
        await updateState(state);
      } catch {
        process.stderr.write("Повторю обработку этого обновления через 5 секунд.\n");
        await delay(5_000);
        break;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Ошибка запуска: ${error.message}\n`);
  process.exitCode = 1;
});
