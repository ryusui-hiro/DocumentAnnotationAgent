import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { interpolate, setLanguage, translateFor, tr } from './i18n';
import { uiTranslations } from './translations-ui';
import { messageTranslations } from './translations-messages';
import SettingsDialog from './components/SettingsDialog';
import { defaultSettings, emptyUsageTotals } from './settings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();

test('all translated messages preserve interpolation values in both languages', () => {
  for (const [source, translations] of Object.entries({ ...messageTranslations, ...uiTranslations })) {
    for (const translation of translations) {
      assert.ok(translation.trim(), `empty translation: ${source}`);
      assert.deepEqual(placeholders(translation), placeholders(source), `placeholder mismatch: ${source}`);
    }
  }
});

test('interpolation keeps source document text and model output verbatim', () => {
  const evidence = '確認待ち <script>not executable</script> {value2} 中文';
  assert.equal(interpolate('{evidence} · {count}', { evidence, count: 12 }), `${evidence} · 12`);
  assert.equal(translateFor('en', '{value1} をダウンロードしました。', { value1: evidence }), `Downloaded ${evidence}.`);
  assert.equal(translateFor('ja', '未登録のユーザー本文'), '未登録のユーザー本文');
  assert.equal(translateFor('zh-CN', 'A document-specific custom label'), 'A document-specific custom label');
  assert.equal(interpolate('{missing}'), '{missing}');
});

test('App and Settings translate every explicitly marked literal without fallback', () => {
  const dictionary = { ...messageTranslations, ...uiTranslations };
  for (const relativePath of ['./App.tsx', './components/SettingsDialog.tsx']) {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    const scanner = createScanner(true, undefined, readFileSync(path, 'utf8'));
    let previous = SyntaxKind.Unknown;
    for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
      if (token !== SyntaxKind.Identifier || scanner.getTokenValue() !== 't' || previous === SyntaxKind.DotToken) {
        previous = token;
        continue;
      }
      const openParen = scanner.scan();
      if (openParen !== SyntaxKind.OpenParenToken) {
        previous = openParen;
        continue;
      }
      const firstArgument = scanner.scan();
      if (firstArgument === SyntaxKind.StringLiteral) {
        const literal = scanner.getTokenValue();
        assert.ok(Object.hasOwn(dictionary, literal), `Missing translation: ${literal}`);
      }
      previous = firstArgument;
    }
  }
});

test('settings labels render in English and Simplified Chinese while entered values remain unchanged', () => {
  const render = () => renderToStaticMarkup(createElement(SettingsDialog, {
    open: true, desktop: false,
    settings: { ...defaultSettings, azureDeployment: '用户自定义deployment', provider: 'azure-openai' },
    apiKey: '', usage: emptyUsageTotals, codexModels: [], codexModelsLoading: false,
    connectionTest: { status: 'idle', message: '' }, onChange() {}, onApiKeyChange() {}, onSave() {}, onClose() {},
    onTestConnection() {}, onRefreshCodexModels() {}, onResetUsage() {},
  }));
  try {
    setLanguage('en');
    const englishHeading = translateFor('en', '接続と使用量');
    assert.notEqual(englishHeading, '接続と使用量');
    assert.ok(render().includes(`<h2 id="settings-title">${englishHeading.replaceAll('&', '&amp;')}</h2>`));
    assert.match(render(), /用户自定义deployment/);
    setLanguage('zh-CN');
    const chineseHeading = translateFor('zh-CN', '接続と使用量');
    assert.notEqual(chineseHeading, '接続と使用量');
    assert.ok(render().includes(`<h2 id="settings-title">${chineseHeading}</h2>`));
    assert.match(render(), /用户自定义deployment/);
    assert.equal(tr({ ja: '日本語', en: 'English', 'zh-CN': '简体中文' }), '简体中文');
  } finally { setLanguage('ja'); }
});
