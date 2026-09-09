# 本格的なPWAプッシュ通知の設定

この版には「アプリを閉じていても届く」Web Pushの仕組みを組み込んであります。
ただし、Supabase側にEdge Functionと定期実行を1回設定する必要があります。

## 1. SQLを実行

SupabaseのSQL Editorで `supabase-push-migration.sql` を実行してください。

## 2. VAPID鍵を作る

Node.jsがあるPCでPowerShell / コマンドプロンプトから:

```bash
npx web-push generate-vapid-keys
```

表示された `Public Key` と `Private Key` を控えます。

- Public Key → `supabase-config.js` の `vapidPublicKey`
- Private Key → Supabase Edge FunctionのSecret

Private Keyはブラウザ側やGitHubなどに置かないでください。

## 3. Edge Functionをデプロイ

Supabase CLIを使う場合:

```bash
supabase login
supabase link --project-ref rtwthkzmsqylvdfekiff
supabase functions deploy send-deadline-notifications --use-api
```

このFunctionはCron/pg_netからsecret keyで呼ぶため、`supabase/config.toml` で `verify_jwt = false` にしています。Function内部では `@supabase/server` の `auth: 'secret'` で呼び出し元を確認します。

## 4. Edge FunctionのSecretを登録

Supabase Dashboard → Edge Functions → Secrets に以下を登録:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`（例: `mailto:your-email@example.com`）

SupabaseのSecret KeyはFunction側で `SUPABASE_SECRET_KEYS` から取得できるため、ブラウザに置く必要はありません。

## 5. アプリ側にPublic Keyを設定

`supabase-config.js`:

```js
window.RAFFLE_SUPABASE_CONFIG = {
  url: "https://rtwthkzmsqylvdfekiff.supabase.co",
  publishableKey: "",
  vapidPublicKey: "ここにPublic Key"
};
```

Publishable keyは今まで通りアプリの初回設定画面から入力しても構いません。

## 6. pg_cron / pg_netを有効化

Supabase Dashboard → Database → Extensions から、`pg_cron` と `pg_net` を有効化します。

## 7. Cronを登録

Secret KeyをVaultに保存します。Project URLもVaultに保存します。

```sql
select vault.create_secret('https://rtwthkzmsqylvdfekiff.supabase.co', 'raffle_project_url');
select vault.create_secret('YOUR_SUPABASE_SECRET_KEY', 'raffle_secret_key');
```

その後:

```sql
select cron.schedule(
  'raffle-deadline-push-every-5-minutes',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'raffle_project_url') || '/functions/v1/send-deadline-notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'raffle_secret_key')
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
```

## 8. アプリで通知を許可

ログイン後:

設定 → 通知設定 → 「この端末で通知を有効にする」

を押してください。

その後、

- 1日前
- 1時間前

を個別にON/OFFできます。

## 動作

Cronは5分ごとに実行され、締切が約24時間前 / 約1時間前の申込を探します。

- 未応募・応募予定・受付前・受付中 → 通知対象
- 応募済み・当選・落選 → 通知しない
- 同じ通知 → 二重送信しない
- 期限切れ端末 → Push購読を自動削除
- 通知履歴 → `notifications` に保存

## 注意

Web PushはHTTPS環境が必要です。localhostは開発用途として例外的に利用できます。単にHTMLファイルをダブルクリックして `file://` で開いた場合はService Worker / Push通知は動きません。
