import React from 'react';
import { Compass, Loader2, RotateCcw } from 'lucide-react';
import { t, useLocale } from '@flaretune/plugin-sdk';
import { useRoamState } from './state.js';

export default function QueueFooter({ authenticated, actions }) {
  useLocale();
  const randomRoam = useRoamState();
  if (!randomRoam.available) return null;
  const isRoamLibraryQueued = randomRoam.enabled && randomRoam.exhausted;
  const handleRoamToggle = actions.toggleFromQueue;
  const retryRandomRoam = actions.retryRandomRoam;
  return (<div className="flex items-center gap-2.5 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                    <Compass size={17} className={`shrink-0 ${randomRoam.enabled ? 'text-[var(--accent)]' : 'text-[var(--muted)] opacity-70'}`} aria-hidden="true" />
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-xs font-semibold text-[var(--ink)] leading-snug whitespace-normal break-words">{t("队尾随机续播")}</span>
                                        <span className="text-[10px] text-[var(--muted)] leading-snug truncate max-w-[125px]">
                                            {randomRoam.status === 'exhausted'
                                                ? t("暂无可补充歌曲")
                                                : randomRoam.status === 'loading'
                                                    ? t("正在寻找…")
                                                    : randomRoam.status === 'error'
                                                        ? t("重试续播")
                                                        : randomRoam.enabled && !authenticated
                                                            ? t("未登录暂停")
                                                            : isRoamLibraryQueued
                                                                ? t("暂无可补充歌曲")
                                                                : t("队尾自动补充")}
                                        </span>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={randomRoam.enabled}
                                    aria-label={t("队尾随机续播")}
                                    onClick={handleRoamToggle}
                                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                                        randomRoam.enabled ? 'bg-[var(--accent)]' : 'bg-slate-300 dark:bg-slate-600'
                                    }`}
                                >
                                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                                        randomRoam.enabled ? 'translate-x-5' : 'translate-x-0'
                                    }`} />
                                </button>
                                {/* 状态反馈固定位：放于开关后面，避免开关位移 */}
                                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                                    {randomRoam.status === 'loading' ? (
                                        <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent)]" aria-label={t("正在加载续播歌曲")} />
                                    ) : randomRoam.status === 'error' && randomRoam.enabled ? (
                                        <button
                                            type="button"
                                            onClick={retryRandomRoam}
                                            className="text-button text-xs font-medium p-0.5 text-[var(--accent)] hover:scale-110 active:scale-95 transition-transform"
                                            title={t("重试续播")}
                                        >
                                            <RotateCcw size={12} aria-hidden="true" />
                                        </button>
                                    ) : null}
                                </div>
                            </div>);
}
