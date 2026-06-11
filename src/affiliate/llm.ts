/**
 * llm.ts - Groq を用いた汎用LLMクライアント
 *
 * - JSON出力（{"items":[...]} 形式）を安定して取得
 * - レート制限への指数バックオフリトライ
 * - 大量出力はバッチ分割で安定生成（30投稿などをチャンクで生成）
 */
import Groq from "groq-sdk";
import * as dotenv from "dotenv";
dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const MODEL_NAME = process.env.AFFILIATE_LLM_MODEL ?? "llama-3.3-70b-versatile";

const REQUEST_INTERVAL_MS = 1500;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 4000;

export function isLlmConfigured(): boolean {
  return GROQ_API_KEY.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let client: Groq | null = null;
function getClient(): Groq {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY が未設定です。.env または GitHub Secrets に設定してください。");
  }
  if (!client) client = new Groq({ apiKey: GROQ_API_KEY });
  return client;
}

interface GenOpts {
  temperature?: number;
  maxTokens?: number;
  /** JSONモードを使う場合 true（プロンプトに "JSON" の語が必須） */
  json?: boolean;
}

async function chat(prompt: string, opts: GenOpts = {}, attempt = 0): Promise<string> {
  const { temperature = 0.85, maxTokens = 4096, json = false } = opts;
  try {
    const completion = await getClient().chat.completions.create({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      ...(json ? { response_format: { type: "json_object" as const } } : {}),
    });
    const text = completion.choices[0]?.message?.content ?? "";
    if (!text) throw new Error("Groq APIからの応答が空です");
    return text;
  } catch (err: unknown) {
    const msg = String(err);
    const isRateLimit = msg.includes("429") || /rate.?limit/i.test(msg);
    if (isRateLimit && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[llm] レート制限。${delay / 1000}秒後にリトライ (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return chat(prompt, opts, attempt + 1);
    }
    throw err;
  }
}

/** 自由テキストを生成 */
export async function generateText(prompt: string, opts: GenOpts = {}): Promise<string> {
  const text = await chat(prompt, opts);
  return text.trim();
}

/**
 * レスポンスから JSON を抽出してパース。
 * ```json ... ``` フェンスや前後の説明文が混ざっても可能な限り救出する。
 */
function extractJson(raw: string): unknown {
  let s = raw.trim();
  // コードフェンス除去
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  // 最初の { から最後の } までを抜き出す
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

/**
 * {"items": [...]} 形式のJSONを生成して items 配列を返す。
 * 失敗時は1度だけテキスト救出を試みる。
 */
export async function generateItems<T>(prompt: string, opts: GenOpts = {}): Promise<T[]> {
  const fullPrompt = `${prompt}

【出力形式（厳守）】
必ず次の構造の JSON のみを出力してください。前置き・説明・コードフェンスは一切不要です。
{"items": [ ... ]}`;
  const raw = await chat(fullPrompt, { ...opts, json: true });
  try {
    const parsed = extractJson(raw) as { items?: T[] } | T[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.items ?? [];
  } catch (err) {
    console.warn("[llm] JSONパース失敗、救出を試行:", String(err).slice(0, 120));
    const parsed = extractJson(raw) as { items?: T[] };
    return parsed.items ?? [];
  }
}

/**
 * 大量アイテムをバッチ分割で生成する。
 * @param buildPrompt (batchCount, alreadyHave) => prompt 文字列
 * @param total       目標件数
 * @param batchSize    1回あたりの生成件数
 */
export async function generateItemsBatched<T>(
  buildPrompt: (batchCount: number, produced: T[]) => string,
  total: number,
  batchSize: number,
  opts: GenOpts = {}
): Promise<T[]> {
  const produced: T[] = [];
  let guard = 0;
  while (produced.length < total && guard < Math.ceil(total / batchSize) + 2) {
    guard++;
    const need = Math.min(batchSize, total - produced.length);
    const items = await generateItems<T>(buildPrompt(need, produced), opts);
    if (items.length === 0) break;
    produced.push(...items);
    if (produced.length < total) await sleep(REQUEST_INTERVAL_MS);
  }
  return produced.slice(0, total);
}

/** 単発生成の間に挟む待機（連続呼び出しのレート制限対策） */
export function pace(): Promise<void> {
  return sleep(REQUEST_INTERVAL_MS);
}

export { MODEL_NAME };
