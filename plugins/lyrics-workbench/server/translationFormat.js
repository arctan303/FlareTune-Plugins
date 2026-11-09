export {
  analyzeLrcLanguage,
  computeHash,
  isNonLyricText,
  normalizeLrcForHash,
  parseLrcLines,
} from "@flaretune/plugin-sdk/server/lyric-parsing";

import { computeHash } from "@flaretune/plugin-sdk/server/lyric-parsing";
import { isValidSongLanguage } from "@flaretune/plugin-sdk/server/song-language";

const LRC_TIMESTAMP_ANY_PATTERN = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const HAN_ANY_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MEANINGFUL_FOREIGN_PATTERN = /[A-Za-z\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const TRANSLATION_PROMPT_VERSION = 'lyrics-zh-cn-v5-contextual-polish';
const DEFAULT_MAX_BATCH_UNITS = 120;
const DEFAULT_MAX_BATCH_CHARACTERS = 12_000;
const DEFAULT_CONTEXT_UNITS = 4;
const LANGUAGE_NAMES = Object.freeze({ zh: '简体中文', ja: '日语', en: '英语', ko: '韩语',
  ru: '俄语', es: '西班牙语', fr: '法语', de: '德语', sv: '瑞典语', vi: '越南语',
  yue: '粤语', it: '意大利语', th: '泰语', pt: '葡萄牙语' });

function createSystemPrompt(targetLanguage = 'zh') {
  if (targetLanguage !== 'zh') {
    const target = LANGUAGE_NAMES[targetLanguage];
    if (!target) throw new Error('INVALID_TARGET_LANGUAGE');
    return `你是一位资深歌词译者。请结合 title、artist 与相邻 context 理解整首歌，把 units 中实际演唱的歌词译成${target}（${targetLanguage}）。译文要忠实于原意、自然通顺，并尽量保留语气、意象和节奏；不得增加解释或编造信息。referenceTranslations 若存在，仅供理解，可能有错，必须以原文为准。\n\n只输出 JSON：若歌词已经主要是目标语言且无须翻译，返回 {"notNeeded":true}；否则返回 {"translations":[{"unitId":0,"text":"译文"}]}。translations 与 units 等长，每个 unitId 恰好出现一次。不得输出时间戳、Markdown、署名或额外文字。`;
  }
  return `你是一位资深中文歌词译者与编辑。请先结合整首歌的 title、artist 和前后 context 理解每句在完整语义中的作用，在内部完成“理解—初译—中文润色”后，只输出最终译文。把 units 中的实际歌词译成简体中文，并以“信、达、雅”为顺序：
1. 信：忠实保留主体、否定、时态、指代、意象、情绪与叙事关系，不擅自增删信息。
2. 达：按中文习惯重组词序和省略重复成分，译成可以自然朗读的完整表达；禁止逐词对应、生硬欧化、日语残句或“更更更加”一类机械叠词。
3. 雅：在不改变原意的前提下保留歌词的语气、节奏、修辞与诗性，优先选择凝练、贴合当代中文语境的措辞。
4. 连贯：跨行组成一句话时必须结合相邻行理解，每个 text 仍只承载对应原行的语义片段，但上下行连读要通顺。

严格规则：
1. 只翻译 units；context、title、artist 仅用于理解，不得输出或翻译。
2. 若 units 的实际歌词已经以中文为主、无需翻译，只返回 {"notNeeded":true}；不得复制、改写或逐行输出中文。否则只返回 {"translations":[{"unitId":0,"text":"译文"}]} 形式的 JSON 对象。
3. 非 notNeeded 响应的 translations 必须与 units 等长，每个 unitId 恰好出现一次，不得缺失、重复或越界。
4. text 必须非空，不得包含 LRC 时间戳、Markdown、解释、评论、歌曲资料或额外段落。
5. 英文口号、拟声和人声吟唱在中文语境中自然时可以保留原文，不得为了“看起来已翻译”而硬译，也不得删除该单元。
6. 同一修辞词连续重复时，用自然的中文反复或递进表达保留强调，不要机械逐字重复。

润色示例只用于展示中文质量，不得额外输出：
- “もっともっともっと声高く”宜译为“把歌声再唱得更响亮”，不要译成“更加更加更加高声”。
- 相邻两行“だって今強く / 深く愛してるから”宜连贯处理为“因为此刻 / 我正爱得如此热烈而深沉”，不要留下“因为现在强烈地”这样的逐词残句。
- “くちびるに希望 携えて / ワード放つそのたび”宜采用“唇边带着希望 / 每当话语脱口而出”一类中文搭配，不要照搬成“携带希望 / 放出话语”。`;
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

export function parseTranslationResponse(aiResponse, expectedUnits, { targetLanguage = 'zh' } = {}) {
  if (!Array.isArray(expectedUnits) || expectedUnits.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  let parsedJson = parseJsonResponse(aiResponse);
  if (Array.isArray(parsedJson)) parsedJson = { translations: parsedJson };
  if (parsedJson?.notNeeded === true && Object.keys(parsedJson).length === 1) return null;
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
    if (!text || text.length > maximumLength || /[\r\n]/u.test(text)
      || LRC_TIMESTAMP_ANY_PATTERN.test(text) || /```/.test(text)) {
      throw new Error('INVALID_TRANSLATION_TEXT');
    }
    translatedById.set(item.unitId, text);
  }

  const hasMeaningfulSource = expectedUnits.some(({ text }) => MEANINGFUL_FOREIGN_PATTERN.test(text));
  if (targetLanguage === 'zh' && hasMeaningfulSource && !HAN_ANY_PATTERN.test([...translatedById.values()].join(''))) {
    throw new Error('TARGET_LANGUAGE_MISMATCH');
  }
  return [...translatedById].map(([unitId, text]) => ({ unitId, text }));
}

export function parseLanguageAwareTranslationResponse(aiResponse, expectedUnits, options = {}) {
  const parsed = parseJsonResponse(aiResponse);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { translations: parseTranslationResponse(parsed, expectedUnits, options), language: null,
      discardLineIndices: [] };
  }
  const { songLanguage, discardLineIndices, ...translationResponse } = parsed;
  const language = isValidSongLanguage(songLanguage) && songLanguage !== 'instrumental'
    && songLanguage !== 'other' ? songLanguage : null;
  const allowed = options.allowedCleanupIndices;
  const validCandidates = Array.isArray(discardLineIndices) && allowed
    && discardLineIndices.every((index) => Number.isInteger(index) && allowed.has(index));
  return {
    translations: parseTranslationResponse(translationResponse, expectedUnits, options),
    language,
    discardLineIndices: validCandidates ? [...new Set(discardLineIndices)].sort((a, b) => a - b) : [],
  };
}

export function reconstructTranslatedLrc(aiResponse, parsedLines) {
  if (!Array.isArray(parsedLines) || parsedLines.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
  const translations = parseTranslationResponse(aiResponse, parsedLines);
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
