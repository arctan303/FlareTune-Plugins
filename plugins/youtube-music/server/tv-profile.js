// Reused from yt-dlp's merged tv_samsung fixes: PR #17805 / #17723.
export const SAMSUNG_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';
export function applySamsungProfile(session) {
  Object.assign(session.context.client, { clientName: 'TVHTML5', clientVersion: '5.20260707',
    deviceMake: 'Samsung', deviceModel: 'UKS9800', userAgent: SAMSUNG_UA, osName: 'Tizen', osVersion: '2.4.0' });
  for (const key of ['browserName', 'browserVersion', 'configInfo']) delete session.context.client[key];
  session.user_agent = SAMSUNG_UA;
}
