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

打开 `http://127.0.0.1:5173`，即可查看默认的冷却风扇示例文档。无需 API 密钥即可手动添加注释、编辑标签和备注、切换页面及提取 PNG 图片。未配置 AI 时，应用会在整份文档中显示固定的演示候选项；这些并非模型分析结果。点击“合同审查示例”按钮还可打开可选的虚构终止条款演示。预设注释和审核候选由应用脚本提供，PDF 本身不含预设答案或标签；即使用户审核过候选，页面仍会持续显示“脚本演示／未运行 AI／非法律建议”提示。可运行 `npm run create:termination-demo` 确定性地重新生成该 PDF。

单独的“实AI演示”菜单可打开未预填标签的虚构合同 PDF、`Churn Risk` 列为空的 18 行客户流失风险工作簿，或保留的 16 行客户反馈工作簿。每个演示都有自己的任务和指南；打开文件不会调用模型，只有用户启动 Agent 后才会开始分析。演示使用合成数据，不含真实客户记录；未配置模型时，启动会转到设置，不会生成固定替代标签。使用 `npm run create:product-hunt-contract-demo`、`npm run create:product-hunt-churn-demo` 和 `npm run create:product-hunt-demo` 可重新生成这些素材。Product Hunt 演示流程见[演示套件](docs/product-hunt-demo-kit.md)。

在 Settings 中选择 OpenAI API、Azure OpenAI 或兼容 OpenAI 的 API，并填写 endpoint、API key、模型和推理级别。支持 GPT-6 Astra 以及 GPT-5.6 Sol / Terra / Luna。Azure 还需要填写 deployment 名称。如果未在应用中输入密钥，也可以使用本地环境变量 `OPENAI_API_KEY` 和 `AZURE_OPENAI_*` 作为备用配置。

API 密钥仅保存在当前浏览器标签页的内存中，不会写入浏览器或 Tauri WebView 存储。刷新页面或关闭标签页后会清除密钥。AI 分析会将页面图片、带归一化位置的提取文本、指令、指南、可选修正规则以及人工确认的判断发送给所选服务。整份文档会逐页运行 Agent；工具操作可能触发多次模型请求，应用会按实际请求统计 token 用量和请求数。OpenAI Responses API 请求使用 `store: false`，并禁用 SDK tracing。连接远程 API 服务时请使用 HTTPS。

构建并运行生产版本：

```bash
npm run build
npm test
npx playwright-cli install-browser chromium --only-shell
npm run test:browser-e2e
npm run test:agent-sse-browser-e2e
npm start
```

`npm test` 使用脚本模型检查 Agents SDK 工具循环、审批与恢复，并通过本地 Responses 协议模拟服务验证修正规则 API；不会调用外部服务商。进程级 API 测试通过loopback伪Responses服务调用真正的Task Planner和Agents SDK路径，在同一个RunState中导航15页合成文档，在第14页为高优先级候选触发人审，批准后恢复同一RunState并继续到第15页，再将人审和自动注释导出为JSON。全文API在仍有未检查页面时返回`incomplete`和准确的`remainingPages`，直到全部检查完成才开放导出。40页脚本测试确认低细节图像概览和有界页面信息可支持超过12页的导航；121页大纲测试验证页面条目上限。Product Hunt PDF源测试验证11页、14条款且未嵌入分类标签。该测试还会暂停最终模型响应，以确认页面导航、检查、滚动、注释的有序SSE事件先于最终结果送达。API 测试会检查严格输出 Schema、输入长度限制以及文档证据不被持久化。`npm run test:browser-e2e` 会构建并启动生产预览，验证示例 PDF 的审核、更正、拒绝和 JSON 导出，以及只打开但尚未检查的页面会成为下一全文导航区段的起点；还会验证人工确认持久转换警告后完成页面覆盖、SSE 页面导航/滚动事件让真实查看器移至第 2 页高亮区域、人工编辑并批准的规则进入后续页面请求、修正源变化后丢弃旧规则案、保存注释的 Validator 复核、宽表 XLSX 列导航和原值审核上下文、多格式文件夹批处理与逐文档导出、导出会话失效后的恢复，以及浏览器内 DOCX/PPTX 上传和原格式输出。模型响应及浏览器导航均使用本地模拟数据；上传、变更注册和只读原值上下文由隔离的本地 API 处理。测试使用固定版本的Playwright CLI操作Chromium。

全文覆盖由服务器确定：页数取自已打开的文档会话，已检查页面会按源文件哈希和任务范围保存在加密会话记录中。客户端提供的`alreadyInspectedPages`不能单独解锁Validator或导出。进程级回归测试会尝试伪造页数和“全部页面已检查”列表，重启API后仍验证未检查页面会阻止校验与导出。

单元测试还会模拟一份80页文档，验证 Agent 搜索并导航到第80页、在人审处暂停后恢复同一个Run。另一个进程级XLSX测试通过真实Agents SDK工作簿工具创建列、进行两次审批、读回数据、导出原生文件，再由ExcelJS独立重新打开，并确认源文件字节未改变。生产浏览器E2E会在桌面和手机宽度显示四种模式，并验证Autopilot处理全文、自动应用并报告明确的高优先级结果，而且不会错误地加入审核队列。

`npm run test:agent-sse-browser-e2e` 会构建并启动生产版 React UI，在 Chromium 中通过真实的 Task Planner 和 Agents SDK Express SSE 路由执行测试。Responses API 使用仅监听 loopback 的模拟服务，不会调用外部服务商。确认页面导航、滚动和 Human Review 活动流后，浏览器会把第 2 页的 HIGH RISK 建议更正为 LOW RISK，并明确接受应用于剩余页面的规则。测试检查请求通过 `approved:false` 拒绝原建议、恢复同一个 Agent Run、在第 3 页添加 LOW RISK 注释，并将第 2 页人工更正和第 3 页自动注释一并导出到 JSON。

`npm run test:office-native-export-libreoffice` 是需要安装 LibreOffice 才能运行的可选原生导出验收测试。它为合成 DOCX 和 PPTX 添加注释，经 LibreOffice 保存并重新打开后，检查 Word 评论锚点和 PowerPoint 注释形状是否保留。LibreOffice 保存时会删除自定义 PowerPoint 标签部分。该测试不能证明 Microsoft Office 兼容性或视觉保真度。

如需主动运行真实服务商验收测试，请设置`ANNOTATION_STUDIO_LIVE_SMOKE=1`并配置 OpenAI、Azure OpenAI 或兼容 API 凭据，再运行`npm run test:live-provider-smoke`。脚本只使用生成的虚构 PDF，验证计划、文档工具调用、人工审核中断/恢复与 JSON 导出。此测试可能产生服务商费用，不属于默认测试套件。

CI 还会安装生产版 Ubuntu `.deb`，并通过 `tauri-driver` / WebKitWebDriver 操作打包后的 Tauri 应用，验证审核、JSON 导出以及关闭应用时随包 API 是否退出。此安装包测试仅支持 Linux，其他平台会跳过。

## 功能

- 可选择一个 PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP 或 TIFF 文件，也可将其拖放到工作区打开。PDF / Office 文档通过 `document-svg` 转换为逐页 SVG；图片作为单页预览加载。
- 添加和编辑矩形注释、颜色标签及备注；选择、删除注释，或将选定区域提取为 PNG。
- 使用任务模板和可编辑的注释指南，逐页或按顺序分析整份文档。
- 将自然语言指令整理为可见的 Annotation Task，包含标签、操作、不确定时的处理方式和流程；连接 OpenAI、Azure、兼容 OpenAI 的 API 或 Codex App Server 时使用结构化输出，并把计划传给逐页 Agent。未连接时会标记为本地草稿。
- 可导入可提取文本的 PDF / Office 文档作为指南来源，并将文本加入可编辑的指南栏。
- 可选择 Observe、Suggest、Assist 或 Autopilot。实时活动流会显示任务规划、页面导航、SVG 文本 / 布局检查、搜索、注释、审核和导出操作。运行中或等待审核时，最新事件会固定显示在 Agent 面板顶部；点击即可跳转到完整事件日志。
- 服务端使用 OpenAI Agents SDK 编排文档工具；`open_document`只打开用户已选择并绑定到本次运行的会话，不接受路径或 URL；`get_document_info`返回该会话的有界元数据，`get_document_outline`返回页面或工作表结构。随后可检查页面、读取当前选择区域、列出现有注释、搜索提取文本、添加区域注释及请求人工审核。仅分析当前页时，会保留用户可见的页面范围并明确告知 Agent 是否选中了注释；整份文档仍按既定页面计划执行。`scroll_document` 返回放大后的页面裁剪图，并将查看器同步到相同位置；`select_text` 会将带位置的文本映射到归一化页面坐标，`get_selected_region` 会将查看器中的选择传给 Agent，`annotate_text` 根据唯一匹配创建有文本证据的区域注释。缺少匹配或存在重复匹配时不会自动确认。在 Assist / Autopilot 中，Agent 提议更新或删除现有注释时会暂停等待批准，并恢复同一个运行。现有注释和待审核项会以有界摘要传入，帮助 Agent 避免重复。Codex App Server 继续使用结构化输出适配器。
- 仅当用户在任务中明确要求文件输出时，Agents SDK 运行才会在完成指定范围检查后调用 `export_annotations`。对于全文视觉文档导出，Orchestrator 会在同一运行中先用只读 Validator 检查规范化后的注释快照；验证失败或注释发生变化时，原格式、JSON 和 CSV 导出都会被阻止。Validator 发现会显示在 Final Review 中，不会修改或批准注释。随后由确定性的 Adapter 准备下载产物，加密保存 30 分钟；存在未解决审核时不会输出原格式副本。Codex App Server 使用与服务商无关的 UI 导出操作。
- PDF / Office 页面预览和 XLSX 工作簿通过共享的服务端 `DocumentAdapter` 契约打开已绑定会话、读取大纲、检查与搜索。`search_document` 可跨全文检索，并返回页面或工作表单元格位置。
- PDF 检查还会提供有界的样式式标题候选和按基线对齐的文本行提示，供 Agent 对照页面图像核验。这些只是导航和版面线索，并不表示系统已识别 PDF 的语义标题或表格结构。
- 同一 Adapter 保存 Agent 工具生成的类型化注释，并通过 `POST /api/documents/:documentId/export` 统一导出 JSON、CSV、PDF、DOCX、PPTX 和 XLSX。会话单独保留上传源字节；原文件不会被覆盖，导出会生成新文件。
- 对于密集表格或视觉上有歧义的页面，Orchestrator 可委派给只读的嵌套 `Document Reader Agent`，以获取有界证据和布局提示。复杂分类也可交给只读的 `Document Annotator Specialist`，最多返回 12 条标签建议。Annotator 没有工具；即使文本提取不完整，也会保留基于页面图像的建议，并遵守人工决策的明确适用范围。Orchestrator 会核实每条建议并保留全部注释与审批权限。每页最多委派一次，每次运行最多 24 次。对于明确要求全文视觉文档导出的任务，Validator 会在同一 Orchestrator 运行中于确定性导出之前执行；不含 Agent 内导出的全文任务仍由宿主侧做最终检查。
- 只有用户明确要求文件输出时，才启用 `export_annotations` 工具，并在完成指定范围的阅读后通过 Adapter 准备文件。全文视觉文档还要求 Validator 已成功检查同一注释快照；其失败或快照变化时不会导出。下载产物会加密保存，最长 30 分钟，并显示下载操作；存在未解决审核时不会生成原格式副本，JSON / CSV 会保留审核状态。XLSX沿用现有工作簿证据与审批门槛。
- 在 OpenAI Agents SDK 的全文运行中，Agent 可以在同一个 RunState 里通过 `navigate_page` 检查整份文档。低细节页面概览和有界文本可控制长文档上下文；遇到小字或需要确认区域时，可用 `scroll_document` 返回高细节裁剪图。注释会保留 Agent 实际检查的页码。只通过`navigate_page`打开的页面仍算未检查；API会返回`incomplete`和准确的未检查页列表，主流程会从第一张未检查页继续新全文区段，直到完整检查前不会开放全文导出。不支持页面导航的服务商仍采用按页处理，并把前页检查状态传入导出门槛。
- 对于 XLSX 工作簿，OpenAI Agents SDK Agent 可以检查工作表结构和有界单元格范围，并提出新增列、写入单元格或范围。Assist 自动应用证据明确的低／中优先级修改，高优先级或不确定修改会等待人工审核。Autopilot 自动应用所有证据明确的修改（包括高优先级），并报告重要结果；只有证据不确定时才等待审核。文件夹批处理中，不确定的修改会按文档保留待审队列，同时继续处理下一个文件。Codex App Server 也可通过服务端 Adapter 读取有界单元格范围并返回结构化修改建议。Suggest 会让所有修改等待审核。待审决定与文档 ID 和源文件哈希绑定。
- 工作台会标明 PDF、Word、PowerPoint 和 Excel 的目标格式，并在显眼位置显示 Agent 当前操作、下一步、进度和待审核数量。导出按钮会打开格式菜单，并优先显示对应的原生文件输出。
- Excel 中央预览会跟随所选工作表，显示开头 20 行，每次显示 16 列；列分页可浏览预览的前 80 列，变更卡片可跳转到网格内的目标单元格。待审核、已批准或已拒绝的变更卡片均可读取上传源文件中周围 5 行 × 8 列的原值上下文。网格范围外的较大变更会分页显示 5 × 8 切片，直到所有建议单元格均可查看。只读请求绑定到变更 ID，不会发送给 AI 服务商；单元格长文本最多显示 300 个字符。已批准的变更可下载为新的 `-annotated.xlsx`，不会覆盖上传源文件。处理后的项目文档可从项目列表导出原格式注释副本、结构化 JSON 或 CSV；若服务器会话过期，系统会从已连接的文件夹重新打开源文件，并在哈希匹配后再导出。
- Assist / Autopilot 遇到歧义的 `request_review` 工具调用时会中断 Agents SDK 运行；人工批准或拒绝后会恢复同一个 `RunState`，再继续剩余页面。待处理 Run 及其源文档会话会以 AES-GCM 加密保存在 API 服务器本地目录中，API 重启后可在 30 分钟内恢复。API 密钥不会持久化；批准时会把已保存的 RunState 重新绑定到相同服务商和模型的当前有效凭据。如果加密检查点未能保存，运行中的进程只有在原内存 Provider 配置未变化时才继续。工作区批处理会按文档保留待审核项并继续下一个文件。
- 生成包含审核优先级、判断理由和简短原文摘录的候选项。是否需要人工决策由歧义和明确的审核请求决定；可选数值置信度仅作为元数据保存，不作为自动应用阈值。
- 全文处理结束后，会由使用当前服务商的独立 Agents SDK Validator 检查标签一致性、证据支持情况和证据缺失。规则检查也会标记相同或高度相似摘录的标签冲突，并显示摘录和相关页面。结果会随文档工作区保存，并在最后一次人工决策后重新检查。用户也可以在 Final Review 中直接复核已保存的注释，无需重新分析页面。Validator 不会修改注释；若请求期间文档或注释输入发生变化，旧结果会被丢弃。独立检查不可用时，规则检查结果仍会保留。
- 确认前可修改候选项的标签和备注，默认仅应用于当前候选。全文任务还有后续页面时，可让当前服务商根据任务、证据和人工更正起草一条范围明确的规则；用户可编辑并明确批准后再应用。若更正不足以安全概括成通用规则，系统会说明原因而不强行生成。中断页面上的多项判断会按顺序保留，只有人工明确批准的后续页面规则会作为后续指导。运行历史会记录每项人工决策、来源候选项和适用范围；后续页面规则会保存版本号及生效页码。页面覆盖状态、页面跳转，以及对覆盖缺口或转换警告页面的复查也会保留。没有可提取文本的页面可在人眼检查后确认，转换警告也可在目视检查后确认；同页的多个人审决定会逐项更新覆盖计数。
- 按文档在浏览器本地保存注释、待审核项目、拒绝记录和任务指令。重新打开 XLSX 工作簿时，只有保存的工作区与源文件 SHA-256 均匹配，才会将注释、提案和审核决定恢复到新的 API 会话；文件内容变化后不会沿用旧记录。
- 按文档自动保存最近 20 次 Agent 运行记录，包括状态、指令、时间及活动事件；可在界面查看或导出为 JSON。历史记录未加密，请谨慎在共享设备上使用。
- 实时注释状态使用一个规范化记录列表统一保存页面区域、审核项和电子表格更改，界面队列由状态派生。新的文档工作区保存同一记录列表；现有 version 2 工作区仍可读取，并会在下次保存时转换为新格式。
- 将文件夹作为项目工作区打开：桌面版使用 Tauri 原生文件夹选择器和只读文件访问；兼容的 Web 浏览器可直接上传文件夹。项目最多列出 200 个受支持文档。
- 对所有选中的文档及其页面依次执行同一条 Agent 指令。有歧义的区域会留在该文档的审核队列中，Agent 随后继续处理下一份文档；注释和运行记录按文档分别保存。
- 项目文件夹信息保存在本机。重启桌面应用或刷新网页后，需要重新连接文件夹以授予访问权限；Web 文件仅在当前会话中可用。
- 导出结构化 JSON / CSV、注释版 PDF，以及选定区域的 PNG。
- 结构化 JSON 将页面区域和工作表单元格变更归一为同一格式，记录文档 ID、目标位置、证据、说明、审核优先级和状态。状态区分自动结果、待审核、按建议批准、人工更正和拒绝。
- 通过 OpenAI Responses API、Azure OpenAI、兼容 OpenAI 的 endpoint 或 Codex App Server 使用 GPT-6 Astra / GPT-5.6 Sol / Terra / Luna，并设置推理级别。
- 通过 Codex App Server 使用本机 Codex CLI 的模型列表、推理设置和 thread token 用量。
- 在 Settings 中按模型查看输入、输出、推理、缓存输入和总 token 用量。
- 为 macOS、Windows 和 Linux 构建 Tauri 2 桌面外壳。

从原始 PDF 导出的注释版 PDF 会保留页面内容并叠加矢量轮廓和编号，因此正文仍可搜索。Office 文档或图片转成 PDF 时使用渲染页面的视觉副本。已批准的 Excel 更改可导出为新工作簿；已批准的 DOCX 注释可导出为新 Word 文件中的批注，均不会覆盖原文件。段落结构受支持时，Word 批注会锚定到唯一原文摘录的精确范围；规范化引用的上下文可帮助区分重复语句。缺失、含糊或位于不支持嵌套结构中的摘录会跳过并报告，不会扩大成整段批注。已批准的 PowerPoint 注释会作为可编辑轮廓和标签形状添加到对应幻灯片，并写入幻灯片级用户定义标签。多行文本选择会拆成多个相连的轮廓形状，每个形状都带有稳定的 Annotation Studio 注释 ID。PPTX 原生导出支持 Transitional 和 Strict 两种 OOXML 命名空间格式。标签以机器可读的名称／值属性保存幻灯片坐标、文本片段和选择器、分类、证据摘录、说明、审核优先级和状态，同时保留无关的现有标签。标签不显示在幻灯片画布上，可通过 PowerPoint Tags API 或 Open XML 读取。标签、理由、审核优先级、坐标及可选数值估计会包含在 CSV / JSON 中。LibreOffice 26.2 能显示可编辑形状，但保存并重新打开后会丢弃自定义幻灯片标签；此环境无法验证 Microsoft Office 的行为。

转换警告会显示在应用中。SVG 会以图片形式显示，不会直接插入 HTML。Codex App Server 使用运行服务的主机上的 Codex CLI 登录状态和模型列表。在 macOS 上，如果可用，会优先使用 ChatGPT 应用自带的 Codex 可执行文件；可通过 `CODEX_APP_SERVER_BIN` 覆盖。远程 Web 部署时，请在本地或公司主机上运行 API 服务和 Codex CLI。Tauri 软件包包含 Node API、目标平台的生产依赖、默认风扇 PDF、固定示例合同 PDF、11 页且包含 14 条未分类条款的 Product Hunt 合同 PDF，以及客户反馈和客户流失风险工作簿；打包暂存测试会验证所有内置样例均按原始字节复制。桌面应用会在 loopback 上自动启动 API，并在退出时停止。服务器 URL 留空时使用内置 API，填写 URL 时则使用指定的本地或公司 API。桌面会话数据默认保存在系统应用数据目录，Web API 默认保存在 `~/.annotation-studio/session-state`；可通过 `ANNOTATION_STUDIO_DATA_DIR` 更改。

## 界面概念与格式流程

以下屏幕概念图和流程图展示了 Agent 工作台，以及 PDF、Excel、Word、PowerPoint 的注释目标。

![Annotation Studio 桌面工作区概念图](public/examples/annotation-workspace-concept-en.png)

![Agent 优先的注释工作台设计参考](docs/visual-design/annotation-workbench-agent-first.png)

![文档注释四步流程](public/examples/annotation-workflow-guide-en.png)

![PDF、Excel、Word 和 PowerPoint 的注释流程](public/examples/agent-format-workflow.png)

## 参考资料

早期 PoC 文件仅用于了解注释工作流程。旧文件中的部署目标、命令和 API URL 不作为当前需求或凭据沿用。详见 [`docs/reference-notes.md`](docs/reference-notes.md)。

## API 与桌面端设置

- Settings 可在 OpenAI API、Azure OpenAI、兼容 OpenAI 的 API 和 Codex App Server 之间切换。
- API 模式支持 endpoint、API key、GPT-6 Astra / GPT-5.6 Sol / Terra / Luna 和推理级别。Azure 还需要 deployment 名称。
- API 密钥不会写入设备存储，仅保存在当前浏览器标签页的内存中。
- Codex App Server 使用同一主机上的 Codex CLI，包括其登录账户、可用模型和推理设置。
- Tauri 2 桌面版会自动启动已打包的文档处理 API。服务器 URL 留空时使用内置 API，填写 URL 时连接本地或公司 Annotation Studio API。

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

Tauri 构建钩子会下载固定版本 Node.js 24.21.0 LTS，根据官方 SHA-256 清单验证后，将 API 与生产依赖按目标平台打包。原生构建会启动打包后的 API 并检查健康状态，也会验证关闭父进程的 stdin 管道后子进程能退出；Tauri 被强制终止时，管道也会关闭。应用只监听 `127.0.0.1`，会等待健康检查、在端口冲突时选择其他端口，并在退出时停止 API 子进程。支持 macOS x64 / arm64、Windows x64 / arm64 和 Linux GNU x64 / arm64 原生构建。请在目标操作系统上运行 `npm run tauri:build`，Tauri CLI 会自动把目标 Rust triple 传给打包钩子。只有在 Tauri CLI 之外单独准备 runtime 时才需要设置 `ANNOTATION_STUDIO_TARGET_TRIPLE`。`tauri:dev` 仍由 `npm run dev` 启动 API。公开部署时，请显式设置 `HOST`，通过带身份验证的反向代理和 HTTPS 提供服务，并将 `CORS_ALLOWED_ORIGINS` 精确设置为部署的前端 Origin；同源隐式访问仅适用于 loopback 主机。

Codex App Server 的 TypeScript wire schema 是根据此开发环境中的 Codex CLI 生成的。升级 CLI 后，使用 `codex app-server generate-ts --out server/codex-protocol` 重新生成，并验证模型发现、推理级别和 token 用量通知。
