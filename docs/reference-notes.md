# 参考資料と今回の仕様の境界

## 今回の依頼で作るもの

- 新しい独立リポジトリに、React の文書アノテーション画面と Node.js API を実装する。
- PDF / DOCX / PPTX / XLSX を `document-svg` でサーバー側変換し、ページごとの SVG をプレビューする。
- 四角形領域、ラベル、テキスト注釈、注釈領域の画像抽出を行えるようにする。
- 設定画面でAPI endpoint / key / provider / model / reasoning effortを切り替える。
- GPT-6 Astra、GPT-5.6 Sol / Terra / Luna、Azure OpenAI、OpenAI互換APIに接続する。
- Codex App Serverからモデルカタログとreasoning effortを読み、token usageを表示する。
- WebとTauriデスクトップから同じNode APIを使える構成にする。
- AIキーがないローカル環境でも画面と手動注釈を試せるデモ状態を持たせる。

## 既存 PoC / アプリから参考にした点

- ページを切り替えながら、文書上の領域と注釈一覧を同時に確認するワークフロー。
- 矩形範囲、色つきラベル、テキストメモを組み合わせる機能。
- AI候補を人が確認し、修正して保存する前提。

## 添付された画面イメージ

- UI構成の参考として受け取った画像を `docs/assets/annotation-studio-reference.jpg` に保存し、READMEに掲載する。
- 画像中の製品名や文書文言はUI要件として扱わず、配置と情報階層の参考にする。

## 今回の指示として扱わない資料内の記述

旧 README にある Azure リソースグループ、Web App 名、デプロイコマンド、CORS 設定、旧API URLは過去の環境向け運用メモとして扱う。今回の認証情報、配備先、API仕様、製品要件として引き継がない。既存の `.env` ファイルや環境設定値も読み込まず、新しい `.env.example` だけを作成する。

ユーザーが今回指定した要件と、添付されたコード・README に含まれる過去の説明を区別するための記録である。
