const API_ROOT = "https://api.telegram.org";

async function callTelegram(token, method, parameters = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout((parameters.timeout ?? 0) * 1_000 + 45_000),
    });
  } catch {
    throw new Error("Не удалось связаться с Telegram. Проверьте интернет и повторите попытку.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Telegram вернул ответ, который не удалось прочитать.");
  }
  if (!response.ok || !body.ok) {
    const description = typeof body.description === "string" ? body.description : `HTTP ${response.status}`;
    throw new Error(`Telegram API ${method}: ${description}`);
  }
  return body.result;
}

export function checkTelegramToken(token) {
  return callTelegram(token, "getMe");
}

export async function verifyTelegramSetup(token) {
  const me = await checkTelegramToken(token);
  if (!me.can_connect_to_business) {
    throw new Error(
      "У этого бота не включён Business Mode. В @BotFather выполните /setbusinessmode, " +
        "выберите своего бота, включите режим и повторите запуск.",
    );
  }

  const webhook = await callTelegram(token, "getWebhookInfo");
  if (webhook.url) {
    throw new Error(
      "Для этого бота уже настроен webhook. Я не удалял его автоматически. " +
        "Отключите webhook у старого приложения, затем запустите bash start.sh снова.",
    );
  }
  return me;
}

export async function getUpdates(token, offset, timeout = 30) {
  const parameters = {
    timeout,
    allowed_updates: JSON.stringify(["business_connection", "business_message"]),
  };
  if (Number.isInteger(offset) && offset >= 0) parameters.offset = offset;
  return callTelegram(token, "getUpdates", parameters);
}

export async function sendBusinessReply(token, connectionId, chatId, text, replyToMessageId) {
  const chunks = splitForTelegram(text);
  for (const [index, chunk] of chunks.entries()) {
    const parameters = {
      business_connection_id: connectionId,
      chat_id: chatId,
      text: chunk,
    };
    if (index === 0 && Number.isInteger(replyToMessageId)) {
      parameters.reply_parameters = { message_id: replyToMessageId };
    }
    await callTelegram(token, "sendMessage", {
      ...parameters,
    });
  }
}

function splitForTelegram(text) {
  const maxLength = 4_000;
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
