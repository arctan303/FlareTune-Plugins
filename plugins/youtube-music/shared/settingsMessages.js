const messages = {
  zh: '断开会移除本站保存的 YouTube 授权；再次使用会员音源时需要重新连接。',
  'zh-Hant': '中斷連線會移除此網站儲存的 YouTube 授權；再次使用會員音源時需要重新連線。',
  en: 'Disconnecting removes this site’s saved YouTube authorization. Reconnect to use Premium audio again.',
  ja: '切断すると、このサイトに保存した YouTube 認証が削除されます。Premium の音源を再び使うには再接続が必要です。',
  ko: '연결을 끊으면 이 사이트에 저장된 YouTube 인증이 삭제됩니다. Premium 음원을 다시 사용하려면 재연결해야 합니다.',
};
export const youtubeSettingsMessage = (_key, locale = 'en') => messages[locale] || messages.en;
