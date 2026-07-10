/**
 * run_refresh.ts - IG/Threads 長期トークンの自動リフレッシュ（毎週実行）
 *
 * 長期トークン(60日)は失効前ならリフレッシュAPIで新しい60日トークンに更新できる。
 * 毎週更新し続けることで実質無期限化し、手動再発行を不要にする。
 *
 * - Threads:   GET graph.threads.net/refresh_access_token?grant_type=th_refresh_token
 * - Instagram: GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *
 * 更新後のトークンは gh CLI (GH_PAT) で GitHub Secrets に書き戻す。
 * 注意: 発行から24時間未満のトークンはリフレッシュ不可（正常系として扱う）。
 */
import * as dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { notifyError, notifyReport } from "./notifiers";

const REPO = process.env.GITHUB_REPOSITORY ?? "meganeojisan1984-ctrl/rakuten-room-auto-system";

interface RefreshResult {
  name: string;
  ok: boolean;
  detail: string; // 有効期限 or エラー概要（トークン値は含めない）
}

/** 新トークンを保存し、保存先ラベルを返す */
function updateSecret(secretName: string, value: string): string {
  const ghPat = process.env.GH_PAT ?? "";
  if (ghPat) {
    execFileSync("gh", ["secret", "set", secretName, "-R", REPO], {
      input: value,
      env: { ...process.env, GH_TOKEN: ghPat },
      stdio: ["pipe", "inherit", "inherit"],
    });
    return "GitHub Secrets";
  }
  // ローカル実行時のフォールバック: .env の該当キーを更新
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error("GH_PAT も .env も無いため保存先がありません");
  }
  const env = fs.readFileSync(envPath, "utf-8");
  const pattern = new RegExp(`^${secretName}=.*$`, "m");
  const updated = pattern.test(env)
    ? env.replace(pattern, `${secretName}=${value}`)
    : env + `\n${secretName}=${value}\n`;
  fs.writeFileSync(envPath, updated);
  console.log(`[refresh] ${secretName} をローカル .env に保存（GH_PAT未設定のため）`);
  return "ローカル.env";
}

/** 24時間未満のトークン等、リフレッシュ不可だが異常ではないケースの判定 */
function isBenignError(msg: string): boolean {
  return /24 hours|too new|cannot be refreshed/i.test(msg);
}

async function refreshToken(
  name: string,
  url: string,
  grantType: string,
  token: string,
  secretName: string
): Promise<RefreshResult> {
  if (!token) {
    return { name, ok: true, detail: "未設定のためスキップ" };
  }
  try {
    const res = await axios.get<{ access_token: string; expires_in: number }>(url, {
      params: { grant_type: grantType, access_token: token },
      timeout: 30000,
    });
    const newToken = res.data.access_token;
    const days = Math.floor((res.data.expires_in ?? 0) / 86400);
    if (!newToken) throw new Error("リフレッシュ応答にaccess_tokenがありません");

    const savedTo = updateSecret(secretName, newToken);
    return { name, ok: true, detail: `更新成功（残り約${days}日 → ${savedTo}へ反映済み）` };
  } catch (err) {
    const msg = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message).slice(0, 300)
      : String(err).slice(0, 300);
    if (isBenignError(msg)) {
      return { name, ok: true, detail: "発行直後(24h未満)のためスキップ（次週更新）" };
    }
    return { name, ok: false, detail: msg };
  }
}

async function main(): Promise<void> {
  console.log("=== SNSトークン自動リフレッシュ 開始 ===");

  const results: RefreshResult[] = [];
  results.push(
    await refreshToken(
      "Threads",
      "https://graph.threads.net/refresh_access_token",
      "th_refresh_token",
      process.env.THREADS_ACCESS_TOKEN ?? "",
      "THREADS_ACCESS_TOKEN"
    )
  );
  results.push(
    await refreshToken(
      "Instagram",
      "https://graph.instagram.com/refresh_access_token",
      "ig_refresh_token",
      process.env.IG_ACCESS_TOKEN ?? "",
      "IG_ACCESS_TOKEN"
    )
  );

  for (const r of results) {
    console.log(`[refresh] ${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    await notifyError(
      "SNSトークン自動リフレッシュ失敗",
      failed.map((r) => `${r.name}: ${r.detail}`).join("\n") +
        "\n\n手動再発行が必要です。SETUP-SNS.md 冒頭の手順を参照してください。"
    );
    process.exit(1);
  }

  await notifyReport(
    "🔄 SNSトークン自動リフレッシュ完了",
    results.map((r) => `${r.name}: ${r.detail}`).join("\n")
  );
  console.log("=== 完了 ===");
}

main().catch(async (err) => {
  console.error("致命的エラー:", err);
  await notifyError("トークンリフレッシュ致命的エラー", String(err).slice(0, 400));
  process.exit(1);
});
