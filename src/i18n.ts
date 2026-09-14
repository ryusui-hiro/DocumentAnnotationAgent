import { useSyncExternalStore } from 'react';
import { loadLanguage, persistLanguage, type UiLanguage } from './settings';
import { uiTranslations } from './translations-ui';
import { messageTranslations } from './translations-messages';

export type { UiLanguage } from './settings';
export type TranslationValues = Record<string, string | number>;
export const languages: ReadonlyArray<{ id: UiLanguage; label: string }> = [
  { id: 'ja', label: '日本語' }, { id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' },
];
const translations: Record<string, readonly [string, string]> = { ...messageTranslations, ...uiTranslations };
let currentLanguage = loadLanguage();
const listeners = new Set<() => void>();

export function interpolate(message: string, values: TranslationValues = {}) {
  return message.replace(/\{(\w+)\}/gu, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function translateFor(language: UiLanguage, message: string, values?: TranslationValues): string {
  const translation = translations[message];
  return interpolate(language === 'ja' || !translation ? message : translation[language === 'en' ? 0 : 1], values);
}

/** Translate application-owned messages only; user and document content stays untouched. */
export function translate(message: string, values?: TranslationValues) {
  return translateFor(currentLanguage, message, values);
}

export function tr(messages: Record<UiLanguage, string>, values?: TranslationValues) {
  return interpolate(messages[currentLanguage], values);
}

export function setLanguage(language: UiLanguage) {
  if (!languages.some((entry) => entry.id === language)) return;
  persistLanguage(language);
  if (currentLanguage === language) return;
  currentLanguage = language;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useI18n() {
  const language = useSyncExternalStore(subscribe, () => currentLanguage, () => 'en' as UiLanguage);
  return { language, setLanguage, t: translate, tr };
}
