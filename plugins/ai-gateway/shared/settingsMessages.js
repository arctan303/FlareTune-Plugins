const messages = {
  zh: '删除会移除此供应商连接和已保存的密钥。',
  'zh-Hant': '刪除會移除此供應商連線及儲存的金鑰。',
  en: 'Deleting removes this provider connection and its saved key.',
  ja: '削除すると、このプロバイダー接続と保存済みキーが削除されます。',
  ko: '삭제하면 이 공급자 연결과 저장된 키가 제거됩니다.',
};
export const gatewayDeleteConsequence = (locale = 'en') => messages[locale] || messages.en;
