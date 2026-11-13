// Package-owned messages; shared setting labels are also declared in manifest.messages.
export const workbenchMessages = Object.freeze({
  "zh": {
    "policy": "歌词策略",
    "onlineEnabled": "联网获取歌词",
    "lyricPreference": "歌词偏好",
    "preferWord": "逐字优先",
    "preferLine": "逐行即可",
    "aiCompletion": "歌词 AI",
    "enabled": "已启用",
    "off": "关闭",
    "onlineDisabled": "联网获取歌词已关闭",
    "translationFailed": "歌词翻译失败，请重试。",
    "cleanupWithDraft": "同时清理非歌词行",
    "draftCompleted": "AI 已补全草稿，检查后保存即可共享。",
    "draftCleaned": "AI 已补全并清理草稿，检查后保存即可共享。"
  },
  "zh-Hant": {
    "policy": "歌詞策略",
    "onlineEnabled": "連網取得歌詞",
    "lyricPreference": "歌詞偏好",
    "preferWord": "逐字優先",
    "preferLine": "逐行即可",
    "aiCompletion": "歌詞 AI",
    "enabled": "已啟用",
    "off": "關閉",
    "onlineDisabled": "連網取得歌詞已關閉",
    "translationFailed": "歌詞翻譯失敗，請重試。",
    "cleanupWithDraft": "同時清理非歌詞行",
    "draftCompleted": "AI 已補全草稿，檢查後儲存即可共用。",
    "draftCleaned": "AI 已補全並清理草稿，檢查後儲存即可共用。"
  },
  "en": {
    "policy": "Lyric policy",
    "onlineEnabled": "Fetch lyrics online",
    "lyricPreference": "Lyric preference",
    "preferWord": "Prefer word timing",
    "preferLine": "Line timing is enough",
    "aiCompletion": "Lyrics AI",
    "enabled": "Enabled",
    "off": "Off",
    "onlineDisabled": "Online lyric retrieval is disabled",
    "translationFailed": "Could not translate the lyrics. Please try again.",
    "cleanupWithDraft": "Also remove non-lyric lines",
    "draftCompleted": "AI completed the draft. Review and save it to share the result.",
    "draftCleaned": "AI completed the draft and removed non-lyric lines. Review and save it to share the result."
  },
  "ja": {
    "policy": "歌詞の設定",
    "onlineEnabled": "オンラインで歌詞を取得",
    "lyricPreference": "歌詞の優先設定",
    "preferWord": "単語ごとの同期を優先",
    "preferLine": "行ごとの同期で十分",
    "aiCompletion": "歌詞 AI",
    "enabled": "有効",
    "off": "オフ",
    "onlineDisabled": "オンライン歌詞取得は無効です",
    "translationFailed": "歌詞を翻訳できませんでした。再試行してください。",
    "cleanupWithDraft": "歌詞以外の行も整理する",
    "draftCompleted": "AI による下書きの補完が完了しました。内容を確認し、保存すると共有されます。",
    "draftCleaned": "AI による下書きの補完と歌詞以外の行の整理が完了しました。内容を確認し、保存すると共有されます。"
  },
  "ko": {
    "policy": "가사 정책",
    "onlineEnabled": "온라인 가사 가져오기",
    "lyricPreference": "가사 기본 설정",
    "preferWord": "단어 동기화 우선",
    "preferLine": "줄 동기화로 충분",
    "aiCompletion": "가사 AI",
    "enabled": "사용 중",
    "off": "끄기",
    "onlineDisabled": "온라인 가사 가져오기가 꺼져 있습니다",
    "translationFailed": "가사를 번역하지 못했습니다. 다시 시도해 주세요.",
    "cleanupWithDraft": "가사가 아닌 줄도 정리",
    "draftCompleted": "AI가 초안을 완성했습니다. 확인 후 저장하면 결과가 공유됩니다.",
    "draftCleaned": "AI가 초안을 완성하고 가사가 아닌 줄을 정리했습니다. 확인 후 저장하면 결과가 공유됩니다."
  }
});
export function workbenchMessage(key, locale = 'en') {
  const normalized = String(locale).replaceAll('_', '-').toLowerCase();
  const language = normalized.startsWith('zh') ? (/hant|tw|hk/u.test(normalized) ? 'zh-Hant' : 'zh') : normalized.split('-')[0];
  return workbenchMessages[language]?.[key] || workbenchMessages.en[key] || key;
}
