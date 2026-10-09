import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw new Error("Не удалось подключиться к Ollama. Проверьте, что Ollama запущена.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Ollama вернула ответ, который не удалось прочитать.");
  }
  if (!response.ok) {
    throw new Error(body?.error || `Ollama вернула ошибку HTTP ${response.status}.`);
  }
  return body;
}

export function isOllamaInstalled() {
  const result = spawnSync("ollama", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

async function isServerReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureOllama(baseUrl, model) {
  if (!isOllamaInstalled()) {
    throw new Error(
      "Команда ollama не найдена. Установите Ollama с https://ollama.com/download, " +
        "запустите её и снова выполните bash start.sh.",
    );
  }

  if (!(await isServerReady(baseUrl))) {
    process.stdout.write("Запускаю локальный сервер Ollama...\n");
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await isServerReady(baseUrl)) {
        ready = true;
        break;
      }
      await delay(1_000);
    }
    if (!ready) {
      throw new Error(
        "Сервер Ollama не запустился. Откройте отдельный терминал, выполните `ollama serve` и повторите запуск.",
      );
    }
  }

  const tags = await requestJson(`${baseUrl}/api/tags`);
  const models = Array.isArray(tags.models) ? tags.models : [];
  const modelExists = models.some((entry) => entry.name === model || entry.model === model);

  if (!modelExists) {
    process.stdout.write(`Загружаю модель ${model} в Ollama. Это делается один раз и может занять время.\n`);
    await new Promise((resolve, reject) => {
      const child = spawn("ollama", ["pull", model], { stdio: "inherit" });
      child.once("error", () => reject(new Error("Не удалось запустить `ollama pull`.")));
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Ollama не смогла загрузить модель (код ${code ?? "неизвестен"}).`));
      });
    });
  }
}

export async function generateReply(config, conversation, incomingText) {
  const messages = [
    { role: "system", content: config.instructions },
    ...conversation,
    { role: "user", content: incomingText },
  ];

  const result = await requestJson(
    `${config.ollamaUrl}/api/chat`,
    {
      method: "POST",
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        options: { num_ctx: 3072, num_predict: 220 },
      }),
      timeoutMs: 120_000,
    },
  );

  const text = result?.message?.content?.trim();
  if (!text) throw new Error("Модель Ollama вернула пустой ответ.");
  return text;
}
