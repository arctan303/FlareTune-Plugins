export {
  analyzeLrcLanguage,
  computeHash,
  isNonLyricText,
  normalizeLrcForHash,
  parseLrcLines,
} from "@flaretune/plugin-sdk/server/lyric-parsing";

import { isTranslationTarget, normalizeTranslationTarget, targetScriptEvidence, isUnchangedTranslation, translationTargetEnglishName } from '../shared/translation-languages.js';
import { computeHash } from "@flaretune/plugin-sdk/server/lyric-parsing";
import { isValidSongLanguage } from "@flaretune/plugin-sdk/server/song-language";
import { resolveLyricTranslationNeed } from "@flaretune/plugin-sdk/server/lyric-workflow";
import { isPreservedEnglishVocalization, chineseTextWithoutVocalizations } from './vocalization.js';

const LRC_TIMESTAMP_ANY_PATTERN = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const TRANSLATION_PROMPT_VERSION = 'lyrics-target-v8-vocalization';
const VOCALIZATION_INSTRUCTION = 'A Ha、Ha Ha、Oh 等明确无语义的英文拟声可以保留在原文；unitLanguages仍声明en，translations.text留空，行内拟声段也可不提供translation。它们不能单独构成需要翻译的外语正文。普通英文单词、有语义的短句和未知语种不能按拟声跳过。';
const DEFAULT_MAX_BATCH_UNITS = 120;
const DEFAULT_MAX_BATCH_CHARACTERS = 12_000;
const DEFAULT_CONTEXT_UNITS = 4;
function createSystemPrompt(targetLanguage = 'en') {
  if (!isTranslationTarget(targetLanguage)) throw new Error('INVALID_TARGET_LANGUAGE');
  const target = translationTargetEnglishName(targetLanguage);
  const script = targetLanguage === 'zh' ? '使用简体中文；不要输出繁体字。'
    : targetLanguage === 'zh-Hant' ? '使用繁體中文；不要輸出簡體字。'
      : targetLanguage === 'ja' ? '日本語として自然な語順・表記・慣用表現を使い、固有名詞は文脈に応じて扱う。'
        : targetLanguage === 'ko' ? '자연스러운 한국어 어순과 표현을 사용하고 적절한 한글 표기를 유지한다.'
          : 'Use the target language’s natural grammar, vocabulary, idioms and writing conventions.';
  return `你是一位资深歌词译者与编辑。请把 units 中实际演唱的歌词译成 ${target}（${targetLanguage}）。结合 title、artist 和相邻 context 理解整首歌，但不得把资料当歌词。以信、达、雅为共同质量标准，所有目标语言遵循同一要求：
1. 忠实：保留主体、否定、时态、指代、意象、情绪和叙事关系，不擅自增删。
2. 自然：使用目标语言习惯的语序和省略，避免逐词硬译、机械重复和原语言残句。
3. 表达：在不改变原意的前提下保留歌词语气、修辞、节奏与诗性。
4. 连贯：跨行语义要参考上下文，每个 text 仍只承载对应原行，不合并或拆分单元。
目标书写要求：${script}

严格规则：只翻译 units；context、title、artist 仅供理解。referenceTranslations 可能有误，原文始终优先。全部原文已是目标语言时返回 {"notNeeded":true,"songLanguage":"语言代码"}，繁简转换不算翻译，不能同时返回 translations。每批必须给出实际原文的 songLanguage，未知用 other。混合语言必须增加 unitLanguages:[{"unitId":0,"language":"zh"}]，与本批units全覆盖；已是目标语言的行不改写，译文text返回空字符串，只为真正外语行提供译文。同一行多语时改用{"unitId":0,"languages":["zh","en"],"segments":[{"text":"我轻声说 ","language":"zh"},{"text":"I love you","language":"en","translation":"我爱你"}]}；segments.text按序完整拼回该行原文，同目标段不能有translation，外语段提供translation，该行translations.text只拼接外语段译文，不重复或改写原有中文。language与languages二选一。拉丁字母不等于英语，也不能仅凭字母猜测西班牙语、法语等。不确定不是无需翻译。需要翻译时返回 {"songLanguage":"语言代码","translations":[{"unitId":0,"text":"译文"}]}，与 units 等长，每个 unitId 恰好出现一次。不得输出时间戳、Markdown、署名、解释或多余段落。名字、口号与拟声可按目标语言语境保留，但不能把整份外语正文原样返回。`;
}

export function buildTranslationPrompt(
  units,
  songTitle = '',
  artist = '',
  { contextBefore = [], contextAfter = [], targetLanguage = 'zh', referenceByUnitId = null } = {},
) {
  if (!Array.isArray(units) || units.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  return [
    { role: 'system', content: createSystemPrompt(targetLanguage) + '\n\n' + VOCALIZATION_INSTRUCTION },
    {
      role: 'user',
      content: JSON.stringify({
        title: songTitle,
        artist,
        context: {
          before: contextBefore.map(({ unitId, text }) => ({ unitId, text })),
          after: contextAfter.map(({ unitId, text }) => ({ unitId, text })),
        },
        units: units.map(({ unitId, text, repeatCount }) => ({ unitId, text, repeatCount })),
        ...(referenceByUnitId ? { referenceTranslations: units.map(({ unitId }) => ({
          unitId, text: referenceByUnitId.get(unitId) || '',
        })) } : {}),
      }),
    },
  ];
}

export function buildTranslationBatches(
  parsedLines,
  songTitle = '',
  artist = '',
  {
    maxUnits = DEFAULT_MAX_BATCH_UNITS,
    maxCharacters = DEFAULT_MAX_BATCH_CHARACTERS,
    contextUnits = DEFAULT_CONTEXT_UNITS,
    targetLanguage = 'zh',
    referenceByUnitId = null,
  } = {},
) {
  if (!Array.isArray(parsedLines) || parsedLines.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  if (maxUnits < 1 || maxCharacters < 1) throw new Error('INVALID_BATCH_LIMIT');

  const ranges = [];
  let start = 0;
  while (start < parsedLines.length) {
    let end = start;
    let characters = 0;
    while (end < parsedLines.length && end - start < maxUnits) {
      const nextCharacters = parsedLines[end].text.length;
      if (end > start && characters + nextCharacters > maxCharacters) break;
      characters += nextCharacters;
      end += 1;
    }
    if (end === start) end += 1;
    ranges.push([start, end]);
    start = end;
  }

  return ranges.map(([rangeStart, rangeEnd]) => {
    const units = parsedLines.slice(rangeStart, rangeEnd);
    const contextBefore = parsedLines.slice(Math.max(0, rangeStart - contextUnits), rangeStart);
    const contextAfter = parsedLines.slice(rangeEnd, Math.min(parsedLines.length, rangeEnd + contextUnits));
    return {
      units,
      messages: buildTranslationPrompt(units, songTitle, artist,
        { contextBefore, contextAfter, targetLanguage, referenceByUnitId }),
    };
  });
}

function unwrapJsonFence(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonResponse(aiResponse) {
  if (aiResponse && typeof aiResponse === 'object') return aiResponse;
  try {
    return JSON.parse(unwrapJsonFence(aiResponse));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

export function parseTranslationResponse(aiResponse, expectedUnits, { targetLanguage = 'zh', allowUnchanged = false, allowEmptyUnitIds = new Set() } = {}) {
  if (!Array.isArray(expectedUnits) || expectedUnits.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  let parsedJson = parseJsonResponse(aiResponse);
  if (Array.isArray(parsedJson)) parsedJson = { translations: parsedJson };
  if (parsedJson?.notNeeded === true && Object.keys(parsedJson).length === 1) {
    if (targetScriptEvidence(expectedUnits.map(unit => unit.text).join('\n'), targetLanguage) === 'mismatch') throw new Error('INVALID_NOT_NEEDED');
    return null;
  }
  if (Object.keys(parsedJson || {}).some((key) => key !== 'translations')) {
    throw new Error('INVALID_RESPONSE_FIELDS');
  }

  const translations = parsedJson?.translations;
  if (!Array.isArray(translations) || translations.length !== expectedUnits.length) {
    throw new Error('INVALID_COVERAGE');
  }

  const expectedById = new Map(expectedUnits.map((unit) => [unit.unitId, unit]));
  const translatedById = new Map();
  for (const item of translations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['unitId', 'text'].includes(key))
      || !Number.isInteger(item.unitId)
      || !expectedById.has(item.unitId)
      || translatedById.has(item.unitId)
      || typeof item.text !== 'string') {
      throw new Error('INVALID_TRANSLATION_INDEX');
    }
    const text = item.text.trim();
    const sourceText = expectedById.get(item.unitId).text;
    const maximumLength = Math.max(240, sourceText.length * 8);
    if ((!text && !allowEmptyUnitIds.has(item.unitId)) || text.length > maximumLength || /[\r\n]/u.test(text)
      || LRC_TIMESTAMP_ANY_PATTERN.test(text) || /```/.test(text)) {
      throw new Error('INVALID_TRANSLATION_TEXT');
    }
    translatedById.set(item.unitId, text);
  }

  const ordered = expectedUnits.map(unit => translatedById.get(unit.unitId));
  const translatedBody = ordered.filter(Boolean).join('\n');
  if (translatedBody && targetScriptEvidence(translatedBody, targetLanguage) === 'mismatch') throw new Error('TARGET_LANGUAGE_MISMATCH');
  if (!allowUnchanged && isUnchangedTranslation(expectedUnits.map(unit => unit.text), ordered)) throw new Error('UNCHANGED_TRANSLATION');
  return [...translatedById].map(([unitId, text]) => ({ unitId, text }));
}

export function parseLanguageAwareTranslationResponse(aiResponse, expectedUnits, options = {}) {
  const parsed = parseJsonResponse(aiResponse);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_RESPONSE_FIELDS');
  if (Object.hasOwn(parsed, 'notNeeded') && Object.hasOwn(parsed, 'translations')) throw new Error('INVALID_RESPONSE_FIELDS');
  const { songLanguage, translationLanguage, discardLineIndices, unitLanguages, ...translationResponse } = parsed;
  if (translationLanguage !== undefined && normalizeTranslationTarget(translationLanguage) !== normalizeTranslationTarget(options.targetLanguage || 'zh')) throw new Error('TARGET_LANGUAGE_MISMATCH');
  const language = isValidSongLanguage(songLanguage) && songLanguage !== 'instrumental'
    && songLanguage !== 'other' ? songLanguage : null;
  const hint = isValidSongLanguage(options.sourceLanguage) && !['instrumental', 'other'].includes(options.sourceLanguage)
    ? options.sourceLanguage : null;
  const effectiveLanguage = language || hint;
  const allowed = options.allowedCleanupIndices;
  const validCandidates = Array.isArray(discardLineIndices) && allowed
    && discardLineIndices.every((index) => Number.isInteger(index) && allowed.has(index));
  if (options.analysisOnly) {
    if (translationResponse.notNeeded !== true || Object.keys(translationResponse).length !== 1) throw new Error('INVALID_RESPONSE_FIELDS');
    return { translations: null, language, sourceLanguage: effectiveLanguage, hasForeignPassages: false,
      discardLineIndices: validCandidates ? [...new Set(discardLineIndices)].sort((a, b) => a - b) : [] };
  }
  const targetLanguage = options.targetLanguage || 'zh';
  const decisionFor = (units, sourceLanguage) => {
    const decide = selected => resolveLyricTranslationNeed({ lines: selected.map(unit => ({ text: unit.text })) },
      { language: sourceLanguage }, { targetLanguage });
    const result = decide(units);
    if (result.state !== 'unknown' || sourceLanguage !== 'zh'
      || !['zh', 'zh-Hant'].includes(normalizeTranslationTarget(targetLanguage))) return result;
    const analyzed = units.map(unit => ({ ...unit, text: chineseTextWithoutVocalizations(unit.text) ?? unit.text }));
    const withoutSounds = decide(analyzed);
    return withoutSounds.state === 'not_needed' ? withoutSounds : result;
  };
  let unitDecisions = null;
  const vocalizationIds = new Set();
  const responseText = unitId => Array.isArray(translationResponse.translations)
    ? translationResponse.translations.find(item => item?.unitId === unitId)?.text : undefined;
  if (unitLanguages !== undefined) {
    if (!Array.isArray(unitLanguages) || unitLanguages.length !== expectedUnits.length) throw new Error('INVALID_UNIT_LANGUAGES');
    const expected = new Map(expectedUnits.map(unit => [unit.unitId, unit]));
    const selected = new Map();
    for (const item of unitLanguages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['unitId', 'language', 'languages', 'segments'].includes(key))
        || !Number.isInteger(item.unitId) || !expected.has(item.unitId) || selected.has(item.unitId)
        || (Object.hasOwn(item, 'language') === Object.hasOwn(item, 'languages'))) throw new Error('INVALID_UNIT_LANGUAGES');
      if (item.languages !== undefined) {
        if (!Array.isArray(item.languages) || item.languages.length < 2 || item.languages.length > 15
          || new Set(item.languages).size !== item.languages.length
          || item.languages.some(language => !isValidSongLanguage(language) || ['instrumental', 'other'].includes(language))
          || !Array.isArray(item.segments) || item.segments.length < 2 || item.segments.length > 128) throw new Error('INVALID_UNIT_LANGUAGES');
        const foreign = [], used = new Set(), vocalizations = [];
        for (const segment of item.segments) {
          if (!segment || typeof segment !== 'object' || Array.isArray(segment)
            || Object.keys(segment).some(key => !['text', 'language', 'translation'].includes(key))
            || typeof segment.text !== 'string' || !segment.text || !item.languages.includes(segment.language)) throw new Error('INVALID_LANGUAGE_SEGMENTS');
          used.add(segment.language);
          if (isPreservedEnglishVocalization(segment.text, segment.language, segment.translation)) {
            vocalizations.push(segment.text);
            continue;
          }
          const part = decisionFor([{ text: segment.text }], segment.language);
          if (part.state === 'unknown') throw new Error('SOURCE_LANGUAGE_MISMATCH');
          if (part.state === 'not_needed') {
            if (segment.translation !== undefined && segment.translation !== '') throw new Error('TARGET_SEGMENT_REWRITTEN');
          } else {
            if (typeof segment.translation !== 'string' || !segment.translation.trim()) throw new Error('INVALID_LANGUAGE_SEGMENTS');
            foreign.push({ text: segment.text, translation: segment.translation.trim() });
          }
        }
        if (used.size !== item.languages.length || item.segments.map(segment => segment.text).join('') !== expected.get(item.unitId).text) throw new Error('INVALID_LANGUAGE_SEGMENTS');
        if (!foreign.length && vocalizations.length
          && isPreservedEnglishVocalization(vocalizations.join(' '), 'en', responseText(item.unitId))) vocalizationIds.add(item.unitId);
        selected.set(item.unitId, { state: foreign.length ? 'needed' : 'not_needed',
          inlineTranslation: foreign.map(segment => segment.translation).join(' '),
          foreignSourceText: foreign.map(segment => segment.text).join(' ') });
        continue;
      }
      if (item.segments !== undefined || !isValidSongLanguage(item.language)
        || ['instrumental', 'other'].includes(item.language)) throw new Error('INVALID_UNIT_LANGUAGES');
      if (isPreservedEnglishVocalization(expected.get(item.unitId).text, item.language, responseText(item.unitId))) {
        selected.set(item.unitId, { state: 'not_needed' });
        vocalizationIds.add(item.unitId);
        continue;
      }
      const decision = decisionFor([expected.get(item.unitId)], item.language);
      if (decision.state === 'unknown') throw new Error('SOURCE_LANGUAGE_MISMATCH');
      selected.set(item.unitId, decision);
    }
    unitDecisions = selected;
  }
  const decision = unitDecisions ? null : effectiveLanguage ? decisionFor(expectedUnits, effectiveLanguage) : null;
  const notNeeded = unitDecisions ? [...unitDecisions.values()].every(item => item.state === 'not_needed')
    : decision?.state === 'not_needed';
  const hasForeignPassages = unitDecisions ? [...unitDecisions.values()].some(item => item.state === 'needed') : decision?.state === 'needed';
  if (!effectiveLanguage) throw new Error('LANGUAGE_UNDETERMINED');
  if (!unitDecisions && decision.state === 'unknown') throw new Error('SOURCE_LANGUAGE_MISMATCH');
  if (translationResponse.notNeeded === true) {
    if (!notNeeded || Object.keys(translationResponse).length !== 1) throw new Error('INVALID_NOT_NEEDED');
    return { translations: null, language: language || effectiveLanguage,
      sourceLanguage: effectiveLanguage, hasForeignPassages: false,
      discardLineIndices: validCandidates ? [...new Set(discardLineIndices)].sort((a, b) => a - b) : [] };
  }
  const sameTargetIds = new Set(notNeeded ? expectedUnits.map(unit => unit.unitId)
    : unitDecisions ? [...unitDecisions].filter(([, item]) => item.state === 'not_needed').map(([unitId]) => unitId) : []);
  const normalizedResponse = vocalizationIds.size && Array.isArray(translationResponse.translations)
    ? { ...translationResponse, translations: translationResponse.translations.map(item =>
      vocalizationIds.has(item?.unitId) && typeof item.text === 'string' ? { ...item, text: '' } : item) }
    : translationResponse;
  const translations = parseTranslationResponse(normalizedResponse, expectedUnits,
    { ...options, allowUnchanged: notNeeded || options.allowUnchanged, allowEmptyUnitIds: sameTargetIds });
  for (const item of translations || []) {
    const inline = unitDecisions?.get(item.unitId);
    if (inline?.inlineTranslation !== undefined && item.text !== inline.inlineTranslation) throw new Error('TARGET_SEGMENT_REWRITTEN');
  }
  // Reliable same-target language evidence canonicalizes a rewrite/copy to a
  // no-op. Mixed results blank target-language rows before any asset write.
  const selected = notNeeded ? null : translations.map(item => sameTargetIds.has(item.unitId) ? { ...item, text: '' } : item);
  if (selected && selected.every(item => !item.text.trim())) throw new Error('UNCHANGED_TRANSLATION');
  if (selected) {
    const body = selected.filter(item => item.text.trim()).map(item => item.text).join('\n');
    if (targetScriptEvidence(body, targetLanguage) === 'mismatch') throw new Error('TARGET_LANGUAGE_MISMATCH');
    const sourceById = new Map(expectedUnits.map(unit => [unit.unitId, unitDecisions?.get(unit.unitId)?.foreignSourceText ?? unit.text]));
    if (selected.filter(item => item.text.trim()).every(item => isUnchangedTranslation([sourceById.get(item.unitId)], [item.text]))) throw new Error('UNCHANGED_TRANSLATION');
  }
  return { translations: selected, language,
    sourceLanguage: effectiveLanguage, hasForeignPassages,
    discardLineIndices: validCandidates ? [...new Set(discardLineIndices)].sort((a, b) => a - b) : [] };
}

export function reconstructTranslatedLrc(aiResponse, parsedLines) {
  if (!Array.isArray(parsedLines) || parsedLines.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  // This exported legacy LRC cache helper historically carries Chinese layers.
  const translations = parseTranslationResponse(aiResponse, parsedLines, { targetLanguage: 'zh', allowUnchanged: true });
  const translatedById = new Map(translations.map(({ unitId, text }) => [unitId, text]));
  const translatedLines = [];
  for (const unit of parsedLines) {
    const text = translatedById.get(unit.unitId);
    const occurrences = Array.isArray(unit.occurrences) ? unit.occurrences : [unit.timestamps || []];
    for (const timestamps of occurrences) {
      if (!timestamps.length) translatedLines.push(text);
      else for (const timestamp of timestamps) translatedLines.push(`${timestamp}${text}`);
    }
  }
  const translatedLrc = translatedLines.join('\n').trim();
  if (!translatedLrc) throw new Error('EMPTY_TRANSLATION');
  return translatedLrc;
}

export function orderedLyricBody(parsedLines) {
  if (!Array.isArray(parsedLines)) throw new TypeError('parsed lyric lines must be an array');
  return parsedLines.flatMap((unit) => {
    const repeatCount = Number.isInteger(unit?.repeatCount) && unit.repeatCount > 0
      ? unit.repeatCount
      : Math.max(1, Array.isArray(unit?.occurrences) ? unit.occurrences.length : 1);
    return Array.from({ length: repeatCount }, () => String(unit?.text || '').trim());
  }).join('\n').trim();
}

export function computeLyricsBodyHash(parsedLines) {
  return computeHash(orderedLyricBody(parsedLines));
}

export function retimeCachedTranslation(cachedLrc, parsedLines) {
  const translatedTexts = String(cachedLrc || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[A-Za-z][\w-]*:/u.test(line))
    .map((line) => line.replace(/^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/, '').trim())
    .filter(Boolean);
  const expectedOccurrences = parsedLines.reduce((count, unit) => (
    count + Math.max(1, Array.isArray(unit?.occurrences) ? unit.occurrences.length : 1)
  ), 0);
  if (translatedTexts.length !== expectedOccurrences) return cachedLrc;
  let cursor = 0;
  const translations = parsedLines.map((unit) => {
    const occurrences = Math.max(1, Array.isArray(unit?.occurrences) ? unit.occurrences.length : 1);
    const text = translatedTexts[cursor];
    cursor += occurrences;
    return { unitId: unit.unitId, text };
  });
  return reconstructTranslatedLrc({ translations }, parsedLines);
}

export function getTranslationPromptVersion() {
  return TRANSLATION_PROMPT_VERSION;
}
