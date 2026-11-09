import { t, useLocale } from "@flaretune/plugin-sdk";
import React, { useMemo, useCallback } from 'react';
import {
    Play,
    Power,
} from 'lucide-react';
import {
    ROAM_LANGUAGES,
    getMatchingRoamLanguageKey,
    getRoamShortcutLabel,
    getRoamShortcutToast,
} from "./languages.js";

export { ROAM_LANGUAGES } from "./languages.js";

export const ROAM_BATCH_SIZE_OPTIONS = [5, 10, 15, 20];

const ALL_KEYS = ROAM_LANGUAGES.map((item) => item.key);

export default function RoamOverview({
    onToggleRoam,
    randomRoam,
    setRandomRoamLanguage,
    setRandomRoamBatchSize,
    showToast = () => {},
    onRetry,
}) {
    const unavailable = randomRoam.available === false;

    // 解析当前语种多选
    const selectedKeys = useMemo(() => {
        const lang = randomRoam?.language || 'all';
        if (lang === 'all') return ALL_KEYS;
        const list = lang.split(',').map((k) => k.trim()).filter((k) => ALL_KEYS.includes(k));
        return list.length ? list : ALL_KEYS;
    }, [randomRoam?.language]);

    const isAllSelected = selectedKeys.length === ALL_KEYS.length;
    const currentBatchSize = randomRoam?.batchSize || 10;

    // 语种切换
    const handleToggleKey = useCallback((key) => {
        let newKeys;
        if (selectedKeys.includes(key)) {
            newKeys = selectedKeys.filter((k) => k !== key);
        } else {
            newKeys = [...selectedKeys, key];
        }

        if (newKeys.length === 0) {
            showToast(t("请至少保留一个漫游语种"));
            return;
        }

        const finalLang = newKeys.length === ALL_KEYS.length
            ? 'all'
            : ALL_KEYS.filter((k) => newKeys.includes(k)).join(',');

        if (setRandomRoamLanguage(finalLang)) showToast(t("已更新漫游语种偏好"));
    }, [selectedKeys, setRandomRoamLanguage, showToast]);

    // 当前语种文案摘要与根据界面语言匹配的漫游专属语种
    const locale = useLocale();
    const matchedRoamKey = useMemo(() => getMatchingRoamLanguageKey(locale), [locale]);

    const handleSelectAll = useCallback(() => {
        if (isAllSelected) {
            // 如果全选且存在匹配的专属语种，切换为该语种
            if (matchedRoamKey) {
                if (setRandomRoamLanguage(matchedRoamKey)) showToast(getRoamShortcutToast(matchedRoamKey));
            }
        } else {
            if (setRandomRoamLanguage('all')) showToast(t("已选择全部语种漫游"));
        }
    }, [isAllSelected, matchedRoamKey, setRandomRoamLanguage, showToast]);

    const handleSelectOnlyZh = useCallback(() => {
        if (setRandomRoamLanguage('zh')) showToast(t("已切换为仅中文漫游"));
    }, [setRandomRoamLanguage, showToast]);

    const handleBatchSizeChange = useCallback((size) => {
        if (setRandomRoamBatchSize(size)) showToast(t("已设置每次补充 {p0} 首歌曲", { p0: (size) }));
    }, [setRandomRoamBatchSize, showToast]);

    const languageSummary = useMemo(() => {
        if (isAllSelected) return t('全曲库');
        if (selectedKeys.length === 1) {
            return t(ROAM_LANGUAGES.find((item) => item.key === selectedKeys[0])?.label || '单语种');
        }
        return t("{p0} 个语种", { p0: (selectedKeys.length) });
    }, [isAllSelected, selectedKeys, locale]);

    return (
            <section aria-labelledby="roam-console-title" className="roam-radio">
                <div className="roam-radio__panel relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#0c4a6e] via-[#075985] to-[#0f172a] text-white shadow-xl border border-white/10">
                    {/* 氛围流动背景装饰光晕 */}
                    <div className="absolute -right-20 -top-20 w-80 h-80 rounded-full bg-sky-400/20 blur-3xl pointer-events-none" />
                    <div className="absolute left-1/3 -bottom-24 w-72 h-72 rounded-full bg-indigo-500/15 blur-3xl pointer-events-none" />

                    <div className="relative z-10 flex flex-col justify-between gap-5">
                        {/* 上半部：电台身份与大播放按钮（去除非必要长句，直接对齐） */}
                        <div className="roam-radio__header flex items-center justify-between gap-6">
                            <div className="roam-radio__identity">
                                <h2 id="roam-console-title" className="text-2xl font-bold tracking-tight text-white">{t("私人电台")}</h2>
                                <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 text-xs text-white/80 transition-all duration-300">
                                        {randomRoam.status === 'loading' ? (
                                            <>
                                                <span className="w-2 h-2 rounded-full bg-sky-300 animate-ping shrink-0" />
                                                <span className="text-sky-200 font-semibold animate-pulse">{t("正在补充歌曲…")}</span>
                                            </>
                                        ) : (
                                            <>
                                                <span className={`w-2 h-2 rounded-full ${randomRoam.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-white/40'}`} />
                                                <span>{randomRoam.enabled ? t("运行中") : t("未开启")}</span>
                                            </>
                                        )}
                                    </span>
                                </div>
                            </div>

                            {/* 简洁有力的播放主控（文案去啰嗦化，直接“开启”/“暂停”） */}
                            <button
                                type="button"
                                onClick={onToggleRoam}
                                disabled={unavailable}
                                className="shrink-0 inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full bg-white text-slate-900 font-bold text-sm shadow-xl hover:bg-white/95 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                                aria-label={randomRoam.enabled ? t("关闭漫游") : t("开启漫游电台")}
                            >
                                {randomRoam.enabled ? (
                                    <>
                                        <Power size={17} />
                                        <span>{t("关闭")}</span>
                                    </>
                                ) : (
                                    <>
                                        <Play size={17} fill="currentColor" />
                                        <span>{t("开启")}</span>
                                    </>
                                )}
                            </button>
                        </div>

                        {/* 底部：极简调频微调条 (Tuning Bar) */}
                        <div className="roam-radio__settings pt-3.5 border-t border-white/15 text-xs">
                            {/* 漫游语种范围：精炼为“语种：” */}
                            <div className="roam-radio__language-setting" title={t("漫游语种范围")}>
                                <span className="text-white/70 font-semibold">{t("语种：")}</span>
                                <div className="roam-radio__languages inline-flex p-0.5 rounded-full bg-black/25 backdrop-blur-md">
                                    {ROAM_LANGUAGES.map((item, index) => {
                                        const isSelected = selectedKeys.includes(item.key);
                                        const nextSelected = index < ROAM_LANGUAGES.length - 1 && selectedKeys.includes(ROAM_LANGUAGES[index + 1].key);

                                        return (
                                            <button
                                                key={item.key}
                                                type="button"
                                                onClick={() => handleToggleKey(item.key)}
                                                disabled={unavailable}
                                                aria-pressed={isSelected}
                                                className={`roam-radio__language${isSelected ? ' is-selected' : ''}${isSelected && nextSelected ? ' is-connected' : ''}`}
                                            >
                                                <span>{t(item.label)}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {(!isAllSelected || matchedRoamKey) && (
                                    <button
                                        type="button"
                                        onClick={handleSelectAll}
                                        disabled={unavailable}
                                        className="roam-radio__language-shortcut text-[11px] underline opacity-75 hover:opacity-100 cursor-pointer"
                                    >
                                        {isAllSelected ? getRoamShortcutLabel(matchedRoamKey) : t("全选")}
                                    </button>
                                )}
                            </div>

                            {/* 数量与去重：单次补充数量精炼为“数量：”，已去重曲目精炼为“已去重：” */}
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-white/80">
                                <div className="flex items-center gap-1.5" title={t("单次补充数量")}>
                                    <span className="font-semibold text-white/70">{t("数量：")}</span>
                                    <div className="inline-flex p-0.5 rounded-full bg-black/25 backdrop-blur-md">
                                        {ROAM_BATCH_SIZE_OPTIONS.map((count) => (
                                            <button
                                                key={count}
                                                type="button"
                                                onClick={() => handleBatchSizeChange(count)}
                                                disabled={unavailable}
                                                aria-pressed={currentBatchSize === count}
                                                className={`px-2.5 py-0.5 rounded-full text-xs transition-all cursor-pointer ${
                                                    currentBatchSize === count
                                                        ? 'bg-white text-slate-900 font-bold'
                                                        : 'text-white/75 hover:text-white'
                                                }`}
                                            >
                                                {count}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <span className="text-white/70">{t("优先避开近期歌曲")}</span>
                            </div>
                        </div>
                    </div>
                </div>


            {randomRoam.error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted)]">
                <p>{t(randomRoam.error)}</p><button type="button" disabled={unavailable} onClick={onRetry} className="settings-button">{t('重试')}</button>
            </div>}
            {randomRoam.status === 'exhausted' && <p role="status" className="text-sm text-[var(--muted)]">{t('当前范围暂无可补充的歌曲')}</p>}

            </section>
    );
}
