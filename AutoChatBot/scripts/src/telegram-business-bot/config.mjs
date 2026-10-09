import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { StringDecoder } from "node:string_decoder";

export const DATA_DIR = path.resolve(".telegram-business-bot");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const STATE_PATH = path.join(DATA_DIR, "state.json");
export const DEFAULT_MODEL = "qwen2.5:0.5b";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

const DEFAULT_INSTRUCTIONS =
  "Отвечай коротко и по-человечески, обычно 1–3 предложениями. " +
  "Используй язык последнего сообщения. Пиши от моего имени, но не выдумывай факты, " +
  "обещания или договорённости. Если данных не хватает — задай короткий уточняющий вопрос. " +
  "Если собеседник прямо спросит, сообщи, что это автоматический помощник.";

function looksLikeTelegramToken(value) {
  return typeof value === "string" && /^\d{5,}:[A-Za-z0-9_-]{25,}$/.test(value);
}

function makePromptReader() {
  return readline.createInterface({ input: stdin, output: stdout });
}

export async function ask(question, defaultValue = "") {
  if (!stdin.isTTY) {
    throw new Error("Первый запуск требует интерактивного терминала. Запустите bash start.sh в терминале.");
  }

  const rl = makePromptReader();
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

export async function askSecret(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Для безопасного ввода токена нужен интерактивный терминал.");
  }

  stdout.write(`${question} (ввод скрыт): `);
  const decoder = new StringDecoder("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const previousRawMode = stdin.isRaw;

    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(previousRawMode));
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      const input = decoder.write(chunk);
      for (const character of input) {
        if (character === "\u0003") {
          finish(new Error("Ввод отменён."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Файл ${path.basename(filePath)} повреждён. Запустите bash start.sh --reconfigure.`);
    }
    throw error;
  }
}

export async function savePrivateJson(filePath, value) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Настройки бота не распознаны.");
  if (typeof config.botToken !== "string" || !config.botToken.trim()) {
    throw new Error("В сохранённых настройках нет токена Telegram.");
  }
  if (typeof config.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(config.model)) {
    throw new Error("Некорректное имя модели Ollama.");
  }
  if (looksLikeTelegramToken(config.model)) {
    throw new Error("В настройках токен Telegram сохранён вместо модели Ollama. Запустите bash start.sh --reconfigure.");
  }
  if (typeof config.ollamaUrl !== "string" || !/^https?:\/\//.test(config.ollamaUrl)) {
    throw new Error("Некорректный адрес Ollama.");
  }
  if (typeof config.instructions !== "string" || !config.instructions.trim()) {
    throw new Error("Инструкция для ИИ не может быть пустой.");
  }
}

export async function loadOrCreateConfig(args, validateTelegramToken) {
  const forceReconfigure = args.includes("--reconfigure");
  let existing = await readJsonFile(CONFIG_PATH, null);

  if (existing && !forceReconfigure && stdin.isTTY) {
    const reuse = await ask("Использовать сохранённые настройки? [Y/n]", "Y");
    if (/^(?:y|yes|д|да)$/i.test(reuse)) {
      validateConfig(existing);
      return existing;
    }
  } else if (existing && !forceReconfigure && !stdin.isTTY) {
    validateConfig(existing);
    return existing;
  }

  stdout.write("\nПервый запуск. Токен вводится скрыто и сохраняется только на этой машине.\n");
  stdout.write("Создайте бота через @BotFather и включите для него Business Mode.\n\n");

  const botToken = await askSecret("Токен бота от @BotFather");
  if (!botToken) throw new Error("Токен не может быть пустым.");

  const savedModel = existing?.model;
  const defaultModel =
    forceReconfigure || looksLikeTelegramToken(savedModel) ? DEFAULT_MODEL : savedModel ?? DEFAULT_MODEL;
  const model = await ask(
    "Модель Ollama (0.5B — самая лёгкая; ответы могут быть проще)",
    defaultModel,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new Error("Имя модели может содержать только латинские буквы, цифры и . _ : / -");
  }
  if (looksLikeTelegramToken(model)) {
    throw new Error("Похоже, сюда введён токен Telegram, а не имя модели. Оставьте qwen2.5:0.5b или выберите модель Ollama.");
  }

  const instructions = await ask(
    "Как ИИ должен отвечать (Enter — настройки по умолчанию)",
    existing?.instructions ?? DEFAULT_INSTRUCTIONS,
  );

  const config = {
    botToken,
    model,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    instructions,
  };
  validateConfig(config);

  stdout.write("Проверяю токен Telegram...\n");
  await validateTelegramToken(botToken);

  await savePrivateJson(CONFIG_PATH, config);
  stdout.write(`Настройки сохранены с правами только для вашего пользователя: ${CONFIG_PATH}\n`);
  return config;
}

export async function updateState(state) {
  await savePrivateJson(STATE_PATH, state);
}
