import React from 'react';
import { t, useLocale } from "@flaretune/plugin-sdk/client/i18n";
import { useSpeakers } from "./useSpeakers.js";
import SettingsSection from "@flaretune/plugin-sdk/client/settings-section";
import SettingsEditDialog from "@flaretune/plugin-sdk/client/settings-dialog";
import SettingsSkeleton from "@flaretune/plugin-sdk/client/settings-skeleton";
import { SettingsActions, SettingsButton } from "@flaretune/plugin-sdk/client/settings-controls";
import SelectControl from "@flaretune/plugin-sdk/client/select-control";

export function SpeakerPrivacy() {
  return <p className="text-xs leading-relaxed text-[var(--muted)]">{t('授权将按你的 FlareTune 账号加密保存在后端。播放时，小米会收到限时单曲链接。解绑会撤销后续请求，已缓冲的音频无法收回。')}</p>;
}

export function SpeakerFeedback({ speakers }) {
  return <>
    {speakers.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(speakers.error)}</p>}
    {speakers.message && <p role="status" className="text-sm leading-relaxed text-[var(--ink)]">{t(speakers.message)}</p>}
    {speakers.busy && <p role="status" className="text-xs text-[var(--muted)]">{t('正在处理音箱请求…')}</p>}
  </>;
}

export function SpeakerPicker({ devices, selectedId, onChange, disabled }) {
  return <div className="space-y-2">
    <p id="speaker-device-label" className="text-sm font-medium">{t('选择音箱')}</p>
    <SelectControl value={selectedId || ''} aria-labelledby="speaker-device-label" disabled={disabled || !devices.length}
      onChange={(event) => onChange(event.target.value)} className="w-full">
      {!selectedId && <option value="" disabled>{t('请选择支持的音箱')}</option>}
      {devices.map((device) => <option key={device.id} value={device.id} disabled={!device.supported}>
        {device.name || device.hardware}{device.supported ? '' : ` · ${t('暂不支持此型号')}`}
      </option>)}
    </SelectControl>
  </div>;
}

export function SpeakerConnectionPanel({ speakers, section = 'all' }) {
  const { status, loading, busy, qr, polling, demo } = speakers;
  const devices = status?.devices || [];
  const disabled = busy || loading || polling || demo;
  const showConnection = section !== 'devices';
  const showDevices = section !== 'connection';
  return <div className="space-y-4">
    {showConnection && !status?.connected && !status?.needsReconnect && <SpeakerPrivacy />}
    {demo ? <p role="status" className="text-sm text-[var(--muted)]">{t('演示模式不连接小米账号，也不向音箱发送指令。')}</p>
      : !status && loading ? <SettingsSkeleton compact rows={1} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {status && <p className="text-sm font-medium text-[var(--ink)]">{t(status.needsReconnect ? '小米授权已失效，请重新连接。'
            : status.connected ? '已连接小米账号' : '尚未连接小米账号')}</p>}
          {!status && !loading && <SettingsButton disabled={busy} onClick={speakers.refresh}>{t('重试')}</SettingsButton>}
          {showConnection && status && <SettingsActions>
            {(!status.connected || status.needsReconnect) && <SettingsButton variant="primary" disabled={disabled} onClick={speakers.connect}>
              {t(qr ? '重新生成二维码' : '连接小米账号')}
            </SettingsButton>}
          </SettingsActions>}
        </div>
        {showConnection && qr && <div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <p className="text-sm text-[var(--muted)]">{t('使用米家 App 扫描二维码，并确认授权。')}</p>
          <img src={qr.qrDataUrl} alt={t('小米账号授权二维码')} width="224" height="224"
            className="mx-auto h-56 w-56 max-w-full rounded-xl bg-white object-contain p-3" />
          <p role="status" className="text-center text-xs text-[var(--muted)]">
            {t(polling ? '等待扫码授权…' : '自动检查已停止，请手动重试。')}
          </p>
          {!polling && <SettingsActions>
            <SettingsButton disabled={busy || Date.now() >= qr.expiresAt} onClick={speakers.retryLogin}>{t('重试检查授权')}</SettingsButton>
          </SettingsActions>}
        </div>}
        {showDevices && status?.connected && !status.needsReconnect && <div className="space-y-3">
          {devices.length ? <ul className="divide-y divide-[var(--line)] text-sm">
            {devices.map((device) => <li key={device.id} className="break-words py-2 first:pt-0 last:pb-0">
              <span className="font-medium text-[var(--ink)]">{device.name || device.hardware}</span>
              {!device.supported && <span className="text-xs text-[var(--muted)]">{` · ${t('暂不支持此型号')}`}</span>}
            </li>)}
          </ul>
            : <p className="text-sm text-[var(--muted)]">{t('当前没有可用的 L05B 音箱。')}</p>}
          <SettingsActions>
            <SettingsButton disabled={disabled} onClick={speakers.refreshDevices}>{t('刷新音箱列表')}</SettingsButton>
          </SettingsActions>
        </div>}
      </>}
    <SpeakerFeedback speakers={speakers} />
    {showConnection && !demo && (status?.connected || status?.needsReconnect) && <div className="space-y-3 border-t border-[var(--line)] pt-4">
      <SpeakerPrivacy />
      <SettingsActions><SettingsButton variant="danger" disabled={disabled} onClick={speakers.disconnect}>{t('解绑小米账号')}</SettingsButton></SettingsActions>
    </div>}
  </div>;
}

export function SpeakerPluginSettings({ host, section }) {
  const speakers = useSpeakers(host);
  return <SettingsSection title={t(section === 'devices' ? '音箱设备' : '账号连接')}>
    {section === 'devices' && speakers.status && (!speakers.status.connected || speakers.status.needsReconnect)
      && <p className="mb-3 text-sm text-[var(--muted)]">{t('请先在账号连接中连接本人的小米账号。')}</p>}
    <SpeakerConnectionPanel speakers={speakers} section={section} />
  </SettingsSection>;
}

function SpeakerManager({ host, onClose, onStatus }) {
  const speakers = useSpeakers(host, { onStatus });
  return <SettingsEditDialog title={t('小爱音箱')} size="small" onClose={onClose} busy={speakers.busy} closeOnBackdrop>
    <SpeakerConnectionPanel speakers={speakers} />
  </SettingsEditDialog>;
}

export default function SpeakerSettings({ host }) {
  useLocale();
  const speakers = useSpeakers(host);
  const [open, setOpen] = React.useState(false);
  const { status, demo, loading, error } = speakers;
  return <SettingsSection title={t('小爱音箱')} action={<SettingsButton onClick={() => setOpen(true)}>{t('管理')}</SettingsButton>}>
    {!status && loading ? <SettingsSkeleton compact rows={1} /> : <p className="text-xs text-[var(--muted)]">
      {t(demo ? '演示模式不连接小米账号，也不向音箱发送指令。' : error ? '音箱连接信息加载失败，请重试。'
        : status?.needsReconnect ? '小米授权已失效，请重新连接。' : status?.connected ? '已连接小米账号' : '尚未连接小米账号')}
    </p>}
    {open && <SpeakerManager host={host} onClose={() => setOpen(false)} onStatus={speakers.setStatus} />}
  </SettingsSection>;
}
