export { default as i18n } from '@/modules/i18n/config';
export { default as LanguageSelector } from '@/modules/i18n/LanguageSelector';
// The shipped language list and its entry type. Re-exported because a consumer outside this module
// — chat's voice-error criterion, which has to compare its own locale set against the languages the
// app really ships — may only enter another feature module through its barrel.
export { languages } from '@/modules/i18n/languages';
export type { Language } from '@/modules/i18n/languages';
