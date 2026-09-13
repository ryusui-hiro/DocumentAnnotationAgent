# Annotation Studio

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh.md)

默认语言为英语，主文档为 `README.md`。

Annotation Studio 是一个基于 React 和 Node.js 的文档注释 Agent 概念验证项目。它逐页读取 PDF、Word、Excel 和 PowerPoint 文档，也可将 PNG、JPEG、WebP 和 TIFF 图片作为单页文档处理，并依据自然语言指令和注释指南标记相关区域。证据清晰且未请求审核的结果会自动添加；有歧义的结果会进入人工审核队列。

PDF / DOCX / PPTX / XLSX 文件由 Node.js 服务端的 [`document-svg`](https://github.com/ryusui-hiro/document-svg) 转换。图片会在服务端规范化为单页 SVG 预览。API 密钥会随每次 AI 请求发送给本地 API，服务端不会保存或记录密钥。

## 开始使用

需要 Node.js 22 或更高版本。

```bash
npm install
cp .env.example .env
npm run create:demo
npm run dev
```

打开 `http://127.0.0.1:5173`，即可查看示例文档。无需 API 密钥即可手动添加注释、编辑标签和备注、切换页面及提取 PNG 图片。未配置 AI 时，应用会在整份文档中显示固定的演示候选项；这些并非模型分析结果。

在 Settings 中选择 OpenAI API、Azure OpenAI 或兼容 OpenAI 的 API，并填写 endpoint、API key、模型和推理级别。支持 GPT-6 Astra 以及 GPT-5.6 Sol / Terra / Luna。Azure 还需要填写 deployment 名称。如果未在应用中输入密钥，也可以使用本地环境变量 `OPENAI_API_KEY` 和 `AZURE_OPENAI_*` 作为备用配置。

API 密钥仅保存在当前浏览器标签页的内存中，不会写入浏览器或 Tauri WebView 存储。刷新页面或关闭标签页后会清除密钥。AI 分析会将页面图片、带归一化位置的提取文本、指令、指南、可选修正规则以及人工确认的判断发送给所选服务。整份文档会逐页运行 Agent；工具操作可能触发多次模型请求，应用会按实际请求统计 token 用量和请求数。OpenAI Responses API 请求使用 `store: false`，并禁用 SDK tracing。连接远程 API 服务时请使用 HTTPS。

构建并运行生产版本：

```bash
npm run build
npm test
npm start
```

`npm test` 使用脚本模型验证 Agents SDK 工具调用，不会请求外部 API。

## 功能

- 可选择一个 PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP 或 TIFF 文件，也可将其拖放到工作区打开。PDF / Office 文档通过 `document-svg` 转换为逐页 SVG；图片作为单页预览加载。
- 添加和编辑矩形注释、颜色标签及备注；选择、删除注释，或将选定区域提取为 PNG。
- 使用任务模板和可编辑的注释指南，逐页或按顺序分析整份文档。
- 将自然语言指令整理为可见的 Annotation Task，包含标签、操作、不确定时的处理方式和流程；连接 OpenAI、Azure、兼容 OpenAI 的 API 或 Codex App Server 时使用结构化输出，并把计划传给逐页 Agent。未连接时会标记为本地草稿。
- 可导入可提取文本的 PDF / Office 文档作为指南来源，并将文本加入可编辑的指南栏。
- 可选择 Observe、Suggest、Assist 或 Autopilot。实时活动流会显示任务规划、页面导航、SVG 文本 / 布局检查、搜索、注释、审核和导出操作。
- 服务端使用 OpenAI Agents SDK 编排文档工具：读取大纲、检查页面、读取当前选择区域、列出现有注释、搜索提取文本、添加区域注释及请求人工审核。`scroll_document` 返回放大后的页面裁剪图，并将查看器同步到相同位置；`select_text` 会将带位置的文本映射到归一化页面坐标，`get_selected_region` 会将查看器中的选择传给 Agent，`annotate_text` 根据唯一匹配创建有文本证据的区域注释。缺少匹配或存在重复匹配时不会自动确认。在 Assist / Autopilot 中，Agent 提议更新或删除现有注释时会暂停等待批准，并恢复同一个运行。现有注释和待审核项会以有界摘要传入，帮助 Agent 避免重复。Codex App Server 继续使用结构化输出适配器。
- 仅当用户在任务中明确要求文件输出时，Agents SDK 运行才会在完成指定范围检查后调用 `export_annotations`，通过 Adapter 准备原格式、JSON 或 CSV 文件并显示下载操作。产物加密保存 30 分钟；存在未解决审核时不会输出原格式副本。Codex App Server 使用与服务商无关的 UI 导出操作。
- PDF / Office 页面预览和 XLSX 工作簿实现共享的服务端 `DocumentAdapter` 大纲、检查与搜索契约。`search_document` 可跨全文检索，并返回页面或工作表单元格位置。
- 同一 Adapter 保存 Agent 工具生成的类型化注释，并通过 `POST /api/documents/:documentId/export` 统一导出 JSON、CSV、PDF、DOCX、PPTX 和 XLSX。会话单独保留上传源字节；原文件不会被覆盖，导出会生成新文件。
- 对于密集表格或视觉上有歧义的页面，Orchestrator 可委派给只读的嵌套 `Document Reader Agent`。Reader 返回有界证据和布局提示；分类及注释权限仍由 Orchestrator 掌握。独立 Validator 检查整份文档，格式 Adapter 负责确定性导出。
- 只有用户明确要求文件输出时，才启用 `export_annotations` 工具，并在完成指定范围的阅读后通过 Adapter 准备文件。下载产物会加密保存，最长 30 分钟，并显示下载操作；存在未解决审核时不会生成原格式副本，JSON / CSV 会保留审核状态。
- 在 OpenAI Agents SDK 全文运行中，Agent 调用 `navigate_page` 后，指定页面会作为图像 Tool 输出返回模型；注释保留 Agent 实际检查的页码。未访问页面随后由宿主继续处理。
- 对于 XLSX 工作簿，OpenAI Agents SDK Agent 可以检查工作表结构和有界单元格范围，并提出新增列、写入单元格或范围。Assist / Autopilot 会在批准后恢复同一个 Agent Run；工作区批处理会在内存工作簿中写入后继续处理下一个文件。Codex App Server 目前支持页面视觉审核，但不提供工作簿单元格工具。
- 可在 Agent 面板查看工作表预览和单元格变更历史，并将已批准的变更下载为新的 `-annotated.xlsx` 副本；不会覆盖上传源文件。处理后的项目文档可在服务器会话有效期间从项目列表导出原格式注释副本、结构化 JSON 或 CSV。
- Assist / Autopilot 遇到歧义的 `request_review` 工具调用时会中断 Agents SDK 运行；人工批准或拒绝后会恢复同一个 `RunState`，再继续剩余页面。待处理 Run 及其源文档会话会以 AES-GCM 加密保存在 API 服务器本地目录中，API 重启后可在 30 分钟内恢复。API 密钥不会保存；恢复时使用当前的服务商设置。工作区批处理会按文档保留待审核项并继续下一个文件。
- 生成包含审核优先级、判断理由和简短原文摘录的候选项。是否需要人工决策由歧义和明确的审核请求决定；可选数值置信度仅作为元数据保存，不作为自动应用阈值。
- 全文处理结束后，会由使用当前服务商的独立 Agents SDK Validator 检查标签一致性、证据支持情况和证据缺失。规则检查也会标记相同或高度相似摘录的标签冲突，并显示摘录和相关页面。结果会随文档工作区保存，并在最后一次人工决策后重新检查。所有发现均由人工判断，Validator 不会修改注释；独立检查不可用时，规则检查结果仍会保留。
- 确认前可修改候选项的标签和备注。默认仅应用于当前候选；如要将其作为后续页面的规则，需明确选择。中断页面上的多项判断会按顺序保留，只有标记为“应用于剩余页面规则”的判断会作为后续指导。运行历史会记录每项人工决策、来源候选项和适用范围；后续页面规则会保存版本号及生效页码。页面覆盖状态、页面跳转，以及对覆盖缺口或转换警告页面的复查也会保留。
- 按文档在浏览器中保存注释、待审核项目、拒绝记录和任务指令。
- 按文档自动保存最近 20 次 Agent 运行记录，包括状态、指令、时间及活动事件；可在界面查看或导出为 JSON。历史记录未加密，请谨慎在共享设备上使用。
- 实时注释状态使用一个规范化记录列表统一保存页面区域、审核项和电子表格更改，界面队列由状态派生。新的文档工作区保存同一记录列表；现有 version 2 工作区仍可读取，并会在下次保存时转换为新格式。
- 将文件夹作为项目工作区打开：桌面版使用 Tauri 原生文件夹选择器和只读文件访问；兼容的 Web 浏览器可直接上传文件夹。项目最多列出 200 个受支持文档。
- 对所有选中的文档及其页面依次执行同一条 Agent 指令。有歧义的区域会留在该文档的审核队列中，Agent 随后继续处理下一份文档；注释和运行记录按文档分别保存。
- 项目文件夹信息保存在本机。重启桌面应用或刷新网页后，需要重新连接文件夹以授予访问权限；Web 文件仅在当前会话中可用。
- 导出结构化 JSON / CSV、注释版 PDF，以及选定区域的 PNG。
- 结构化 JSON 将页面区域和工作表单元格变更归一为同一格式，记录文档 ID、目标位置、证据、说明、审核优先级和状态。
- 通过 OpenAI Responses API、Azure OpenAI、兼容 OpenAI 的 endpoint 或 Codex App Server 使用 GPT-6 Astra / GPT-5.6 Sol / Terra / Luna，并设置推理级别。
- 通过 Codex App Server 使用本机 Codex CLI 的模型列表、推理设置和 thread token 用量。
- 在 Settings 中按模型查看输入、输出、推理、缓存输入和总 token 用量。
- 为 macOS、Windows 和 Linux 构建 Tauri 2 桌面外壳。

注释版 PDF 是页面渲染图的视觉副本，包含注释轮廓和编号标记。已批准的 Excel 更改可导出为新工作簿；已批准的 DOCX 注释可导出为新 Word 文件中的批注，均不会覆盖原文件。若段落结构受支持，Word 批注会锚定到唯一原文摘录的精确范围；同一段落中的多个注释共用段落锚点。缺少摘录、找不到摘录或匹配不唯一时会跳过并报告。已批准的 PowerPoint 注释会作为可编辑轮廓和标签形状添加到对应幻灯片，并写入幻灯片级用户定义标签。标签以机器可读的名称／值属性保存分类、证据摘录、说明、审核优先级和状态，同时保留无关的现有标签。标签不显示在幻灯片画布上，可通过 PowerPoint Tags API 或 Open XML 读取。标签、理由、审核优先级、坐标及可选数值估计会包含在 CSV / JSON 中。

转换警告会显示在应用中。SVG 会以图片形式显示，不会直接插入 HTML。Codex App Server 使用运行服务的主机上的 Codex CLI 登录状态和模型列表。在 macOS 上，如果可用，会优先使用 ChatGPT 应用自带的 Codex 可执行文件；可通过 `CODEX_APP_SERVER_BIN` 覆盖。远程 Web 部署时，请在本地或公司主机上运行 API 服务和 Codex CLI。Tauri 软件包不包含 Node API，请在 Settings 中指定本地或公司 API URL。加密会话数据默认保存在 `~/.annotation-studio/session-state`；如需更换位置，请设置 `ANNOTATION_STUDIO_DATA_DIR`。

## 英文界面概念图

以下英文屏幕概念图和流程图展示了预期的文档注释体验。

![Annotation Studio 桌面工作区概念图](public/examples/annotation-workspace-concept-en.png)

![文档注释四步流程](public/examples/annotation-workflow-guide-en.png)

## 参考资料

早期 PoC 文件仅用于了解注释工作流程。旧文件中的部署目标、命令和 API URL 不作为当前需求或凭据沿用。详见 [`docs/reference-notes.md`](docs/reference-notes.md)。

## API 与桌面端设置

- Settings 可在 OpenAI API、Azure OpenAI、兼容 OpenAI 的 API 和 Codex App Server 之间切换。
- API 模式支持 endpoint、API key、GPT-6 Astra / GPT-5.6 Sol / Terra / Luna 和推理级别。Azure 还需要 deployment 名称。
- API 密钥不会写入设备存储，仅保存在当前浏览器标签页的内存中。
- Codex App Server 使用同一主机上的 Codex CLI，包括其登录账户、可用模型和推理设置。
- Tauri 2 桌面版使用相同的文档处理 API。请在 Settings 中设置可访问的本地或公司 Annotation Studio API URL。

启动 Web 开发环境：

```bash
npm run dev
```

启动 Tauri 桌面开发环境：

```bash
npm run tauri:dev
```

构建 Tauri 软件包：

```bash
npm run tauri:build
```

Tauri 软件包不会自动启动 Node API。请在本地运行 API，或配置可访问的内部 API URL。本地 API 仅监听 `127.0.0.1`。公开部署时，请显式设置 `HOST`，通过带身份验证的反向代理和 HTTPS 提供服务，并将 `CORS_ALLOWED_ORIGINS` 限定为部署所需的来源。

Codex App Server 的 TypeScript wire schema 是根据此开发环境中的 Codex CLI 生成的。升级 CLI 后，使用 `codex app-server generate-ts --out server/codex-protocol` 重新生成，并验证模型发现、推理级别和 token 用量通知。
