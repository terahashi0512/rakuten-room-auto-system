# Instagram / Threads 連携セットアップガイド

ROOM投稿成功後、同じ商品を **Instagram** と **Threads** に自動クロス投稿して認知度を拡大します。
コードは実装済み。以下の**アカウント開設とトークン取得だけ手動**で行ってください（Metaの規約上、アカウント作成は本人操作が必要です）。

どちらか片方だけ設定してもOK。未設定のプラットフォームは自動でスキップされます。

---

## Step 1: アカウント開設（初回のみ・約15分)

1. **Instagramアカウント作成** → https://www.instagram.com/
   - 楽天ROOMと同じ名前・アイコンにする（ブランド統一）
   - プロフィールの「リンク」に **楽天ROOMのプロフィールURL** を設定（これが導線の要）
2. **プロアカウントに切替**: 設定 → アカウントの種類とツール → プロアカウントに切り替える → 「ビジネス」を選択
3. **Threadsアカウント作成**: Threadsアプリを開き、上記Instagramアカウントでログイン → 自動作成される

## Step 2: Instagram Graph API トークン取得

1. https://developers.facebook.com/ → 「マイアプリ」→「アプリを作成」→ 種類は「ビジネス」
2. Facebookページを作成し（なければ）、Instagramビジネスアカウントとリンク
3. アプリに「Instagram Graph API」を追加
4. グラフAPIエクスプローラー (https://developers.facebook.com/tools/explorer/) で以下の権限を付与してトークン生成:
   - `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
5. 長期トークンに交換（60日有効）:
   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id={アプリID}&client_secret={アプリシークレット}&fb_exchange_token={短期トークン}
   ```
6. IGユーザーID取得:
   ```
   https://graph.facebook.com/v21.0/me/accounts?access_token={トークン}
   → ページIDを取得後
   https://graph.facebook.com/v21.0/{ページID}?fields=instagram_business_account&access_token={トークン}
   ```

## Step 3: Threads API トークン取得

1. 同じMeta開発者アプリに「Threads API」ユースケースを追加
2. 権限: `threads_basic`, `threads_content_publish`
3. https://developers.facebook.com/docs/threads/get-started の手順で長期トークン取得（60日有効）
4. ThreadsユーザーID取得:
   ```
   https://graph.threads.net/v1.0/me?fields=id&access_token={トークン}
   ```

## Step 4: GitHub Secrets に登録

リポジトリ → Settings → Secrets and variables → Actions → New repository secret

| Secret名 | 値 |
|---|---|
| `IG_USER_ID` | Step 2-6 のInstagramビジネスアカウントID |
| `IG_ACCESS_TOKEN` | Step 2-5 の長期トークン |
| `THREADS_USER_ID` | Step 3-4 のID |
| `THREADS_ACCESS_TOKEN` | Step 3-3 の長期トークン |
| `ROOM_PROFILE_URL` | 楽天ROOMのプロフィールURL |

ローカル実行する場合は `.env` にも同じキーを設定。

---

## 動作仕様

- ROOM投稿が成功した実行で、**1商品のみ**をIG・Threadsに投稿（スパム判定・API制限対策。IGは25件/日が上限）
- **Instagram**: 商品画像(640px) + ROOM用キャプション + プロフィールリンク誘導CTA + 拡散用タグ
- **Threads**: ハッシュタグを除いた本文 + 楽天ROOMプロフィールへの直リンク（Threadsはリンク投稿可）
- 投稿失敗時はDiscordに通知され、ROOM投稿処理には影響しない

## 注意

- 長期トークンは**60日で失効**します。失効するとDiscordに「Instagram/Threads投稿失敗」通知が届くので、Step 2-5 / 3-3 の手順で再発行して Secrets を更新してください
- Instagramの自動投稿は**ビジネス/クリエイターアカウントのみ**利用可能です
