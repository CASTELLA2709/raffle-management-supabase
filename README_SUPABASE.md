# 抽選管理アプリ - Supabase Database版

## 1. Supabase側で最初に行うこと

すでに実行済みの `CREATE TABLE` SQL に加えて、同梱の `supabase-migration.sql` を Supabase の SQL Editor で1回実行してください。

この追加SQLでは、現在のアプリで使っている以下の項目を追加します。

- products.price
- products.purchased
- schedules.related_event_ids

## 2. アプリの起動

`index.html` をWebサーバーまたはGitHub Pages等から開いてください。

初回起動時に「Supabase接続設定」が表示されます。

- Project URL: 既定値が入力済み
- Publishable key: SupabaseのProject Settings → API Keysから取得したPublishable key

Secret key / service_role key は入力しないでください。

## 3. アカウント

接続後、「新規アカウントを作成」からメールアドレスとパスワードでSupabase Authのアカウントを作成します。

Supabase側でメール確認が有効になっている場合は、確認メールのリンクを開いてからログインしてください。

## 4. Database化の動作

既存の画面・デザインを維持しながら、イベント、公演、申込、商品、欲しい商品、予定、設定をSupabase Databaseへ同期します。

ブラウザのlocalStorageもキャッシュとして残すため、画面表示の既存ロジックはそのまま利用できます。

既存ブラウザにlocalStorageのデータがあり、Supabase側が空の場合は初回ログイン時にUUIDへ変換してDatabaseへ移行します。

## 5. セキュリティ

Database側ではRLSを有効化済みです。トップレベルのイベント、商品、予定、設定、通知はログインユーザー単位で制御され、子テーブルも親データを通じてユーザー単位に制御されます。
