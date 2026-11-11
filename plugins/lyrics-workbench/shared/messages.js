// Keep these package-owned messages aligned with manifest.messages.
export const workbenchMessages = Object.freeze({
  "zh": {
    "policy": "歌词策略",
    "onlineEnabled": "联网获取歌词",
    "lyricPreference": "歌词偏好",
    "preferWord": "逐字优先",
    "preferLine": "逐行即可",
    "aiCompletion": "AI 补全",
    "off": "关闭",
    "manual": "仅手动",
    "automatic": "自动补译",
    "onlineDisabled": "联网获取歌词已关闭",
    "translationFailed": "歌词翻译失败，请重试。"
  },
  "zh-Hant": {
    "policy": "歌詞策略",
    "onlineEnabled": "連網取得歌詞",
    "lyricPreference": "歌詞偏好",
    "preferWord": "逐字優先",
    "preferLine": "逐行即可",
    "aiCompletion": "AI 補全",
    "off": "關閉",
    "manual": "僅手動",
    "automatic": "自動補譯",
    "onlineDisabled": "連網取得歌詞已關閉",
    "translationFailed": "歌詞翻譯失敗，請重試。"
  },
  "en": {
    "policy": "Lyric policy",
    "onlineEnabled": "Fetch lyrics online",
    "lyricPreference": "Lyric preference",
    "preferWord": "Prefer word timing",
    "preferLine": "Line timing is enough",
    "aiCompletion": "AI completion",
    "off": "Off",
    "manual": "Manual only",
    "automatic": "Translate automatically",
    "onlineDisabled": "Online lyric retrieval is disabled",
    "translationFailed": "Could not translate the lyrics. Please try again."
  },
  "ja": {
    "policy": "歌詞の設定",
    "onlineEnabled": "オンラインで歌詞を取得",
    "lyricPreference": "歌詞の優先設定",
    "preferWord": "単語ごとの同期を優先",
    "preferLine": "行ごとの同期で十分",
    "aiCompletion": "AI 補完",
    "off": "オフ",
    "manual": "手動のみ",
    "automatic": "不足する翻訳を自動補完",
    "onlineDisabled": "オンライン歌詞取得は無効です",
    "translationFailed": "歌詞を翻訳できませんでした。再試行してください。"
  },
  "ko": {
    "policy": "가사 정책",
    "onlineEnabled": "온라인 가사 가져오기",
    "lyricPreference": "가사 기본 설정",
    "preferWord": "단어 동기화 우선",
    "preferLine": "줄 동기화로 충분",
    "aiCompletion": "AI 보완",
    "off": "끄기",
    "manual": "수동만",
    "automatic": "누락된 번역 자동 보완",
    "onlineDisabled": "온라인 가사 가져오기가 꺼져 있습니다",
    "translationFailed": "가사를 번역하지 못했습니다. 다시 시도해 주세요."
  }
});
export function workbenchMessage(key, locale = 'en') {
  const normalized = String(locale).replaceAll('_', '-').toLowerCase();
  const language = normalized.startsWith('zh') ? (/hant|tw|hk/u.test(normalized) ? 'zh-Hant' : 'zh') : normalized.split('-')[0];
  return workbenchMessages[language]?.[key] || workbenchMessages.en[key] || key;
}
