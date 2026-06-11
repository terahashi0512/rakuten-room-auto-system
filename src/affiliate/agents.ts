/**
 * agents.ts - 10個のフローを実行するエージェント群
 *
 * 各エージェントはユーザー提示の元プロンプトを忠実に再現しつつ、
 * ◯◯ プレースホルダを案件コンテキスト（CampaignContext）で自動補完する。
 * 投稿系フローには「重複回避リスト」を渡し、既出と被らない内容を生成させる。
 */
import type {
  CampaignContext,
  CollectPost,
  ConceptCandidate,
  DiagnosisRubric,
  DmTemplate,
  EducationPost,
  GenreCandidate,
  Offer,
  OfferCopy,
  OfferProfile,
  PinnedPost,
  RoadmapDay,
  TargetCandidate,
} from "./types";
import { generateItems, generateItemsBatched } from "./llm";

const POST_RULE = "Xの投稿文は140〜280文字以内。AI感・広告感を出さず、自然な日本語で書くこと。";

function avoidBlock(avoid: string[]): string {
  if (avoid.length === 0) return "";
  const list = avoid.slice(0, 40).map((t, i) => `${i + 1}. ${t.slice(0, 60)}`).join("\n");
  return `\n\n【既出（重複厳禁・必ず別の切り口にすること）】\n${list}`;
}

// ──────────────────────────────────────────────
// フロー1: 売れるジャンル選定
// ──────────────────────────────────────────────
export async function runGenreSelection(offer: Offer, profile: OfferProfile): Promise<GenreCandidate[]> {
  const prompt = `あなたはX集客と高単価アフィリエイトに強いマーケターです。
私はXで集客し、人の高単価スクールの無料面談に送客してアフィリエイト報酬を得たいです。
販売したい案件は「${offer.name}」（ジャンル目安: ${profile.genre} / ${profile.rewardModel}）です。

この案件に関連して、売れやすいジャンルを20個出してください。

条件：
・1件あたりの報酬単価が高くなりやすい
・無料面談に誘導しやすい
・悩みが深い
・今すぐ解決したい欲求がある
・Xで発信しやすい
・初心者でも集客しやすい
・怪しくなりすぎない
・継続的に需要がある

各要素を持つオブジェクトを20件:
- genre: ジャンル名
- target: ターゲット
- pain: 抱えている悩み
- consultReason: 無料面談に行きたくなる理由
- xTheme: Xで伸びる発信テーマ
- appeal: 売れやすい訴求
- caution: 注意点`;
  return generateItems<GenreCandidate>(prompt, { temperature: 0.85, maxTokens: 6000 });
}

// ──────────────────────────────────────────────
// フロー2: 売れるターゲット設計
// ──────────────────────────────────────────────
export async function runTargetDesign(offer: Offer, profile: OfferProfile): Promise<TargetCandidate[]> {
  const prompt = `あなたは高単価商品の販売導線を作るプロです。
以下の商品を、Xで集客して無料面談に送客したいです。

商品ジャンル：${profile.genre}
商品名：${offer.name}
商品価格：${offer.price || profile.priceBand}
成果報酬：${offer.reward || profile.rewardModel}

この商品に最も反応しやすいターゲットを10パターン作ってください。

条件：
・悩みが深い
・お金を払ってでも解決したい
・無料面談に申し込みやすい
・X上に存在している
・発信で教育しやすい
・将来的に高単価商品を買う可能性が高い

各要素を持つオブジェクトを10件:
- name: ターゲット名
- ageRange: 年齢層
- pain: 現在の悩み
- idealFuture: 理想の未来
- whyNow: なぜ今すぐ変わりたいのか
- hitWords: 刺さる言葉
- missWords: 刺さらない言葉
- consultHook: 無料面談に誘導する切り口`;
  return generateItems<TargetCandidate>(prompt, { temperature: 0.85, maxTokens: 4000 });
}

// ──────────────────────────────────────────────
// フロー3: Xアカウントコンセプト
// ──────────────────────────────────────────────
export async function runConcept(ctx: CampaignContext): Promise<ConceptCandidate[]> {
  const prompt = `あなたはXで見込み客を集めるアカウント設計の専門家です。
私はXで集客し、高単価スクールの無料面談に送客するアフィリエイトを行います。

商品ジャンル：${ctx.chosenGenre.genre}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.ageRange}・${ctx.chosenTarget.pain}）

この商品を売るためのXアカウントコンセプトを10個作ってください。

条件：
・フォローする理由が明確
・無料面談に誘導しやすい
・専門家感が出る
・怪しすぎない
・毎日発信しやすい
・競合と差別化できる
・初心者でも運用しやすい

各要素を持つオブジェクトを10件:
- concept: アカウントコンセプト
- profileText: プロフィール文
- theme: 発信テーマ
- audience: 刺さるターゲット
- pinnedDirection: 固定ポストの方向性
- consultFunnel: 無料面談への導線
- differentiation: 競合との差別化ポイント`;
  return generateItems<ConceptCandidate>(prompt, { temperature: 0.85, maxTokens: 4000 });
}

// ──────────────────────────────────────────────
// フロー4: 見込み客を集めるX投稿 30個（バッチ生成 + 重複回避）
// ──────────────────────────────────────────────
const COLLECT_TYPES = [
  "常識破壊型", "失敗談型", "チェックリスト型", "比較型",
  "知らないと損する型", "放置リスク型", "成功者の共通点型", "初心者向けロードマップ型",
];

export async function runCollectPosts(ctx: CampaignContext, total = 30, avoid: string[] = []): Promise<CollectPost[]> {
  const build = (n: number, produced: CollectPost[]): string =>
    `あなたはXで見込み客を集める投稿作成のプロです。
以下の商品ジャンルの無料面談に送客するために、X投稿を${n}個作ってください。

商品ジャンル：${ctx.chosenGenre.genre}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.pain}）
無料面談で得られること：${ctx.consultBenefits}

条件：
・売り込み感を出さない
・悩みを言語化する
・読者に「自分のことだ」と思わせる
・無料面談に興味を持たせる
・保存されやすい
・共感されやすい
・${POST_RULE}

投稿の型（type にいずれかを設定し、全体でバランスよく使う）：
${COLLECT_TYPES.join(" / ")}

各要素を持つオブジェクトを${n}件:
- type: 投稿の型
- text: 投稿文（140〜280文字）
- psychology: 狙っている心理
- consultLink: 無料面談につながる理由${avoidBlock([...avoid, ...produced.map((p) => p.text)])}`;
  return generateItemsBatched<CollectPost>(build, total, 10, { temperature: 0.92, maxTokens: 5000 });
}

// ──────────────────────────────────────────────
// フロー5: 無料面談へ誘導する固定ポスト 10個
// ──────────────────────────────────────────────
export async function runPinnedPosts(ctx: CampaignContext, avoid: string[] = []): Promise<PinnedPost[]> {
  const prompt = `あなたはXから無料面談へ送客する導線設計のプロです。
以下の商品に興味がある見込み客を、自然に無料面談へ誘導する固定ポストを10個作ってください。

商品ジャンル：${ctx.chosenGenre.genre}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.pain}）
無料面談の内容：${ctx.consultContent}

条件：
・売り込み感を出しすぎない
・悩みから入る
・理想の未来を見せる
・無料で相談できる価値を伝える
・怪しく見えない
・今すぐ行動したくなる
・${POST_RULE}

各要素を持つオブジェクトを10件:
- text: 固定ポスト本文（140〜280文字）
- openingAim: 冒頭の狙い
- audience: 刺さるターゲット
- consultReason: 無料面談に誘導できる理由
- improvement: 改善ポイント${avoidBlock(avoid)}`;
  return generateItems<PinnedPost>(prompt, { temperature: 0.9, maxTokens: 4000 });
}

// ──────────────────────────────────────────────
// フロー6: DM誘導テンプレート（5パターン）
// ──────────────────────────────────────────────
export async function runDmTemplates(ctx: CampaignContext): Promise<DmTemplate[]> {
  const prompt = `あなたはXのDMで無料面談へ誘導するセールスライターです。
以下の見込み客に対して、自然に無料面談を案内するDM文を作ってください。

商品ジャンル：${ctx.chosenGenre.genre}
相手の悩み：${ctx.chosenTarget.pain}
相手の状況：${ctx.chosenTarget.name}（${ctx.chosenTarget.ageRange}）
無料面談で話せる内容：${ctx.consultContent}

条件：
・いきなり売り込まない
・相手の悩みに寄り添う
・押し売り感を出さない
・返信しやすい
・短文で自然
・無料面談に進みたくなる
・怪しい表現を避ける

次の5パターンを、stage と text を持つオブジェクトとして5件:
- stage="初回DM"
- stage="興味を示した時の返信"
- stage="迷っている人への返信"
- stage="日程調整に進める文章"
- stage="既読スルー後の追撃DM"
各 text にDM本文を入れる。`;
  return generateItems<DmTemplate>(prompt, { temperature: 0.85, maxTokens: 2500 });
}

// ──────────────────────────────────────────────
// フロー7: 教育投稿 20個（バッチ生成 + 重複回避）
// ──────────────────────────────────────────────
const EDU_TYPES = [
  "独学の落とし穴", "失敗する人の共通点", "成功する人の考え方", "自己流の危険性",
  "環境投資の重要性", "時間を無駄にするリスク", "無料相談を使うべき理由",
];

export async function runEducationPosts(ctx: CampaignContext, total = 20, avoid: string[] = []): Promise<EducationPost[]> {
  const build = (n: number, produced: EducationPost[]): string =>
    `あなたは高単価商品の教育導線を作るプロです。
以下の商品を直接売らずに、X投稿で必要性を感じさせる教育投稿を${n}個作ってください。

商品ジャンル：${ctx.chosenGenre.genre}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.pain}）
商品で解決できる悩み：${ctx.chosenGenre.pain}

条件：
・商品名を出さない
・無料面談に行く理由を作る
・独学の限界を伝える
・放置リスクを伝える
・プロに相談する価値を伝える
・不安を煽りすぎない
・初心者にもわかりやすい
・${POST_RULE}

投稿の型（type にいずれかを設定）：
${EDU_TYPES.join(" / ")}

各要素を持つオブジェクトを${n}件:
- type: 投稿の型
- text: 投稿文（140〜280文字）
- aim: 投稿の狙い
- emotion: 読者に起こしたい感情
- consultBridge: 無料面談へのつなげ方${avoidBlock([...avoid, ...produced.map((p) => p.text)])}`;
  return generateItemsBatched<EducationPost>(build, total, 10, { temperature: 0.9, maxTokens: 5000 });
}

// ──────────────────────────────────────────────
// フロー8: オファー文改善
// ──────────────────────────────────────────────
export async function runOfferCopy(ctx: CampaignContext): Promise<OfferCopy[]> {
  const current = ctx.offer.consultContent || ctx.consultContent;
  const prompt = `あなたは無料面談の申込率を高めるオファー設計のプロです。
以下の無料面談オファーを、より魅力的に見える形に改善してください。

現在のオファー：${current}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.pain}）
面談で提供できる価値：${ctx.consultBenefits}

条件：
・無料なのに価値が高く見える
・怪しく見えない
・誰に向けたものか明確
・申し込む理由がある
・今すぐ申し込む理由がある
・押し売り感がない
・Xの固定ポストやDMで使える

次の要素を持つオブジェクトを1件:
- consultName: 無料面談の名前
- catchCopy: 一言キャッチコピー
- applyMerit: 申し込むメリット
- notApplyDemerit: 申し込まないデメリット
- targetWho: 対象者
- notTargetWho: 対象外の人
- applyFunnelText: 申込導線の文章
- pinnedShort: X固定ポスト用の短文
- dmShort: DM用の短文
- profileShort: プロフィール用の短文`;
  return generateItems<OfferCopy>(prompt, { temperature: 0.8, maxTokens: 2500 });
}

// ──────────────────────────────────────────────
// フロー9: 見込み客診断ルブリック（運用時テンプレート）
// ──────────────────────────────────────────────
export async function runDiagnosisRubric(ctx: CampaignContext): Promise<DiagnosisRubric[]> {
  const prompt = `あなたは高単価アフィリエイトの成約率を上げるプロです。
Xで集客した見込み客を、無料面談に送客すべきか判断するための「診断ルブリック（運用マニュアル）」を作ってください。
特定個人ではなく、運用者が毎回当てはめて使える汎用ルールとして記述してください。

商品ジャンル：${ctx.chosenGenre.genre}
無料面談の内容：${ctx.consultContent}
ターゲット：${ctx.chosenTarget.name}

次の要素を持つオブジェクトを1件:
- grade: 見込み度S/A/B/Cそれぞれの判定基準
- criteria: 今すぐ面談に誘導すべきか/まだ教育が必要かの見極め基準
- hitAppeal: 刺さりそうな訴求
- avoidWords: 避けるべき言葉
- dmText: 各見込み度で送るべきDM文の方針
- timing: 面談に進める最適なタイミング
- closeProbability: 成約につながる可能性の目安
- nextAction: 次に取るべきアクション`;
  return generateItems<DiagnosisRubric>(prompt, { temperature: 0.7, maxTokens: 2500 });
}

// ──────────────────────────────────────────────
// フロー10: 30日ロードマップ（10日ずつバッチ生成）
// ──────────────────────────────────────────────
export async function runRoadmap(ctx: CampaignContext): Promise<RoadmapDay[]> {
  const followers = ctx.offer.followers ?? 0;
  const goalLeads = ctx.offer.goalLeads ?? 10;
  const goalRevenue = ctx.offer.goalRevenue ?? "未設定";
  const days: RoadmapDay[] = [];
  for (let start = 1; start <= 30; start += 10) {
    const end = Math.min(start + 9, 30);
    const prompt = `あなたはX集客と高単価アフィリエイトの専門家です。
以下の商品を無料面談に送客してアフィリエイト報酬を得るための30日間ロードマップのうち、${start}日目〜${end}日目を作ってください。

商品ジャンル：${ctx.chosenGenre.genre}
ターゲット：${ctx.chosenTarget.name}（${ctx.chosenTarget.pain}）
現在のフォロワー数：${followers}人
目標送客数：${goalLeads}人
目標報酬：${goalRevenue}

条件：
・初心者でも実行できる
・毎日何をすればいいかわかる
・投稿内容まで具体的にする
・プロフィール改善も固定ポスト改善もDM導線も含める
・無料面談への送客導線を作る

各日について次の要素を持つオブジェクトを${end - start + 1}件（day は ${start}〜${end}）:
- day: 日数（数値）
- todo: 今日やること
- postTheme: 投稿テーマ
- postExample: 投稿文の例
- replyStrategy: リプ周りのやり方
- dmTask: DMでやること
- consultFunnel: 無料面談への導線
- metricToWatch: 改善すべき数字
- improvement: 翌日に向けた改善点`;
    const batch = await generateItems<RoadmapDay>(prompt, { temperature: 0.8, maxTokens: 6000 });
    days.push(...batch);
  }
  return days.sort((a, b) => (a.day ?? 0) - (b.day ?? 0)).slice(0, 30);
}
