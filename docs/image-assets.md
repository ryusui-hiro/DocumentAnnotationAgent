# 画像生成アセット

すべて組み込みの ImageGen で作成し、PoC の画面ガイドまたはダミー仕様書のみに使用している。既存DENSO資料の画像や文書データは含めていない。

| ファイル | 画面上の用途 | 生成した指示の要点 |
|---|---|---|
| [`annotation-workspace-concept.png`](../public/examples/annotation-workspace-concept.png) | ガイド内の画面イメージ | 1440 x 1024。日本語の文書注釈アプリ、中央の技術PDF、AI指示と候補確認の右パネル。白とクールグレー、控えめなティール、アンバー、バイオレット。 |
| [`cooling-fan-assembly.png`](../public/examples/cooling-fan-assembly.png) | サンプル仕様書1ページ目 | 工業用冷却ファンの製品写真。部品の輪郭を見分けられ、注釈矩形を置きやすい構図。文字・ロゴなし。 |
| [`cooling-fan-exploded-view.png`](../public/examples/cooling-fan-exploded-view.png) | サンプル仕様書2ページ目 | 冷却ファンの分解図。前面グリル、ローター、モーター、背面ハウジングを分離したモノクロ技術イラスト。文字・番号・引出線なし。 |
| [`maintenance-inspection-photo.png`](../public/examples/maintenance-inspection-photo.png) | サンプル仕様書3ページ目 | 電源を遮断した状態で振動計を使う点検写真。作業者の手元、測定位置、プラグが範囲注釈できる構図。 |
| [`annotation-workflow-guide-v2.png`](../public/examples/annotation-workflow-guide-v2.png) | 「使い方」ガイドで使用中 | 1440 x 900。文書の読み込み、AIへの指示、候補確認、必要部分の抽出を横並びの4ステップで示す。右端の書類には意味のない日付や金額を入れない。 |
| [`annotation-studio-app-icon.png`](../public/examples/annotation-studio-app-icon.png) | Tauriアプリのアイコン原画 | 1024 x 1024。白い文書、ティールの選択枠、アンバーとバイオレットの注釈マークを中心にした、文字なしのアプリアイコン。 |
| [`annotation-workflow-guide.png`](../public/examples/annotation-workflow-guide.png) | 生成初版（画面では不使用） | 同じ4ステップの案。書類内に不要な日付・金額が入ったため、編集版をガイドで使用する。 |

## Prompt set

ImageGenには次の生成指示をそれぞれ個別に送信した。編集指示も別途送信した。各生成物の用途とパスは上表のとおり。

### 画面イメージ

```text
Use case: ui-mockup
Asset type: visual design reference for a desktop document-annotation web app
Primary request: Create one polished, realistic 1440 x 1024 desktop app screen for a Japanese AI-assisted document annotation workspace. The page should feel calm, precise, and easy for a broad range of office and engineering users. Show one uploaded technical PDF page in the center, with two subtle colored rectangle annotations over the operating limits and safety warning. On the right, show a compact AI instruction panel with a clear prompt and a short reviewable list of annotation candidates. Include a narrow left navigation rail and a simple top bar with document title, page controls, save state, and export action.
Style/medium: high-fidelity production SaaS interface screenshot, real UI geometry, clean typography
Composition/framing: full-window desktop app, 1440 x 1024, comfortable spacing, readable controls, document page is primary and remains large
Color palette: warm white canvas, pale cool gray chrome, deep ink text, restrained teal primary actions, amber safety annotation and soft lilac secondary annotation
Text (verbatim): "Annotation Studio", "文書アノテーション", "冷却ファン仕様書.pdf", "ページ 1 / 8", "注釈", "AIに指示", "安全上の警告と締結トルクを抽出", "候補を作成", "確認して追加", "保存済み", "書き出す"
Constraints: Japanese UI labels should be accurate and crisp; no logos, no extraneous cards, no cropped content, no fake brand marks, no watermark.
Avoid: marketing landing page, phone mockup, dark theme, crowded dashboards, random charts, tiny unreadable text
```

### 製造部品の写真

```text
Use case: photorealistic-natural
Asset type: embedded source image on a sample engineering document page inside an annotation application
Primary request: A precise studio photograph of a compact axial cooling fan assembly used in industrial equipment, viewed at a three-quarter angle. Show the dark graphite circular fan housing, clean metal fasteners, central motor hub, and several curved blades. Keep the whole object in frame with clear edges and modest negative space around it.
Scene/backdrop: neutral light-gray engineering photo studio with a soft white background
Style/medium: realistic product photography, understated technical catalog quality
Composition/framing: square 1024 x 1024 crop, single centered object, enough separation from the background for a user to draw annotation boxes around component parts
Lighting/mood: bright softbox light, readable details, calm and neutral
Color palette: graphite, brushed aluminum, muted teal accents, cool gray and white
Constraints: no text, no labels, no logo, no hands, no watermark, no safety symbols, no extraneous objects
```

### 分解図

```text
Use case: scientific-educational
Asset type: unlabelled technical drawing embedded in a sample industrial maintenance PDF for an annotation app
Primary request: A clean exploded-view technical illustration of a compact axial cooling fan assembly. Separate the front grille, five-blade rotor, central motor and rear housing along one shared axis so each component is easy to inspect and annotate. Show believable fasteners and alignment, with enough detail to distinguish the parts.
Style/medium: accurate monochrome engineering line illustration with restrained cool-gray fills and subtle teal accents
Composition/framing: square 1024 x 1024, centered assembly, all parts fully inside frame, clear whitespace between components, white background
Constraints: no words, no numbers, no arrows, no callout lines, no logos, no watermark; mechanically coherent parts, crisp outlines suitable for a technical document
```

### 点検写真

```text
Use case: photorealistic-natural
Asset type: inspection evidence photograph placed on a sample maintenance report page in a document annotation app
Primary request: A close, documentary-style photograph of a maintenance technician inspecting an industrial cooling fan assembly with the power isolated. Show gloved hands holding a handheld vibration meter near the fan motor, a visible disconnected power plug nearby, and the stationary fan in clear view.
Scene/backdrop: clean industrial maintenance bench, softly blurred workshop in the background
Style/medium: realistic professional industrial photography, neutral and trustworthy
Composition/framing: landscape 4:3 image, subject centered with clear edges and useful surrounding context, no crop of the fan or meter
Lighting/mood: bright practical overhead light, clear and safe, no dramatic shadows
Color palette: charcoal machinery, muted teal uniform details, cool neutrals
Constraints: no readable text, no logo, no watermark, no sparks, no running fan, no unsafe action; adult workers only, hands and tools anatomically realistic
```

### 操作ガイド

```text
Use case: infographic-diagram
Asset type: onboarding help illustration for an AI-assisted document annotation app
Primary request: Make a clear, polished four-step horizontal workflow guide that shows how a reviewer uses the app. The four steps are: upload a document, describe what to find, review and adjust proposed regions, export only the selected evidence. Use one simple visual per step: stacked PDF and Office pages, an instruction prompt, a document with two highlighted rectangles, and a cropped image saved as a file. Connect the steps with a subtle line so the order is immediately obvious.
Style/medium: clean modern enterprise illustration, light vector-like editorial artwork with subtle depth
Composition/framing: wide 1440 x 900 canvas, four equally readable steps across the page with generous whitespace; use large step numbers and short captions
Color palette: warm white, pale cool gray, deep ink, teal action color, amber warning highlight, one soft violet accent
Text (verbatim): "1 文書を読み込む", "2 AIに指示する", "3 候補を確認する", "4 必要部分を抽出する"
Constraints: render every Japanese caption exactly as written and make it legible, keep all four steps inside the canvas, no logo, no watermark, no extra copy, no decorative cards within cards
Avoid: dense infographic, tiny text, photorealistic people, dark background, random data charts
```

### 操作ガイドの編集

```text
Use case: precise-object-edit
Asset type: onboarding workflow infographic for a document annotation app
Primary request: Remove only the stray date and yen amount from the small outlined crop card under step 4. Replace those two lines with neutral short gray placeholder rules, with no dates, currency, numbers, or other readable text in that crop card.
Constraints: Keep the exact four Japanese step captions unchanged: "1 文書を読み込む", "2 AIに指示する", "3 候補を確認する", "4 必要部分を抽出する". Preserve all step numbers, arrows, colors, page illustrations, crop selection frame, overall spacing, size, and style. Do not alter any other part of the image.
Avoid: new text, new dates, yen signs, values, new icons, watermarks, composition changes, blur or distortion.
```

### Tauriアプリアイコン

```text
Use case: logo-brand
Asset type: macOS / Windows / Linux desktop app icon for Annotation Studio
Input image: use the attached Annotation Studio screen only as palette and product-style reference; do not reproduce the screenshot.
Primary request: Create a crisp, minimal square app icon for an AI-assisted document annotation workspace. Use one white document sheet with a single teal annotation rectangle around a short gray line, plus a small amber and violet annotation marker. Keep the mark bold and recognizable at 32 x 32 pixels.
Style/medium: simple polished flat vector-like icon rendered as a clean raster asset, balanced geometry, no gradients
Composition/framing: centered mark on a rounded-square tile, 1024 x 1024, generous inset and strong contrast
Color palette: deep ink navy, teal, warm white, small amber and soft-violet accents to match the reference
Constraints: no letters, no words, no numbers, no people, no watermark, transparent or warm-white background only; preserve clean edges and avoid tiny details.
Avoid: full app interface, screenshot, photo, decorative border around the canvas, pseudo-text, complex document pages
```
