import { getLocale } from '@flaretune/plugin-sdk/client/i18n';
const messages = {
  zh: ['需要完成插件更新，请联系管理员。', 'AI 网关不可用，请安装或更新 AI 网关。', '已保存的供应商不存在，请联系管理员重新选择。', '尚未配置 AI 模型，请联系管理员。', 'AI 模型配置已失效，请联系管理员重新选择。'],
  'zh-Hant': ['需要完成外掛更新，請聯絡管理員。', 'AI 閘道無法使用，請安裝或更新 AI 閘道。', '已儲存的供應商不存在，請聯絡管理員重新選擇。', '尚未設定 AI 模型，請聯絡管理員。', 'AI 模型設定已失效，請聯絡管理員重新選擇。'],
  en: ['Complete the plugin update. Contact an administrator.', 'AI gateway is unavailable. Install or update AI gateway.', 'The saved provider no longer exists. Ask an administrator to select it again.', 'No AI model is configured. Contact an administrator.', 'The AI model configuration is no longer valid. Ask an administrator to select it again.'],
  ja: ['プラグインの更新が必要です。管理者に連絡してください。', 'AI ゲートウェイを利用できません。インストールまたは更新してください。', '保存されたプロバイダーがありません。管理者に再設定を依頼してください。', 'AI モデルが未設定です。管理者に連絡してください。', 'AI モデルの設定が無効です。管理者に再設定を依頼してください。'],
  ko: ['플러그인 업데이트가 필요합니다. 관리자에게 문의하세요.', 'AI 게이트웨이를 사용할 수 없습니다. 설치하거나 업데이트하세요.', '저장된 공급자가 없습니다. 관리자에게 다시 선택하도록 요청하세요.', 'AI 모델이 설정되지 않았습니다. 관리자에게 문의하세요.', 'AI 모델 설정이 유효하지 않습니다. 관리자에게 다시 선택하도록 요청하세요.'],
};
export function modelErrorMessage(error) {
  const code = error?.code || error?.message;
  const index = { PLUGIN_UPDATE_REQUIRED: 0, AI_PROVIDER_MISSING: 2, AI_PROVIDER_UNCONFIGURED: 3, AI_CONFIG_INVALID: 4,
    PLUGIN_SERVICE_CONFIGURATION_CHANGED: 4 }[code] ?? (/^PLUGIN_(?:DEPENDENCY|SERVICE|NOT_INSTALLED|API|VERSION)/u.test(code || '') ? 1 : -1);
  return index < 0 ? null : (messages[getLocale()] || messages.en)[index];
}
