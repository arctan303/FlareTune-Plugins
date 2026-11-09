// The host owns authenticated transport, build headers and installation lifetime.
export function createSpeakerSessionGuard(host) {
  const controller = new AbortController();
  const isCurrent = () => { const current = !controller.signal.aborted && host.isCurrent(); if (!current) controller.abort(); return current; };
  const assertCurrent = () => { if (!isCurrent()) throw new DOMException('Speaker session ended', 'AbortError'); };
  return { signal: controller.signal, isCurrent, assertCurrent, close: () => controller.abort(),
    async run(operation) { assertCurrent(); const result = await operation(controller.signal); assertCurrent(); return result; } };
}
export async function speakerRequest(action, host, body, { signal } = {}) {
  if (host.environment?.demo) throw Object.assign(new Error('speaker_demo_disabled'), { status: 403, code: 'speaker_demo_disabled' });
  const method = action === 'status' ? 'GET' : action === 'disconnect' ? 'DELETE' : 'POST';
  const suffix = { status: '', disconnect: '', login: 'login', poll: 'login/poll', devices: 'devices', play: 'play',
    stop: 'stop', test: 'test', state: 'state', pause: 'pause', resume: 'resume', volume: 'volume', seek: 'seek' }[action];
  if (suffix === undefined) throw new TypeError('Unknown speaker action');
  return host.request(suffix, { method, ...(method === 'GET' ? {} : { body: body || {} }), signal });
}

export const speakerOutcomeMessage = (outcome) => outcome === 'sent' ? '指令已发送，请检查音箱。'
  : outcome === 'failed' ? '指令发送失败，请检查连接后重试。'
    : '下发状态不确定，请先检查音箱，避免重复播放。';

export const isSpeakerMp3 = (song) => /\.mp3(?:[?#]|$)/iu.test(song?.audio_url || '');

export const speakerErrorMessage = (code) => ({
  PLUGIN_NOT_INSTALLED: '小米音箱插件尚未安装，请联系管理员。',
  PLUGIN_BUILD_MISMATCH: '插件版本与当前网页不兼容，请刷新网页后重试。',
  SPEAKER_RECONNECT_REQUIRED: '小米授权已失效，请重新连接。',
  XIAOMI_AUTH_EXPIRED: '小米授权已失效，请重新连接。',
  SPEAKER_BUSY: '音箱正在处理上一条指令，请稍候后手动重试。',
  SPEAKER_CHANGED: '音箱列表已变化，请刷新后重新选择。',
  SPEAKER_MP3_REQUIRED: '这首歌曲不是 MP3，暂时无法投放。',
  SPEAKER_HTTPS_REQUIRED: '音箱播放需要公开可访问的 HTTPS 地址，请联系管理员检查实例地址。',
  SPEAKER_SESSION_EXPIRING: '当前会话即将过期，请重新登录后再投放。',
  SPEAKER_RATE_LIMITED: '音箱请求过于频繁，请稍后手动重试。',
})[code] || '';
