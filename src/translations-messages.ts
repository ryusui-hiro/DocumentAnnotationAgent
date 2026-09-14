export const messageTranslations: Record<string, readonly [string, string]> = {
  "Excelブックを読み込めませんでした。": [
    "Could not load the Excel workbook.",
    "无法加载 Excel 工作簿。"
  ],
  "周辺のExcelセルを読み込めませんでした。": [
    "Could not load the surrounding Excel cells.",
    "无法加载周围的 Excel 单元格。"
  ],
  "保存済みのExcel変更を復元できませんでした。": [
    "Could not restore saved Excel changes.",
    "无法恢复已保存的 Excel 更改。"
  ],
  "保存済みのExcel変更をサーバーセッションに復元できませんでした。": [
    "Could not restore saved Excel changes to the server session.",
    "无法将已保存的 Excel 更改恢复到服务器会话。"
  ],
  "ページ確認完了: P.{value1}の画像・変換状態を人が確認しました。": [
    "Page reviewed: a person checked the image and conversion status of P.{value1}.",
    "页面审核完成：已人工检查第 {value1} 页的图像和转换状态。"
  ],
  "P.{value1}のページ確認を記録しました。ほかに追加確認が必要です。": [
    "Recorded the review of P.{value1}. More review is needed.",
    "已记录第 {value1} 页的审核。仍需进一步检查。"
  ],
  "と変換警告": [
    " and conversion warnings",
    "及转换警告"
  ],
  "人がP.{value1}の画像{value2}を確認済みとして記録しました。": [
    "Recorded human review of the image{value2} on P.{value1}.",
    "已记录人工检查第 {value1} 页的图像{value2}。"
  ],
  "P.{value1}の確認を記録し、全文書のページ範囲確認が完了しました。": [
    "Recorded P.{value1}. All document pages have now been reviewed.",
    "已记录第 {value1} 页的审核，全文页面审核已完成。"
  ],
  "P.{value1}の確認を記録しました。ほかのページまたは候補に追加確認が必要です。": [
    "Recorded the review of P.{value1}. Other pages or suggestions need review.",
    "已记录第 {value1} 页的审核。其他页面或候选项仍需检查。"
  ],
  "対象注釈 {value1} が見つからないため、Agentの変更を適用できませんでした。": [
    "Could not apply the agent change because annotation {value1} was not found.",
    "找不到注释 {value1}，无法应用智能体的更改。"
  ],
  "update_annotation → {value1}を「{value2}」に変更しました。": [
    "update_annotation → Changed {value1} to “{value2}”.",
    "update_annotation → 已将 {value1} 更改为“{value2}”。"
  ],
  "delete_annotation → {value1}を削除しました。": [
    "delete_annotation → Removed {value1}.",
    "delete_annotation → 已删除 {value1}。"
  ],
  "接続設定を保存しました。APIキーはこのセッションのメモリにのみ保持します。": [
    "Connection settings saved. The API key stays in memory for this session only.",
    "连接设置已保存。API 密钥仅保留在当前会话的内存中。"
  ],
  "Validator Agentを実行するには、接続設定でAIプロバイダーを設定してください。": [
    "Configure an AI provider in connection settings to run the Validator Agent.",
    "请在连接设置中配置 AI 提供方，以运行审核智能体。"
  ],
  "現在の注釈を読み取り専用で確認しています…": [
    "Reviewing current annotations without changing them…",
    "正在只读审核当前注释…"
  ],
  "Validator Agentが{value1}件の注釈を確認しました。独立指摘 {value2}件。": [
    "Validator Agent reviewed {value1} annotations and found {value2} independent issues.",
    "审核智能体已检查 {value1} 条注释，发现 {value2} 个独立问题。"
  ],
  "Validator Agentの確認に失敗しました。ローカルの一貫性チェックを表示しています。{value1}": [
    "Validator Agent failed. Showing the local consistency check. {value1}",
    "审核智能体检查失败，现显示本地一致性检查。{value1}"
  ],
  "Validator Agentを実行できませんでした。AI接続設定を確認してください。": [
    "Could not run Validator Agent. Check your AI connection settings.",
    "无法运行审核智能体。请检查 AI 连接设置。"
  ],
  "Validator Agentを実行できませんでした。{value1}": [
    "Could not run Validator Agent. {value1}",
    "无法运行审核智能体。{value1}"
  ],
  "ルール案を作るには、接続設定でAIプロバイダーを設定してください。": [
    "Configure an AI provider in connection settings to draft a rule.",
    "请在连接设置中配置 AI 提供方，以生成规则草稿。"
  ],
  "修正ルール案を作成しています · P.{value1}": [
    "Drafting a correction rule · P.{value1}",
    "正在起草修正规则 · 第 {value1} 页"
  ],
  "修正ルール案を作成できませんでした。": [
    "Could not draft a correction rule.",
    "无法起草修正规则。"
  ],
  "修正ルール案の応答を確認できませんでした。": [
    "Could not verify the correction rule response.",
    "无法验证修正规则的返回结果。"
  ],
  "入力が変わったため、古い修正ルール案は破棄しました。": [
    "The input changed, so the previous rule draft was discarded.",
    "输入已更改，已丢弃旧的规则草稿。"
  ],
  "修正ルール案を作成しました。残りページへの適用は人の確認後に行います。": [
    "Correction rule drafted. It will apply to remaining pages after human review.",
    "修正规则草稿已生成。经人工确认后，将应用于剩余页面。"
  ],
  "修正内容を一般化できる安全なルール案はありませんでした。": [
    "No safe general rule could be derived from this correction.",
    "无法从此次修正中推导出可靠的通用规则。"
  ],
  "トークン使用量をリセットしました。": [
    "Token usage reset.",
    "令牌用量已重置。"
  ],
  "Codex App Serverからモデル一覧を取得しています…": [
    "Fetching models from Codex App Server…",
    "正在从 Codex App Server 获取模型列表…"
  ],
  "Codex App Serverに接続できませんでした。": [
    "Could not connect to Codex App Server.",
    "无法连接 Codex App Server。"
  ],
  "{value1}個のGPTモデルを検出しました。": [
    "Found {value1} GPT models.",
    "已发现 {value1} 个 GPT 模型。"
  ],
  "Codex接続済みですが、対象GPTモデルは現在のモデル一覧にありません。": [
    "Connected to Codex, but the requested GPT model is not in its current model list.",
    "已连接 Codex，但当前模型列表中没有所需的 GPT 模型。"
  ],
  "API接続を確認しています…": [
    "Checking API connection…",
    "正在检查 API 连接…"
  ],
  "API接続を確認できませんでした。": [
    "Could not verify the API connection.",
    "无法验证 API 连接。"
  ],
  "{value1} に接続できました。": [
    "Connected to {value1}.",
    "已连接到 {value1}。"
  ],
  "サンプル文書を読み込めませんでした。": [
    "Could not load the sample document.",
    "无法加载示例文档。"
  ],
  "同名文書の内容が前回の作業時から変わったため、旧注釈と承認待ち状態を混ぜずに外しました。保存した指示は引き継いでいます。": [
    "This document changed since the previous session. Old annotations and pending approvals were removed; saved instructions were retained.",
    "该文档自上次处理后已更改。已移除旧注释和待审批状态，保留已保存的指令。"
  ],
  "文書の版を確認できなかったため、古い承認待ちRunは再開しませんでした。候補は残しています。": [
    "The document version could not be verified, so the previous pending run was not resumed. Suggestions were retained.",
    "无法确认文档版本，因此未恢复之前的待审批运行。候选项已保留。"
  ],
  "サンプルを読み込めませんでした。": [
    "Could not load the sample.",
    "无法加载示例。"
  ],
  "ページ画像を取得できませんでした。文書を開き直してください。": [
    "Could not load the page image. Reopen the document.",
    "无法加载页面图像。请重新打开文档。"
  ],
  "ページ画像を取得できませんでした。": [
    "Could not load the page image.",
    "无法加载页面图像。"
  ],
  "サンプル文書を開き直せませんでした。": [
    "Could not reopen the sample document.",
    "无法重新打开示例文档。"
  ],
  "文書を開き直せませんでした。": [
    "Could not reopen the document.",
    "无法重新打开文档。"
  ],
  "架空の契約書デモを開いています…": [
    "Opening the fictional contract demo…",
    "正在打开虚构合同演示…"
  ],
  "契約書デモを開けませんでした。": [
    "Could not open the contract demo.",
    "无法打开合同演示。"
  ],
  "架空の契約書を開きました。表示中の注釈と確認候補は固定デモで、AIは実行していません。": [
    "Opened a fictional contract. The displayed annotations and suggestions are fixed demo data; AI has not run.",
    "已打开虚构合同。当前注释和候选项为固定演示数据，尚未运行 AI。"
  ],
  "架空データを開きました。出力ラベルは未記入です。AI接続を確認してからAgentを実行してください。": [
    "Opened fictional data with blank output labels. Check your AI connection, then run the agent.",
    "已打开虚构数据，输出标签尚未填写。请确认 AI 连接后运行智能体。"
  ],
  "契約書のAIデモを開けませんでした。": [
    "Could not open the contract AI demo.",
    "无法打开合同 AI 演示。"
  ],
  "顧客フィードバックのAIデモを開けませんでした。": [
    "Could not open the customer feedback AI demo.",
    "无法打开客户反馈 AI 演示。"
  ],
  "顧客解約リスクのAIデモを開けませんでした。": [
    "Could not open the customer churn risk AI demo.",
    "无法打开客户流失风险 AI 演示。"
  ],
  "注釈を削除しました。": [
    "Annotation deleted.",
    "注释已删除。"
  ],
  "文書または画像をSVGページに変換しています…": [
    "Converting the document or image into SVG pages…",
    "正在将文档或图像转换为 SVG 页面…"
  ],
  "文書を変換できませんでした。": [
    "Could not convert the document.",
    "无法转换文档。"
  ],
  "{value1} は同名の前回ファイルと内容が異なるため、古い注釈を表示せず新しい作業として開きました。": [
    "{value1} has changed since the previous file with this name. Opened as new work without old annotations.",
    "{value1} 与此前同名文件的内容不同。已作为新任务打开，不显示旧注释。"
  ],
  "{value1} を読み込みましたが、元の文書版を確認できない承認待ちRunは再開しませんでした。": [
    "Loaded {value1}. A pending run was not resumed because the original document version could not be verified.",
    "已加载 {value1}。因无法确认原文档版本，未恢复待审批运行。"
  ],
  "{value1} を読み込みました。{value2}ページを変換しました。": [
    "Loaded {value1}. Converted {value2} pages.",
    "已加载 {value1}，转换了 {value2} 页。"
  ],
  "変換に失敗しました。": [
    "Conversion failed.",
    "转换失败。"
  ],
  "ガイドライン文書を開けませんでした。": [
    "Could not open the guidelines document.",
    "无法打开指南文档。"
  ],
  "ガイドラインの{value1}ページを取得できませんでした。": [
    "Could not load page {value1} of the guidelines.",
    "无法加载指南的第 {value1} 页。"
  ],
  "--- {value1}ページ ---\n{value2}": [
    "--- Page {value1} ---\n{value2}",
    "--- 第 {value1} 页 ---\n{value2}"
  ],
  "ガイドライン文書からテキストを抽出できませんでした。文字が選択できるPDF / Office文書を使用するか、内容を直接入力してください。": [
    "Could not extract text from the guidelines. Use a PDF or Office document with selectable text, or enter the content directly.",
    "无法从指南文档提取文字。请使用可选择文字的 PDF 或 Office 文档，或直接输入内容。"
  ],
  "{value1} からガイドライン文書のテキストを読み込みました。": [
    "Imported guideline text from {value1}.",
    "已从 {value1} 导入指南文字。"
  ],
  "ガイドライン文書を読み込めませんでした。": [
    "Could not load the guidelines document.",
    "无法加载指南文档。"
  ],
  "プロジェクトフォルダーを選択": [
    "Choose a project folder",
    "选择项目文件夹"
  ],
  "{value1} をプロジェクトとして開きました。対応文書 {value2} 件。": [
    "Opened {value1} as a project with {value2} supported documents.",
    "已将 {value1} 作为项目打开，包含 {value2} 个支持的文档。"
  ],
  "先頭の{value1}件を表示しています。対象フォルダーを分けてください。": [
    "Showing the first {value1} documents. Split the folder into smaller groups.",
    "显示前 {value1} 个文档。请将目标文件夹拆分为较小的分组。"
  ],
  "プロジェクトフォルダーを開けませんでした。": [
    "Could not open the project folder.",
    "无法打开项目文件夹。"
  ],
  "選択フォルダーに対応文書がありません。PDF、Office文書、画像を選んでください。": [
    "No supported documents in this folder. Select PDFs, Office documents, or images.",
    "所选文件夹中没有支持的文档。请选择 PDF、Office 文档或图像。"
  ],
  "先頭の{value1}件を読み込みました。対象フォルダーを分けてください。": [
    "Loaded the first {value1} documents. Split the folder into smaller groups.",
    "已加载前 {value1} 个文档。请将目标文件夹拆分为较小的分组。"
  ],
  "現在の文書処理が終わってから、次のファイルを開いてください。": [
    "Wait for the current document to finish before opening another file.",
    "请等待当前文档处理完成，再打开下一个文件。"
  ],
  "対応しているPDF、Office文書、画像ファイルをドロップしてください。": [
    "Drop a supported PDF, Office document, or image.",
    "请拖入支持的 PDF、Office 文档或图像。"
  ],
  "複数文書の一括処理には、左側の「プロジェクト」からフォルダーを開いてください。": [
    "For batch processing, open a folder from Projects on the left.",
    "如需批量处理，请从左侧“项目”打开文件夹。"
  ],
  "プロジェクトフォルダーへ再接続してから、もう一度書き出してください。": [
    "Reconnect the project folder, then export again.",
    "请重新连接项目文件夹，然后再次导出。"
  ],
  "{value1} の文書セッションを復元できませんでした。": [
    "Could not restore the document session for {value1}.",
    "无法恢复 {value1} 的文档会话。"
  ],
  "{value1} は前回処理したファイルから変更されています。古い注釈を適用せず、文書を開き直して再実行してください。": [
    "{value1} changed since its last run. Reopen and rerun the document without applying old annotations.",
    "{value1} 自上次处理后已更改。请重新打开并运行文档，不要应用旧注释。"
  ],
  "フォルダー内の元ファイルにアクセスできません。プロジェクトフォルダーを再接続してください。": [
    "Cannot access source files in the folder. Reconnect the project folder.",
    "无法访问文件夹中的原文件。请重新连接项目文件夹。"
  ],
  "{value1} を変換できませんでした。": [
    "Could not convert {value1}.",
    "无法转换 {value1}。"
  ],
  "{value1} は前回処理したファイルから変更されています。古い注釈は引き継がず、新しい内容に再実行してください。": [
    "{value1} changed since its last run. Rerun the new content without carrying over old annotations.",
    "{value1} 自上次处理后已更改。请针对新内容重新运行，不沿用旧注释。"
  ],
  "{value1} を開きましたが、元の文書版を確認できない承認待ちRunは再開しませんでした。": [
    "Opened {value1}. A pending run was not resumed because the original document version could not be verified.",
    "已打开 {value1}。因无法确认原文档版本，未恢复待审批运行。"
  ],
  "{value1} を開きました。{value2}ページ。": [
    "Opened {value1}. {value2} pages.",
    "已打开 {value1}，共 {value2} 页。"
  ],
  "プロジェクトフォルダーを開くか、再接続してください。": [
    "Open or reconnect a project folder.",
    "请打开或重新连接项目文件夹。"
  ],
  "実行する文書にチェックを入れてください。": [
    "Select the documents to process.",
    "请选择要处理的文档。"
  ],
  "AIへの指示を入力してください。": [
    "Enter instructions for the AI.",
    "请输入 AI 指令。"
  ],
  "この文書のAgent実行を完了できませんでした。": [
    "The agent could not finish this document.",
    "智能体无法完成该文档的处理。"
  ],
  "文書を処理できませんでした。": [
    "Could not process the document.",
    "无法处理文档。"
  ],
  "プロジェクトの一括実行が完了しました": [
    "Project batch processing completed",
    "项目批量处理已完成"
  ],
  "{value1}。対象 {value2}件、確認待ち {value3}件、失敗 {value4}件。": [
    "{value1}. {value2} documents, {value3} awaiting review, {value4} failed.",
    "{value1}。目标 {value2} 个文档，待审核 {value3} 个，失败 {value4} 个。"
  ],
  "現在の文書の処理後に一括実行を停止します。": [
    "Batch processing will stop after the current document.",
    "将在当前文档处理完成后停止批量运行。"
  ],
  "要確認": [
    "Needs review",
    "需要审核"
  ],
  "人がページ上で追加しました。": [
    "Added manually on the page.",
    "由用户在页面上手动添加。"
  ],
  "人が承認: {value1}": [
    "Approved by reviewer: {value1}",
    "人工批准：{value1}"
  ],
  "文書または確認ページが変わりました。現在の候補をもう一度開いてください。": [
    "The document or review page changed. Open the current suggestion again.",
    "文档或审核页面已更改。请重新打开当前候选项。"
  ],
  "ラベルまたはメモを変更してから確定してください。": [
    "Change the label or note before confirming.",
    "请更改标签或备注后再确认。"
  ],
  "残りのページがないため、この修正だけを候補に適用できます。": [
    "There are no remaining pages. This correction can apply only to this suggestion.",
    "没有剩余页面，此次修正仅能应用于当前候选项。"
  ],
  "残りページに適用するルールを入力するか、AIの提案を確認して適用してください。": [
    "Enter a rule for remaining pages, or review and apply the AI proposal.",
    "请输入适用于剩余页面的规则，或确认并应用 AI 建议。"
  ],
  "人が内容を修正して確定。AIの提案理由: {value1}": [
    "Corrected and confirmed by reviewer. Original AI reason: {value1}",
    "已人工修正并确认。AI 原始理由：{value1}"
  ],
  "人が候補を修正して確定: {value1} → {value2}": [
    "Reviewer corrected and confirmed: {value1} → {value2}",
    "人工修正并确认：{value1} → {value2}"
  ],
  "P.{value1}の候補を「{value2}」に修正しました。確認済みルールをP.{value3}以降に適用します。": [
    "Changed the suggestion on P.{value1} to “{value2}”. The confirmed rule will apply from P.{value3}.",
    "已将第 {value1} 页的候选项修正为“{value2}”。已确认的规则将从第 {value3} 页开始应用。"
  ],
  "P.{value1}の候補を「{value2}」に修正しました。": [
    "Changed the suggestion on P.{value1} to “{value2}”.",
    "已将第 {value1} 页的候选项修正为“{value2}”。"
  ],
  "人が確認して適用する残りページ用ルール: {value1}": [
    "Reviewer-confirmed rule for remaining pages: {value1}",
    "人工确认的剩余页面规则：{value1}"
  ],
  "人が却下: {value1}": [
    "Rejected by reviewer: {value1}",
    "人工驳回：{value1}"
  ],
  "確認候補を却下しました。": [
    "Suggestion rejected.",
    "候选项已驳回。"
  ],
  "確定": [
    "Confirm",
    "确认"
  ],
  "人が{value1}: P.{value2} {value3}: {value4}": [
    "Reviewer {value1}: P.{value2} {value3}: {value4}",
    "人工{value1}：第 {value2} 页 {value3}：{value4}"
  ],
  "人の{value1}を反映し、Agent SDKの同じRunを再開します。": [
    "Applying the reviewer’s {value1} and resuming the same Agent SDK run.",
    "正在应用人工{value1}结果，并恢复同一个 Agent SDK 运行。"
  ],
  "人の{value1}を反映し、P.{value2}から残りのページを再開します。": [
    "Applying the reviewer’s {value1} and resuming remaining pages from P.{value2}.",
    "正在应用人工{value1}结果，并从第 {value2} 页恢复处理。"
  ],
  "人が{value1}: {value2}!{value3} {value4}": [
    "Reviewer {value1}: {value2}!{value3} {value4}",
    "人工{value1}：{value2}!{value3} {value4}"
  ],
  "人が{value1}!{value2}の表変更を{value3}し、同じAgent Runを再開します。": [
    "Reviewer {value3} the changes to {value1}!{value2}. Resuming the same agent run.",
    "已人工{value3} {value1}!{value2} 的表格更改，正在恢复同一智能体运行。"
  ],
  "承認し、ブックに反映しました": [
    "approved and applied to the workbook",
    "已批准并应用到工作簿"
  ],
  "却下しました": [
    "rejected",
    "已驳回"
  ],
  "ほかに{value1}件のセル変更が確認待ちです。": [
    "{value1} more cell changes await review.",
    "另有 {value1} 处单元格更改待审核。"
  ],
  "{value1}!{value2}を{value3}。{value4}": [
    "{value1}!{value2}: {value3}. {value4}",
    "{value1}!{value2}：{value3}。{value4}"
  ],
  "削除": [
    "Delete",
    "删除"
  ],
  "人が注釈の{value1}を{value2}: {value3}。{value4}": [
    "Reviewer {value2} the annotation {value1}: {value3}. {value4}",
    "人工{value2}注释的{value1}操作：{value3}。{value4}"
  ],
  "人が {value1} の{value2}を{value3}し、同じAgent Runを再開します。": [
    "Reviewer {value3} the {value2} of {value1}. Resuming the same agent run.",
    "已人工{value3} {value1} 的{value2}操作，正在恢复同一智能体运行。"
  ],
  "注釈済みExcelを書き出せませんでした。": [
    "Could not export the annotated Excel workbook.",
    "无法导出带注释的 Excel 工作簿。"
  ],
  "承認済みのセル変更を別のExcelブックに書き出しました。": [
    "Exported approved cell changes to a separate Excel workbook.",
    "已将批准的单元格更改导出到新的 Excel 工作簿。"
  ],
  "元ファイルを変更せず、注釈済みExcelをダウンロードしました。": [
    "Downloaded the annotated Excel workbook without changing the source file.",
    "已下载带注释的 Excel 工作簿，原文件未被更改。"
  ],
  "Agentの書き出しファイルが見つからないか、有効期限が切れました。": [
    "The agent export was not found or has expired.",
    "找不到智能体导出文件，或文件已过期。"
  ],
  "{value1} をダウンロードしました。": [
    "Downloaded {value1}.",
    "已下载 {value1}。"
  ],
  "Agentの書き出しをダウンロードできませんでした。": [
    "Could not download the agent export.",
    "无法下载智能体导出文件。"
  ],
  "{value1} に確定済みの注釈がありません。確認待ち候補はJSONまたはCSVで保存できます。": [
    "{value1} has no confirmed annotations. Save pending suggestions as JSON or CSV.",
    "{value1} 没有已确认的注释。可将待确认候选项保存为 JSON 或 CSV。"
  ],
  "{value1} に書き出せる注釈がありません。": [
    "{value1} has no annotations to export.",
    "{value1} 没有可导出的注释。"
  ],
  "{value1} を書き出せませんでした。文書を開き直して再実行してください。": [
    "Could not export {value1}. Reopen the document and try again.",
    "无法导出 {value1}。请重新打开文档并重试。"
  ],
  "注釈を元形式の新しいコピーに書き出し": [
    "export annotations to a new source-format copy",
    "将注释导出到原格式的新副本"
  ],
  "構造化JSONを書き出し": [
    "export structured JSON",
    "导出结构化 JSON"
  ],
  "CSVを書き出し": [
    "export CSV",
    "导出 CSV"
  ],
  "{value1} の{value2}を行いました。": [
    "Completed {value2} for {value1}.",
    "已对 {value1} 完成{value2}。"
  ],
  "{value1} を書き出しました。": [
    "Exported {value1}.",
    "已导出 {value1}。"
  ],
  "{value1} を書き出せませんでした。": [
    "Could not export {value1}.",
    "无法导出 {value1}。"
  ],
  "{value1}を書き出す": [
    "Export {value1}",
    "导出 {value1}"
  ],
  "{value1}の注釈付きコピーを保存": [
    "Save an annotated copy of {value1}",
    "保存 {value1} 的注释副本"
  ],
  "承認済みのExcelコピー": [
    "Approved Excel copy",
    "已批准的 Excel 副本"
  ],
  "注釈付きコピー": [
    "Annotated copy",
    "注释副本"
  ],
  "注釈付き": [
    "Annotated",
    "已注释"
  ],
  "{value1}の注釈CSVを保存": [
    "Save annotation CSV for {value1}",
    "保存 {value1} 的注释 CSV"
  ],
  "CSV": [
    "CSV",
    "CSV"
  ],
  "{value1}の注釈JSONを保存": [
    "Save annotation JSON for {value1}",
    "保存 {value1} 的注释 JSON"
  ],
  "JSON": [
    "JSON",
    "JSON"
  ],
  "{value1}をAgent出力からダウンロード": [
    "Download {value1} from agent exports",
    "从智能体输出中下载 {value1}"
  ],
  "Agentが準備した{value1}": [
    "Agent-prepared {value1}",
    "智能体生成的 {value1}"
  ],
  "文書を読み込んでから実行してください。": [
    "Load a document before running the agent.",
    "请先加载文档，再运行智能体。"
  ],
  "ページ {value1} を取得できませんでした。": [
    "Could not load page {value1}.",
    "无法加载第 {value1} 页。"
  ],
  "ページ {value1} を画像化できませんでした。": [
    "Could not render page {value1} as an image.",
    "无法将第 {value1} 页渲染为图像。"
  ],
  "ページ {value1} を読み取れませんでした。": [
    "Could not read page {value1}.",
    "无法读取第 {value1} 页。"
  ],
  "この実AIデモは固定結果を使いません。OpenAI、Azure、互換API、またはCodex App Serverを設定してください。": [
    "This live AI demo has no fixed results. Configure OpenAI, Azure, a compatible API, or Codex App Server.",
    "此实际 AI 演示不使用固定结果。请配置 OpenAI、Azure、兼容 API 或 Codex App Server。"
  ],
  "[THIS ITEM ONLY; DO NOT GENERALIZE] 人が確定: P.{value1} {value2}: {value3}": [
    "[THIS ITEM ONLY; DO NOT GENERALIZE] Reviewer confirmed: P.{value1} {value2}: {value3}",
    "[THIS ITEM ONLY; DO NOT GENERALIZE] 人工确认：第 {value1} 页 {value2}：{value3}"
  ],
  "[THIS ITEM ONLY; DO NOT GENERALIZE] 人が却下: P.{value1} {value2}: {value3}": [
    "[THIS ITEM ONLY; DO NOT GENERALIZE] Reviewer rejected: P.{value1} {value2}: {value3}",
    "[THIS ITEM ONLY; DO NOT GENERALIZE] 人工驳回：第 {value1} 页 {value2}：{value3}"
  ],
  "ページ {value1} の候補を作成できませんでした。": [
    "Could not create suggestions for page {value1}.",
    "无法为第 {value1} 页创建候选项。"
  ],
  "ページ {value1} の解析に失敗しました。": [
    "Analysis failed on page {value1}.",
    "第 {value1} 页分析失败。"
  ],
  "{value1}件の可能性のある範囲を読み取りました。文書は変更していません。": [
    "Read {value1} potential regions. The document was not changed.",
    "已读取 {value1} 个可能相关的区域，未更改文档。"
  ],
  "{value1}件の候補を確認待ちにしました。": [
    "Queued {value1} suggestions for review.",
    "已将 {value1} 个候选项加入待审核列表。"
  ],
  "曖昧な{value1}件は人の確認待ちです。": [
    "{value1} ambiguous items await human review.",
    "{value1} 个不明确的项目待人工审核。"
  ],
  "{value1}件の明確な結果を自動適用し、高優先度の重要項目{value2}件を報告しました。{value3}": [
    "Applied {value1} clear results and reported {value2} high-priority findings. {value3}",
    "已自动应用 {value1} 个明确结果，并报告 {value2} 个高优先级项目。{value3}"
  ],
  "{value1}件を注釈し、{value2}件の範囲と{value3}件のセル変更を人の確認待ちにしました。": [
    "Annotated {value1} items. {value2} regions and {value3} cell changes await review.",
    "已添加 {value1} 条注释。另有 {value2} 个区域和 {value3} 处单元格更改待人工审核。"
  ],
  " デモ候補は実モデルの解析結果ではありません。": [
    " Demo suggestions are not results from a live model.",
    " 演示候选项并非真实模型的分析结果。"
  ],
  " {value1} ここまでの結果を保持しました。": [
    " {value1} Results so far were retained.",
    " {value1} 已保留当前结果。"
  ],
  " 使用量 {value1} tokens": [
    " Usage: {value1} tokens",
    " 用量：{value1} 个令牌"
  ],
  " Validator Agentの独立指摘が{value1}件あります。": [
    " Validator Agent found {value1} independent issues.",
    " 审核智能体发现 {value1} 个独立问题。"
  ],
  " 一貫性レビューで{value1}件の確認候補を検出しました。{value2}": [
    " Consistency review found {value1} items to check. {value2}",
    " 一致性审核发现 {value1} 个待检查项目。{value2}"
  ],
  " 人の修正を{value1}件後続ページに反映しました。": [
    " Applied {value1} human corrections to subsequent pages.",
    " 已将 {value1} 处人工修正应用到后续页面。"
  ],
  " 画像のみ {value1}ページを人が確認済み。": [
    " {value1} image-only pages reviewed by a person.",
    " {value1} 个纯图像页面已人工审核。"
  ],
  " 文字抽出なし・未確認 {value1}ページ。": [
    " {value1} pages without extracted text await review.",
    " {value1} 页无提取文字，尚待审核。"
  ],
  " 変換警告 {value1}ページを人が確認済み。": [
    " Conversion warnings reviewed on {value1} pages.",
    " {value1} 页的转换警告已人工审核。"
  ],
  " 変換警告 {value1}ページ。": [
    " Conversion warnings on {value1} pages.",
    " {value1} 页存在转换警告。"
  ],
  " 開いたが未確認 {value1}ページ。": [
    " {value1} pages opened but not reviewed.",
    " {value1} 页已打开但尚未审核。"
  ],
  " 失敗 {value1}ページ。": [
    " {value1} pages failed.",
    " {value1} 页处理失败。"
  ],
  " 未処理 {value1}ページ。": [
    " {value1} pages not processed.",
    " {value1} 页尚未处理。"
  ],
  "確認範囲: {value1}/{value2}ページをテキスト付きで確認し、{value3}ページは該当なし。{value4}{value5}{value6}{value7}{value8}{value9}{value10}": [
    "Coverage: {value1}/{value2} pages reviewed with text; {value3} had no matches.{value4}{value5}{value6}{value7}{value8}{value9}{value10}",
    "审核范围：已检查 {value1}/{value2} 页的文字，其中 {value3} 页无匹配项。{value4}{value5}{value6}{value7}{value8}{value9}{value10}"
  ],
  "{value1} / {value2}ページを処理しました。{value3}{value4}{value5}{value6}{value7}{value8}{value9}": [
    "Processed {value1} / {value2} pages. {value3}{value4}{value5}{value6}{value7}{value8}{value9}",
    "已处理 {value1} / {value2} 页。{value3}{value4}{value5}{value6}{value7}{value8}{value9}"
  ],
  "AI候補の作成に失敗しました。": [
    "Could not create AI suggestions.",
    "无法创建 AI 候选项。"
  ],
  "確認範囲: {value1}/{value2}ページをテキスト付きで確認。{value3}{value4}{value5}{value6}{value7}{value8}{value9}": [
    "Coverage: {value1}/{value2} pages reviewed with text.{value3}{value4}{value5}{value6}{value7}{value8}{value9}",
    "审核范围：已检查 {value1}/{value2} 页的文字。{value3}{value4}{value5}{value6}{value7}{value8}{value9}"
  ],
  " 文書の確認が完了しました。": [
    " Document review completed.",
    " 文档审核已完成。"
  ],
  " 追加の確認が必要です。": [
    " More review is needed.",
    " 需要进一步审核。"
  ],
  " 人の確認待ち項目があります。": [
    " Some items await human review.",
    " 部分项目待人工审核。"
  ],
  " 一貫性レビューで{value1}件の確認候補があります。": [
    " Consistency review found {value1} items to check.",
    " 一致性审核发现 {value1} 个待检查项目。"
  ],
  "{value1}{value2}{value3}{value4}{value5}": [
    "{value1}{value2}{value3}{value4}{value5}",
    "{value1}{value2}{value3}{value4}{value5}"
  ],
  "人の判断を記録しました。": [
    "Human decision recorded.",
    "已记录人工判断。"
  ],
  "Agent Runを再開できませんでした。": [
    "Could not resume the agent run.",
    "无法恢复智能体运行。"
  ],
  "Agent Runを再開しました。": [
    "Agent run resumed.",
    "智能体运行已恢复。"
  ],
  "注釈、レビュー、タスク指示をローカルに保存しました。": [
    "Saved annotations, reviews, and task instructions locally.",
    "已在本地保存注释、审核和任务指令。"
  ],
  "注釈、確認状態、タスク指示をこのブラウザーに保存しました。": [
    "Saved annotations, review status, and task instructions in this browser.",
    "已在此浏览器中保存注释、审核状态和任务指令。"
  ],
  "構造化JSONを書き出しました。": [
    "Exported structured JSON.",
    "已导出结构化 JSON。"
  ],
  "注釈・確認待ち・タスク情報を含む構造化JSONを書き出しました。": [
    "Exported structured JSON with annotations, pending reviews, and task information.",
    "已导出包含注释、待审核项目和任务信息的结构化 JSON。"
  ],
  "{value1}件の作業履歴をJSONで保存しました。": [
    "Saved {value1} runs as JSON.",
    "已将 {value1} 条运行记录保存为 JSON。"
  ],
  "注釈とレビュー状態をCSVに書き出しました。": [
    "Exported annotations and review status to CSV.",
    "已将注释和审核状态导出为 CSV。"
  ],
  "確定注釈と確認待ちをCSVに書き出しました。": [
    "Exported confirmed annotations and pending reviews to CSV.",
    "已将确认注释和待审核项目导出为 CSV。"
  ],
  "Wordへ書き出す確定注釈がありません。": [
    "No confirmed annotations to export to Word.",
    "没有可导出到 Word 的已确认注释。"
  ],
  "Wordコメントを書き出せませんでした。": [
    "Could not export Word comments.",
    "无法导出 Word 批注。"
  ],
  " {value1}件は抜粋を特定できずスキップしました。": [
    " Skipped {value1} items whose excerpts could not be located.",
    " {value1} 项因无法定位原文片段而被跳过。"
  ],
  "Wordコメントを{value1}件書き出しました。{value2}": [
    "Exported {value1} Word comments.{value2}",
    "已导出 {value1} 条 Word 批注。{value2}"
  ],
  "{value1}件は抜粋を特定できずスキップしました。": [
    "Skipped {value1} items whose excerpts could not be located.",
    "{value1} 项因无法定位原文片段而被跳过。"
  ],
  "元の文書を変更せず、{value1}件のコメントを含むDOCXを保存しました。{value2}": [
    "Saved a DOCX with {value1} comments without changing the source.{value2}",
    "已保存包含 {value1} 条批注的 DOCX，原文档未被更改。{value2}"
  ],
  "PowerPointへ書き出す確定注釈がありません。": [
    "No confirmed annotations to export to PowerPoint.",
    "没有可导出到 PowerPoint 的已确认注释。"
  ],
  "PowerPoint注釈を書き出せませんでした。": [
    "Could not export PowerPoint annotations.",
    "无法导出 PowerPoint 注释。"
  ],
  " {value1}件はスライド位置を特定できずスキップしました。": [
    " Skipped {value1} items whose slide positions could not be located.",
    " {value1} 项因无法定位幻灯片位置而被跳过。"
  ],
  "PowerPointの{value1}スライドに{value2}件の注釈シェイプと{value3}件の意味タグを書き出しました。{value4}": [
    "Exported {value2} annotation shapes and {value3} semantic tags across {value1} slides.{value4}",
    "已在 {value1} 张幻灯片上导出 {value2} 个注释形状和 {value3} 个语义标签。{value4}"
  ],
  "{value1}件はスライド位置を特定できずスキップしました。": [
    "Skipped {value1} items whose slide positions could not be located.",
    "{value1} 项因无法定位幻灯片位置而被跳过。"
  ],
  "元ファイルを変更せず、{value1}スライドに注釈シェイプと分類・根拠タグを追加したPPTXを保存しました。{value2}": [
    "Saved a PPTX with annotation shapes and classification/evidence tags on {value1} slides, without changing the source.{value2}",
    "已保存 PPTX，在 {value1} 张幻灯片上添加注释形状、分类和依据标签，原文件未被更改。{value2}"
  ],
  "{value1}ページの注釈PDFを準備しています。": [
    "Preparing an annotated PDF with {value1} pages.",
    "正在准备 {value1} 页的注释 PDF。"
  ],
  "{value1}ページの注釈PDFを書き出しました。": [
    "Exported an annotated PDF with {value1} pages.",
    "已导出 {value1} 页的注释 PDF。"
  ],
  "注釈枠と、ラベル・メモ・根拠を記録したコメント付きPDFを書き出しました。": [
    "Exported a PDF with annotation boxes and comments containing labels, notes, and evidence.",
    "已导出带注释框和批注的 PDF，批注包含标签、备注和依据。"
  ],
  "注釈PDFを書き出せませんでした。": [
    "Could not export the annotated PDF.",
    "无法导出注释 PDF。"
  ],
  "{value1} の範囲をPNGで抽出しました。": [
    "Extracted the region for {value1} as PNG.",
    "已将 {value1} 的区域提取为 PNG。"
  ],
  "選択した範囲をPNGで書き出しました。": [
    "Exported the selected region as PNG.",
    "已将所选区域导出为 PNG。"
  ],
  "範囲を抽出できませんでした。": [
    "Could not extract the region.",
    "无法提取区域。"
  ],
  "確定注釈の範囲画像・抜粋・ラベルをZIPで抽出しました。": [
    "Extracted confirmed region images, excerpts, and labels to ZIP.",
    "已将确认区域的图像、摘录和标签提取到 ZIP。"
  ],
  "PNG画像・抜粋ノート・ラベルとページ座標をZIPにまとめました。": [
    "Packaged PNG images, excerpt notes, labels, and page coordinates into a ZIP.",
    "已将 PNG 图像、摘录笔记、标签和页面坐标打包为 ZIP。"
  ],
  "一括抽出できませんでした。": [
    "Could not extract all regions.",
    "无法批量提取区域。"
  ],
  "原文の抜粋と注釈をMarkdownで保存しました。": [
    "Saved source excerpts and annotations as Markdown.",
    "已将原文摘录和注释保存为 Markdown。"
  ],
  "P.{value1}を現在のガイドラインで新しい1ページ確認として実行します。": [
    "Starting a fresh review of P.{value1} using the current guidelines.",
    "将按照当前指南重新审核第 {value1} 页。"
  ],
  "ルール案を作成中…": [
    "Drafting a rule…",
    "正在起草规则…"
  ],
  "AIで残りページのルール案を作成": [
    "Draft a rule for remaining pages with AI",
    "用 AI 起草剩余页面规则"
  ],
  "続きのページがある場合に、修正を一般化した案を作れます。": [
    "When pages remain, you can draft a rule based on this correction.",
    "如果还有剩余页面，可以根据此次修正起草通用规则。"
  ],
  "AI接続設定が必要です。": [
    "An AI connection is required.",
    "需要配置 AI 连接。"
  ],
  "個別の修正にとどめる案です。": [
    "This proposal applies only to the individual correction.",
    "此建议仅适用于当前单项修正。"
  ],
  "残りページに適用するルール（必須）": [
    "Rule for remaining pages (required)",
    "剩余页面规则（必填）"
  ],
  "適用するルール · 確認・編集できます": [
    "Rule to apply · Review and edit",
    "将应用的规则 · 可检查和编辑"
  ],
  "ルール案 · 適用前に編集・確認してください": [
    "Rule draft · Review and edit before applying",
    "规则草稿 · 应用前请检查和编辑"
  ],
  "残りページに使うルール": [
    "Rule for remaining pages",
    "剩余页面适用规则"
  ],
  "このルール案をP.{value1}以降に適用する設定にしました。確定する前に文案を確認してください。": [
    "This rule is set to apply from P.{value1}. Review its wording before confirming.",
    "已设置从第 {value1} 页开始应用此规则。请在确认前检查规则内容。"
  ],
  "この案を残りページに適用": [
    "Apply this proposal to remaining pages",
    "将此建议应用于剩余页面"
  ],
  "Codex App Server · ローカルCLI": [
    "Codex App Server · Local CLI",
    "Codex App Server · 本地 CLI"
  ],
  "OpenAI互換API · {value1}": [
    "OpenAI-compatible API · {value1}",
    "OpenAI 兼容 API · {value1}"
  ],
  "{value1} シート": [
    "{value1} sheets",
    "{value1} 个工作表"
  ],
  "人の判断を待っています": [
    "Waiting for your review",
    "等待人工判断"
  ],
  "文書を確認しています": [
    "Reviewing the document",
    "正在检查文档"
  ],
  "今回の解析が完了しました": [
    "Analysis completed",
    "本次分析已完成"
  ],
  "解析が停止しました": [
    "Analysis stopped",
    "分析已停止"
  ],
  "タスクの指示を確認して開始できます": [
    "Review your instructions and start",
    "确认任务指令后即可开始"
  ],
  "判断を確定すると、同じAgent Runが残りの作業を続けます。": [
    "Once you confirm a decision, the same agent run continues the remaining work.",
    "确认判断后，同一智能体运行将继续处理剩余任务。"
  ],
  "根拠を確認して候補を承認・修正・却下してください。": [
    "Check the evidence, then approve, correct, or reject suggestions.",
    "请检查依据，再批准、修正或驳回候选项。"
  ],
  "ページの確認後、次の対象へ進みます。": [
    "After reviewing this page, the agent moves to the next target.",
    "检查当前页面后，将继续处理下一个目标。"
  ],
  "結果を確認して、この文書に合う形式で書き出せます。": [
    "Review the results and export in a format suited to this document.",
    "请检查结果，并以适合当前文档的格式导出。"
  ],
  "Excelのシートを調べ、分類列やセル変更を提案します。": [
    "Inspects Excel sheets and proposes classification columns and cell changes.",
    "检查 Excel 工作表，并提出分类列和单元格更改建议。"
  ],
  "スライド上の範囲を確認し、注釈と分類をまとめます。": [
    "Reviews slide regions and organizes annotations and classifications.",
    "检查幻灯片区域，汇总注释和分类。"
  ],
  "文書を読み、必要な箇所にコメントを追加します。": [
    "Reads the document and adds comments where needed.",
    "读取文档，并在需要的位置添加批注。"
  ],
  "ページを移動して根拠を確認し、曖昧な箇所だけ質問します。": [
    "Checks evidence across pages and asks only about ambiguous items.",
    "逐页检查依据，仅对不明确的内容提问。"
  ],
  "{value1} シート · {value2} 件のセル変更": [
    "{value1} sheets · {value2} cell changes",
    "{value1} 个工作表 · {value2} 处单元格更改"
  ],
  "{value1} / {value2} {value3}を確認": [
    "Reviewed {value1} / {value2} {value3}",
    "已检查 {value1} / {value2} {value3}"
  ],
  "Agentが作業中…": [
    "Agent working…",
    "智能体正在处理…"
  ],
  "文書を読み取る": [
    "Read document",
    "读取文档"
  ],
  "候補を提案": [
    "Suggest annotations",
    "建议注释"
  ],
  "Autopilotを開始": [
    "Start Autopilot",
    "启动自动模式"
  ],
  "Excelを分類": [
    "Classify Excel",
    "分类 Excel"
  ],
  "全{value1}を実行": [
    "Run all {value1}",
    "处理全部{value1}"
  ],
  "現在の{value1}（{value2}）だけ実行": [
    "Run current {value1} ({value2}) only",
    "仅处理当前{value1}（{value2}）"
  ],
  "注釈付きWordを保存": [
    "Save annotated Word",
    "保存带批注的 Word"
  ],
  "注釈付きPowerPointを保存": [
    "Save annotated PowerPoint",
    "保存带注释的 PowerPoint"
  ],
  "編集済みExcelを保存": [
    "Save edited Excel",
    "保存编辑后的 Excel"
  ],
  "注釈入りPDFを保存": [
    "Save annotated PDF",
    "保存带注释的 PDF"
  ],
  "選択した{count}文書を一括実行": [
    "Run {count} selected documents",
    "批量处理 {count} 个所选文档"
  ],
  "{count}件": [
    "{count} items",
    "{count} 项"
  ],
  "{count}文字 · 任意": [
    "{count} characters · optional",
    "{count} 字符 · 可选"
  ],
  "過去の作業履歴（{count}件）・この端末に自動保存": [
    "History ({count} runs) · saved on this device",
    "历史记录（{count} 次）· 自动保存在此设备"
  ],
  "{count}件 · 文書は未変更": [
    "{count} findings · document unchanged",
    "{count} 项结果 · 文档未更改"
  ],
  "残り{count}件を表示": [
    "Show {count} more",
    "显示剩余 {count} 项"
  ],
  "ほか{count}件はActivity履歴で確認できます。": [
    "View {count} more issues in the activity history.",
    "可在活动记录中查看另外 {count} 个问题。"
  ],
  "読み取り結果（{count}件）": [
    "Reading results ({count})",
    "读取结果（{count} 项）"
  ],
  "保存上限を超えたため、ほか{count}件はこの履歴に保存されていません。": [
    "{count} more findings exceeded the storage limit and are not saved in this history.",
    "另有 {count} 项因超出存储上限而未保存到此记录中。"
  ],
  "ページ{page}の判断を待っています。確認すると、同じAgent Runの作業を再開します。": [
    "Waiting for a decision on page {page}. Confirm to resume the same agent run.",
    "等待第 {page} 页的判断。确认后将恢复同一智能体运行。"
  ],
  "{count}件が確認待ち": [
    "{count} awaiting review",
    "{count} 项待审核"
  ],
  "{rows}行 · {columns}列": [
    "{rows} rows · {columns} columns",
    "{rows} 行 · {columns} 列"
  ],
  "冒頭{rows}行 · 列{start}–{end}を表示": [
    "Showing first {rows} rows · columns {start}–{end}",
    "显示前 {rows} 行 · 第 {start}–{end} 列"
  ],
  "{sheet}シートの冒頭{rows}行、列{start}から{end}。ハイライトされたセルにはAgentの変更案があります。": [
    "First {rows} rows of {sheet}, columns {start} to {end}. Highlighted cells contain proposed agent changes.",
    "{sheet} 工作表的前 {rows} 行，第 {start} 到 {end} 列。高亮单元格包含智能体的更改建议。"
  ],
  "セル表は冒頭{rows}行・最初の最大{columns}列を表示しています。表示範囲外の変更はAgent欄の「変更前と提案を表示」で確認できます。原本のExcelファイルは変更していません。": [
    "Showing the first {rows} rows and up to {columns} columns. Use “Compare original and proposed” in the agent panel to inspect other changes. The source Excel file is unchanged.",
    "显示前 {rows} 行和最多 {columns} 列。可在智能体面板中点击“显示原内容与建议”检查范围外的更改。原始 Excel 文件未被更改。"
  ],
  "{sheets}シート · {changes}件のセル変更": [
    "{sheets} sheets · {changes} cell changes",
    "{sheets} 个工作表 · {changes} 处单元格更改"
  ],
  "{done} / {total}ページ": [
    "{done} / {total} pages",
    "{done} / {total} 页"
  ],
  "{count}件の対応文書 ·": [
    "{count} supported documents ·",
    "{count} 个支持的文档 ·"
  ],
  "{pages}ページ · {count}件の注釈": [
    "{pages} pages · {count} annotations",
    "{pages} 页 · {count} 条注释"
  ],
  "{count}回": [
    "{count} requests",
    "{count} 次请求"
  ],
  "承認待ち": [
    "Awaiting approval",
    "待批准"
  ],
  "承認済み": [
    "Approved",
    "已批准"
  ],
  "修正済み": [
    "Corrected",
    "已修正"
  ],
  "適用済み": [
    "Applied",
    "已应用"
  ],
  "未適用": [
    "Not applied",
    "未应用"
  ],
  "却下": [
    "Rejected",
    "已驳回"
  ]
};
