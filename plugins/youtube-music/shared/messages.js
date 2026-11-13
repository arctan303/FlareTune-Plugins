const en = {
  retry: 'Retry', preferences: 'Music source settings', metadataLanguage: 'Metadata language', region: 'Region',
  lyricsEnabled: 'Provide lyrics', translationEnabled: 'Get YouTube lyric translations',
  translationLanguage: 'Translation language', save: 'Save settings', saving: 'Saving…',
  settingsError: 'Could not load YouTube settings. Try again.', saveError: 'Could not save YouTube settings. Reload and try again.',
  saved: 'Settings saved.', translationUnavailable: 'YouTube lyric translation is temporarily unavailable.',
  alignmentFailed: 'YouTube translation could not be matched to the lyric lines.', lyricsChanged: 'The lyrics changed. Reload them before requesting a translation.',
  en: 'English', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', ja: 'Japanese', ko: 'Korean',
};
export const youtubeMessages = Object.freeze({
  en,
  zh: { retry: '重试', preferences: '音乐源设置', metadataLanguage: '资料语言', region: '地区', lyricsEnabled: '提供歌词',
    translationEnabled: '获取 YouTube 歌词翻译', translationLanguage: '译文语言', save: '保存设置', saving: '正在保存…',
    settingsError: '无法读取 YouTube 设置，请重试。', saveError: '无法保存 YouTube 设置，请重新加载后重试。',
    saved: '设置已保存。', translationUnavailable: 'YouTube 歌词翻译暂不可用。', alignmentFailed: 'YouTube 译文无法与歌词逐行对应。',
    lyricsChanged: '歌词已更新，请重新加载后再请求翻译。', en: '英语', 'zh-CN': '简体中文', 'zh-TW': '繁体中文', ja: '日语', ko: '韩语' },
  'zh-Hant': { retry: '重試', preferences: '音樂來源設定', metadataLanguage: '資料語言', region: '地區', lyricsEnabled: '提供歌詞',
    translationEnabled: '取得 YouTube 歌詞翻譯', translationLanguage: '譯文語言', save: '儲存設定', saving: '正在儲存…',
    settingsError: '無法讀取 YouTube 設定，請重試。', saveError: '無法儲存 YouTube 設定，請重新載入後重試。',
    saved: '設定已儲存。', translationUnavailable: 'YouTube 歌詞翻譯暫時無法使用。', alignmentFailed: 'YouTube 譯文無法與歌詞逐行對應。',
    lyricsChanged: '歌詞已更新，請重新載入後再要求翻譯。', en: '英語', 'zh-CN': '簡體中文', 'zh-TW': '繁體中文', ja: '日語', ko: '韓語' },
  ja: { retry: '再試行', preferences: '音楽ソースの設定', metadataLanguage: '楽曲情報の言語', region: '地域', lyricsEnabled: '歌詞を提供',
    translationEnabled: 'YouTube の歌詞翻訳を取得', translationLanguage: '翻訳先の言語', save: '設定を保存', saving: '保存中…',
    settingsError: 'YouTube の設定を読み込めませんでした。もう一度お試しください。', saveError: 'YouTube の設定を保存できませんでした。再読み込みしてお試しください。',
    saved: '設定を保存しました。', translationUnavailable: 'YouTube の歌詞翻訳は一時的に利用できません。', alignmentFailed: 'YouTube の翻訳を歌詞の行に対応付けできませんでした。',
    lyricsChanged: '歌詞が更新されました。再読み込みしてから翻訳をリクエストしてください。', en: '英語', 'zh-CN': '簡体字中国語', 'zh-TW': '繁体字中国語', ja: '日本語', ko: '韓国語' },
  ko: { retry: '다시 시도', preferences: '음악 소스 설정', metadataLanguage: '곡 정보 언어', region: '지역', lyricsEnabled: '가사 제공',
    translationEnabled: 'YouTube 가사 번역 가져오기', translationLanguage: '번역 언어', save: '설정 저장', saving: '저장 중…',
    settingsError: 'YouTube 설정을 불러오지 못했습니다. 다시 시도해 주세요.', saveError: 'YouTube 설정을 저장하지 못했습니다. 새로고침 후 다시 시도해 주세요.',
    saved: '설정이 저장되었습니다.', translationUnavailable: 'YouTube 가사 번역을 일시적으로 사용할 수 없습니다.', alignmentFailed: 'YouTube 번역을 가사 행에 맞출 수 없습니다.',
    lyricsChanged: '가사가 변경되었습니다. 새로고침 후 번역을 요청해 주세요.', en: '영어', 'zh-CN': '중국어 간체', 'zh-TW': '중국어 번체', ja: '일본어', ko: '한국어' },
});
export function youtubeMessage(key, locale = 'en') {
  const normalized = String(locale).replaceAll('_', '-').toLowerCase();
  const language = normalized.startsWith('zh') ? (/hant|tw|hk/u.test(normalized) ? 'zh-Hant' : 'zh') : normalized.split('-')[0];
  return youtubeMessages[language]?.[key] || en[key] || key;
}
