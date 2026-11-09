import React from 'react';
import { useSpeakerOutputStore } from "./outputState.js";
import { t, useLocale } from "@flaretune/plugin-sdk/client/i18n";
import { useSpeakers } from "./useSpeakers.js";
import SettingsSection from "@flaretune/plugin-sdk/client/settings-section";
import SettingsEditDialog from "@flaretune/plugin-sdk/client/settings-dialog";
import SettingsSkeleton from "@flaretune/plugin-sdk/client/settings-skeleton";
import { SettingsActions, SettingsButton, SettingsToggle } from "@flaretune/plugin-sdk/client/settings-controls";
import { SpeakerConnectionPanel, SpeakerFeedback, SpeakerPicker } from "./SpeakerSettings.jsx";

const phaseMessage = (phase) => ({
  ready: '音箱输出已就绪', sending: '正在向音箱发送指令…', playing: '音箱正在播放',
  paused: '音箱已暂停', uncertain: '音箱状态不确定，请先检查音箱。', disconnected: '音箱连接已中断，请检查连接。',
})[phase] || '';

export default function SpeakerOutputSettings({ host, onClose }) {
  useLocale();
  const [session, setSession] = React.useState(() => host.session.get());
  React.useEffect(() => host.session.subscribe(setSession), [host]);
  const installed = host.isCurrent();
  const owner = React.useRef({ accountId: session?.user?.accountId });
  const current = session?.authenticated && owner.current.accountId === session.user?.accountId && host.isCurrent();
  React.useEffect(() => { if (!current) onClose(); }, [current, onClose]);
  if (!current) return null;
  if (!installed) return <SettingsEditDialog title={t('小爱音箱')} size="small" onClose={onClose} closeOnBackdrop>
    <p role="status" className="text-sm text-[var(--muted)]">{t('小米音箱插件尚未安装，请联系管理员。')}</p>
  </SettingsEditDialog>;
  return <SpeakerOutputPanel host={host} onClose={onClose} />;
}

export function SpeakerOutputSection({ host }) {
  const speakers = useSpeakers(host);
  const output = useSpeakerOutputStore();
  const { status, loading, demo } = speakers;
  const devices = status?.devices || [];
  const selected = output.speakerId
    ? devices.find((device) => device.id === output.speakerId && device.supported)
    : devices.find((device) => device.supported);
  const connected = status?.connected && !status.needsReconnect;
  const busy = output.busy || speakers.busy;
  const runOutput = (operation) => {
    try { Promise.resolve(operation()).catch(() => {}); } catch { /* Keep the store's error visible. */ }
  };
  const toggle = (event) => {
    if (busy || demo) return;
    if (!event.target.checked) { runOutput(output.disable); return; }
    if (!connected || !selected) return;
    if (output.speakerId !== selected.id) output.setTarget(selected);
    runOutput(output.enable);
  };
  const stateMessage = output.enabled ? phaseMessage(output.phase) : '音箱输出已关闭';
  return <SettingsSection title={t('播放输出')}>
    <div className="space-y-4">
      <SettingsToggle label={t('启用音箱输出')} checked={output.enabled}
        info={t('启用后，继续使用网页播放器的队列和播放控件。支持 L05B 音箱与 MP3 音频。')}
        disabled={busy || demo || (!output.enabled && (loading || !connected || !selected))} onChange={toggle} />
      {!status && loading ? <SettingsSkeleton compact rows={1} /> : <>
        {devices.length > 0 && <SpeakerPicker devices={devices} selectedId={selected?.id || ''}
          disabled={output.enabled || busy || loading || demo}
          onChange={(id) => {
            const device = devices.find((entry) => entry.id === id && entry.supported);
            if (device && !output.enabled && !busy && !demo) output.setTarget(device);
          }} />}
        {output.enabled && <p role="status" className="break-words text-sm font-medium">
          {t('音箱输出已启用')}{output.deviceName ? ` · ${output.deviceName}` : ''}
        </p>}
        {stateMessage && <p role="status" className="text-sm text-[var(--muted)]">{t(stateMessage)}</p>}
        {demo ? <p role="status" className="text-sm text-[var(--muted)]">{t('演示模式不连接小米账号，也不向音箱发送指令。')}</p>
          : status?.needsReconnect ? <p className="text-sm text-[var(--muted)]">{t('小米授权已失效，请重新连接。')}</p>
            : status && !connected ? <p className="text-sm text-[var(--muted)]">{t('尚未连接小米账号')}</p>
              : status && !selected && <p className="text-sm text-[var(--muted)]">{t('当前没有可用的 L05B 音箱。')}</p>}
      </>}
      {output.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(output.error)}</p>}
      <SpeakerFeedback speakers={speakers} />
    </div>
  </SettingsSection>;
}

export function SpeakerOutputPanel({ host, onClose }) {
  const speakers = useSpeakers(host);
  const output = useSpeakerOutputStore();
  const [manage, setManage] = React.useState(false);
  const { status, loading, demo } = speakers;
  const devices = status?.devices || [];
  const selected = output.speakerId
    ? devices.find((device) => device.id === output.speakerId && device.supported)
    : devices.find((device) => device.supported);
  const connected = status?.connected && !status.needsReconnect;
  const busy = output.busy || speakers.busy;
  const runOutput = (operation) => {
    // The output store owns the safe error state; rejected operations must not
    // escape an event handler or trigger any automatic retry.
    try { Promise.resolve(operation()).catch(() => {}); } catch { /* Keep the store's error visible. */ }
  };
  const toggle = (event) => {
    if (busy || demo) return;
    if (!event.target.checked) { runOutput(output.disable); return; }
    if (!connected || !selected) return;
    if (output.speakerId !== selected.id) output.setTarget(selected);
    runOutput(output.enable);
  };
  const stateMessage = output.enabled ? phaseMessage(output.phase) : '音箱输出已关闭';
  return <SettingsEditDialog title={t('音箱输出')} onClose={onClose} busy={busy} size="small" closeOnBackdrop>
    {manage ? <div className="space-y-4">
      <SpeakerConnectionPanel speakers={speakers} />
      <SettingsActions><SettingsButton disabled={busy} onClick={() => setManage(false)}>{t('返回音箱输出')}</SettingsButton></SettingsActions>
    </div> : <div className="space-y-4">
      <SettingsToggle label={t('启用音箱输出')} checked={output.enabled}
        info={t('启用后，继续使用网页播放器的队列和播放控件。支持 L05B 音箱与 MP3 音频。')}
        disabled={busy || demo || (!output.enabled && (loading || !connected || !selected))} onChange={toggle} />
      {!status && loading ? <SettingsSkeleton compact rows={1} /> : <>
        {devices.length > 0 && <SpeakerPicker devices={devices} selectedId={selected?.id || ''}
          disabled={output.enabled || busy || loading || demo}
          onChange={(id) => {
            const device = devices.find((entry) => entry.id === id && entry.supported);
            if (device && !output.enabled && !busy && !demo) output.setTarget(device);
          }} />}
        {output.enabled && <p role="status" className="break-words text-sm font-medium">
          {t('音箱输出已启用')}{output.deviceName ? ` · ${output.deviceName}` : ''}
        </p>}
        {stateMessage && <p role="status" className="text-sm text-[var(--muted)]">{t(stateMessage)}</p>}
        {demo ? <p role="status" className="text-sm text-[var(--muted)]">{t('演示模式不连接小米账号，也不向音箱发送指令。')}</p>
          : status?.needsReconnect ? <p className="text-sm text-[var(--muted)]">{t('小米授权已失效，请重新连接。')}</p>
            : status && !connected ? <p className="text-sm text-[var(--muted)]">{t('尚未连接小米账号')}</p>
              : status && !selected && <p className="text-sm text-[var(--muted)]">{t('当前没有可用的 L05B 音箱。')}</p>}
      </>}
      {output.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(output.error)}</p>}
      <SpeakerFeedback speakers={speakers} />
      <SettingsActions>
        <SettingsButton disabled={busy} onClick={() => setManage(true)}>{t('管理连接')}</SettingsButton>
      </SettingsActions>
    </div>}
  </SettingsEditDialog>;
}
