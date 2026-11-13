export {
  analyzeLrcLanguage,
  computeHash,
  isNonLyricText,
  normalizeLrcForHash,
  parseLrcLines,
} from "@flaretune/plugin-sdk/server/lyric-parsing";

import { isTranslationTarget, normalizeTranslationTarget, targetScriptEvidence, isUnchangedTranslation, translationTargetEnglishName } from '../shared/translation-languages.js';
import { computeHash } from "@flaretune/plugin-sdk/server/lyric-parsing";

const LRC_TIMESTAMP_ANY_PATTERN = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const TRANSLATION_PROMPT_VERSION = 'lyrics-1.0.0-translation';
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

严格规则：歌曲需要翻译已由上游独立确定，本角色只翻译，不重新判断语言或是否需要翻译。只处理 units；context、title、artist 仅供理解。referenceTranslations 可能有误，原文始终优先。返回且仅返回 {"translations":[{"unitId":0,"text":"译文"}]}，与 units 等长，每个 unitId 恰好出现一次。不得返回songLanguage、unitLanguages、segments或notNeeded。不得输出时间戳、Markdown、署名、解释或多余段落，不修改原文或时间。名字、口号与拟声可按目标语言语境保留，但不能把整份外语正文原样返回。`;
}

export function buildTranslationPrompt(
  units,
  songTitle = '',
  artist = '',
  { contextBefore = [], contextAfter = [], targetLanguage = 'zh', referenceByUnitId = null } = {},
) {
  if (!Array.isArray(units) || units.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  return [
    { role: 'system', content: createSystemPrompt(targetLanguage) },
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => !['translations', 'discardLineIndices'].includes(key))) throw new Error('INVALID_RESPONSE_FIELDS');
  const { discardLineIndices, ...translationResponse } = parsed;
  const allowed = options.allowedCleanupIndices;
  if (discardLineIndices !== undefined && (!allowed || !Array.isArray(discardLineIndices)
    || discardLineIndices.some(index => !Number.isInteger(index) || !allowed.has(index)))) throw new Error('INVALID_CLEANUP_INDICES');
  const discard = [...new Set(discardLineIndices || [])].sort((a, b) => a - b);
  if (options.analysisOnly) {
    if (Object.keys(translationResponse).length) throw new Error('INVALID_RESPONSE_FIELDS');
    return { translations: null, discardLineIndices: discard };
  }
  if (!Object.hasOwn(translationResponse, 'translations')) throw new Error('INVALID_COVERAGE');
  return { translations: parseTranslationResponse(translationResponse, expectedUnits, options), discardLineIndices: discard };
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
