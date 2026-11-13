import { createLyricsAiAccess, createLyricsAiLease, guardLyricsStore } from "./aiAccess.js";
import { lyricAiProcessingKey } from "./policy.js";
import { reserveDailyQuota } from "./usage.js";
import { buildTranslationBatches, parseLanguageAwareTranslationResponse } from "./translationFormat.js";
import { createLyricDocument, isSingableLineText, isLeadingProviderMetadata } from "@flaretune/plugin-sdk/server/lyric-document";
import { computeHash, isNonLyricText } from "@flaretune/plugin-sdk/server/lyric-parsing";
import {
  isFreshLyricAiPending,
  projectLyricArtifact,
  lyricTextForHash,
  resolveLyricTranslationNeed,
  hasCurrentLyricNoTranslationDecision,
  buildLyricNoTranslationDecision,
  buildLyricTranslationDecision,
} from "@flaretune/plugin-sdk/server/lyric-workflow";

const DEFAULT_DAILY_LIMIT = 50;
const AI_COMPLETION_DEADLINE_MS = 24_000;
// ai.js treats shorter overrides as invalid, so stop before it could fall back to 90 seconds.
const MIN_AI_REQUEST_BUDGET_MS = 5_000;
const LANGUAGE_INSTRUCTION = `同时根据本批 units 和 languageSample 中真正演唱的歌词判断原文语言，不要根据歌名、歌手名或署名判断。每批都必须返回 songLanguage 字段，值只能是 zh、ja、en、ko、ru、es、fr、de、sv、vi、yue、it、th、pt 或 other。多语言时选占主导语言，并返回覆盖本批全部unitId的 unitLanguages:[{"unitId":0,"language":"zh"}]；同目标语言行译文留空，不能改写。同一行多语用languages数组及完整覆盖原文的segments，每段声明text/language，仅外语段可带translation，translations.text只拼接外语段译文。无法可靠判断时使用other，不能返回notNeeded。notNeeded:true仅表示本批全部正文无需翻译，不能与translations同时存在。即使返回notNeeded也必须提供songLanguage。繁简中文转换不算翻译。目标译文语言与歌曲语种是两个概念；若返回 translationLanguage，须标识实际译文目标（可为 zh-Hant），但 songLanguage 仍只用上述歌曲语种枚举，不能用 zh-Hant。拉丁字母不能直接判定为英语，证据不足时返回 other。`;
const CLEANUP_INSTRUCTION = `歌曲 title 和 artist 仅用于识别上下文，不能写进歌词。检查 cleanupUnits 中不属于实际演唱的整行内容，例如开头的歌名歌手资料、Lyrics by / Composed by 等制作署名、广告、乱码和无效正文。只把确定应整行删除的 index 放入 discardLineIndices；标题若也是实际唱出的歌词，应保留演唱位置的那一行。拿不准时保留。不得改写任何原文、增添歌词行、修改行时间戳或逐字时间点。若同时返回 translations，仍须与 units 一一对应；服务端会丢弃被标记整行及其译文。即使返回 notNeeded，也必须提供 discardLineIndices。`;

export function getDailyLyricCompletionLimit(env) {
  const configured = Number(env?.AI_TRANSLATION_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_DAILY_LIMIT;
}

const dateKey = (now) => new Date(now).toISOString().slice(0, 10);
const completionTimeoutError = () => new Error('AI_COMPLETION_TIMEOUT');
const safeErrorCode = (error) => {
  const message = String(error?.code || error?.message || '').toLocaleUpperCase();
  if (message === 'LYRICS_INVOCATION_BUDGET_EXHAUSTED') return 'request_budget_exhausted';
  if (message.includes('AI_MISSING_KEY')) return 'missing_key';
  if (message.includes('AI_QUOTA_EXHAUSTED')) return 'quota_exhausted';
  if (message.includes('TIMEOUT')) return 'ai_timeout';
  if (message.includes('AI_UPSTREAM_429')) return 'upstream_rate_limited';
  if (/AI_UPSTREAM_5\d\d/u.test(message)) return 'upstream_unavailable';
  if (message.includes('AI_ASSISTANT_CONFIG') || message.includes('AI_CONFIG_INVALID')) return 'configuration_unavailable';
  if (message.includes('AI_EMPTY_RESPONSE') || message.includes('NO_TRANSLATABLE_LINES')
    || message === 'INVALID_JSON' || message.startsWith('INVALID_') || message === 'LANGUAGE_UNDETERMINED'
    || message === 'SOURCE_LANGUAGE_MISMATCH' || message === 'TARGET_LANGUAGE_MISMATCH'
    || message === 'UNCHANGED_TRANSLATION') return 'invalid_output';
  return 'completion_failed';
};

function completionDeadline(deps, execute) {
  const requested = Number(deps.completionDeadlineMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), AI_COMPLETION_DEADLINE_MS)
    : AI_COMPLETION_DEADLINE_MS;
  const monotonicNow = deps.monotonicNow || (() => performance.now());
  const deadlineAt = monotonicNow() + timeoutMs;
  const deadline = {
    expired: false,
    remainingMs() {
      if (this.expired) return 0;
      return Math.max(0, Math.floor(deadlineAt - monotonicNow()));
    },
    assertRemaining(minimumMs = 1) {
      if (this.remainingMs() < minimumMs) throw completionTimeoutError();
    },
  };
  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      reject(completionTimeoutError());
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => execute(deadline)), timedOut])
    .finally(() => clearTimeout(timer));
}

function completionUnits(original, song) {
  const songTextKey = text => String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const titleKey = songTextKey(song?.title);
  return original.lines
    .flatMap((line, index) => isLeadingProviderMetadata(line, index, song)
      && !(titleKey && songTextKey(line.text) === titleKey) ? []
      : [{ unitId: index, index, text: String(line.text || '').trim(), repeatCount: 1 }])
    .filter((unit) => isSingableLineText(unit.text));
}

function languageSample(units) {
  const limit = Math.min(units.length, 64);
  const step = units.length / limit;
  return Array.from({ length: limit }, (_, index) => units[Math.floor(index * step)].text)
    .join('\n').slice(0, 6_000);
}

function cleanupUnits(original) {
  const lines = original.lines.map((line, index) => ({ index, text: String(line.text || '').trim() }))
    .filter(({ text }) => text);
  const selected = lines.length <= 220 ? lines : [...lines.slice(0, 170), ...lines.slice(-50)];
  let length = 0;
  return selected.filter(({ text }) => {
    length += text.length;
    return length <= 8_000;
  });
}

function withAnalysisRequest(messages, units, original, { detectLanguage, cleanDirtyLyrics }) {
  const first = messages[0];
  const last = messages.at(-1);
  if (first?.role !== 'system' || last?.role !== 'user') return messages;
  const selectedCleanupUnits = cleanDirtyLyrics ? cleanupUnits(original) : [];
  return [
    { ...first, content: [first.content,
      detectLanguage ? LANGUAGE_INSTRUCTION : '',
      cleanDirtyLyrics ? CLEANUP_INSTRUCTION : ''].filter(Boolean).join('\n\n') },
    ...messages.slice(1, -1),
    { ...last, content: JSON.stringify({ ...JSON.parse(last.content),
      ...(detectLanguage ? { languageSample: languageSample(units) } : {}),
      ...(cleanDirtyLyrics ? { cleanupUnits: selectedCleanupUnits } : {}),
    }) },
  ];
}

async function updateInferredSongLanguage(db, song, language, deps) {
  if (!language || language === song.language) return;
  // External songs have no Songs row. Their lyrics remain keyed by source ID;
  // language inference must not create or update a local catalog entry.
  if (/^yt:[A-Za-z0-9_-]{11}$/u.test(song.id)) return;
  const update = deps.updateSongLanguage || (async (songId, inferred, previous) => db.prepare(
    'UPDATE Songs SET language = ? WHERE id = ? AND language IS ?',
  ).bind(inferred, songId, previous).run());
  const result = await update(song.id, language, song.language ?? null);
  if (result?.meta?.changes === 0 || result?.changes === 0) {
    const current = await db.prepare('SELECT language FROM Songs WHERE id = ?').bind(song.id).first();
    if (current?.language !== language) throw new Error('SONG_LANGUAGE_CHANGED');
  }
}

async function finishWithInferredLanguage(store, db, song, finished, language, deps) {
  if (finished.state !== 'updated') return finished;
  try {
    await updateInferredSongLanguage(db, song, language, deps);
    return finished;
  } catch {
    const failedAt = new Date((deps.now || Date.now)()).toISOString();
    const { translationDecision: _uncommittedLanguageDecision, ...retryable } = finished.artifact;
    const failed = await store.putIfMatch(song.id, {
      ...retryable,
      aiCompletion: { status: 'failed', errorCode: 'language_update_failed', updatedAt: failedAt },
      updatedAt: failedAt,
    }, finished.etag, { automation: finished.automation });
    return failed.state === 'updated' ? failed : { state: 'superseded' };
  }
}

async function conditionallyFinish(store, songId, startedAt, textHash, update) {
  const current = await store.get(songId);
  if (current.state !== 'found' || current.artifact.status !== 'ready') return { state: 'superseded' };
  if (current.artifact.textHash !== textHash
    || current.artifact.aiCompletion?.status !== 'pending'
    || current.artifact.aiCompletion.updatedAt !== startedAt) {
    return { state: 'superseded', artifact: current.artifact, etag: current.etag };
  }
  const next = await update(current.artifact);
  const written = await store.putIfMatch(songId, next, current.etag, { automation: current.automation });
  if (written.state === 'conflict') return { state: 'superseded' };
  return written;
}

async function applySuggestedCleanup(artifact, indices, updatedAt, song, processingKey = null) {
  const lines = artifact.original.lines;
  const removed = new Set(indices.filter((index) => Number.isInteger(index)
    && index >= 0 && index < lines.length));
  const keptIndices = lines.flatMap((_line, index) => removed.has(index) ? [] : [index]);
  const aiCompletion = processingKey ? { status: 'completed', processingKey, updatedAt } : null;
  const finished = { ...artifact, aiCompletion, updatedAt };
  if (!removed.size || !keptIndices.some((index) => isSingableLineText(lines[index].text, song))) {
    return finished;
  }
  const canonical = createLyricDocument({ ...artifact.original,
    lines: keptIndices.map((index) => lines[index]) });
  const original = { ...artifact.original, syncMode: canonical.syncMode, lines: canonical.lines };
  const textHash = await computeHash(lyricTextForHash(original.lines));
  const translated = artifact.translation?.lines
    && keptIndices.map((index) => artifact.translation.lines[index]);
  const translation = translated?.some((line) => String(line || '').trim())
    ? { ...artifact.translation, originalTextHash: textHash, lines: translated, updatedAt }
    : null;
  const result = { ...finished, original, textHash, translation };
  if (textHash !== artifact.textHash) delete result.translationDecision;
  return result;
}

export async function resolveLegacyLyricCleanup(store, song, read, now = Date.now) {
  if (read?.state !== 'found' || read.artifact?.aiCompletion?.status !== 'review') return read;
  const updatedAt = new Date(now()).toISOString();
  const next = await applySuggestedCleanup(read.artifact,
    read.artifact.aiCompletion.candidateIndices, updatedAt, song);
  const written = await store.putIfMatch(song.id, next, read.etag, { automation: read.automation });
  return written.state === 'updated'
    ? { ...written, state: 'found' }
    : store.get(song.id);
}

export async function runLyricAssetAiCompletion({
  env,
  db,
  song,
  store,
  startedAt,
  textHash,
  actorAccountId = null,
  force = false,
  deps = {},
}) {
  let access, lease;
  try {
    lease = deps.aiAccess?.lease || deps.aiLease || await createLyricsAiLease({ env,
      session: deps.session, context: deps.consumerContext, deps });
    if (!deps.aiAccess) await lease.assertCurrent();
  } catch { return { state: 'unavailable' }; }
  try {
    access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
      context: deps.consumerContext, signal: deps.signal, deps: { ...deps, aiLease: lease } });
  } catch (error) {
    try { await lease.assertCurrent(); } catch { return { state: 'superseded' }; }
    return conditionallyFinish(guardLyricsStore(store, lease.assertCurrent), song.id, startedAt, textHash,
      current => ({ ...current, aiCompletion: { status: 'failed', errorCode: safeErrorCode(error),
        updatedAt: new Date((deps.now || Date.now)()).toISOString() } }));
  }
  db = access.db;
  store = guardLyricsStore(store, access.client.assertCurrent);
  try {
    return await completionDeadline(deps, async (deadline) => {
      // begin() already owns the successful pending CAS response. Direct jobs
      // still read the store; every completion rereads current state before CAS.
      const read = deps.initialRead || await store.get(song.id);
      deadline.assertRemaining();
      if (read.state !== 'found' || read.artifact.status !== 'ready') return { state: 'superseded' };
      const artifact = read.artifact;
      if (artifact.textHash !== textHash
        || artifact.aiCompletion?.status !== 'pending'
        || artifact.aiCompletion.updatedAt !== startedAt) return { state: 'superseded' };

      const assistantConfig = access.config;
      if (assistantConfig.completionEnabled === false
        || [assistantConfig.cleanDirtyLyrics, assistantConfig.translateLyrics,
          assistantConfig.detectLanguage].every(enabled => enabled === false)) {
        return conditionallyFinish(store, song.id, startedAt, textHash, current => ({
          ...current, aiCompletion: null,
          updatedAt: new Date((deps.now || Date.now)()).toISOString(),
        }));
      }

      const target = access.config.targetLanguage || 'en';
      const initialNeed = resolveLyricTranslationNeed(artifact.original, song, { targetLanguage: target });
      if (access.config.translateLyrics !== false && (hasCurrentLyricNoTranslationDecision(artifact, song, { targetLanguage: target })
        || initialNeed.state === 'not_needed')) {
        return conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
          translationDecision: hasCurrentLyricNoTranslationDecision(current, song, { targetLanguage: target }) ? current.translationDecision
            : buildLyricNoTranslationDecision(current, song, { targetLanguage: target, sourceLanguage: initialNeed.sourceLanguage,
              basis: initialNeed.sourceLanguage ? 'tag' : 'rules' }),
          aiCompletion: { status: 'completed', processingKey: lyricAiProcessingKey(access.config), updatedAt: new Date((deps.now || Date.now)()).toISOString() },
          updatedAt: new Date((deps.now || Date.now)()).toISOString(),
        }));
      }

      const units = completionUnits(artifact.original, song);
      if (units.length === 0) throw new Error('NO_TRANSLATABLE_LINES');
      // A sung title still needs its translated row. The separate language
      // sample keeps the provider-metadata exclusions to avoid biasing inference.
      const languageUnits = units.filter(unit => !isLeadingProviderMetadata(artifact.original.lines[unit.index], unit.index, song));
      deadline.assertRemaining();
      const now = (deps.now || Date.now)();
      const quotaReserved = await (deps.reserveDailyQuota || reserveDailyQuota)(
        db,
        dateKey(now),
        getDailyLyricCompletionLimit(env),
        now,
      );
      deadline.assertRemaining();
      if (!quotaReserved) throw new Error('AI_QUOTA_EXHAUSTED');
      const targetLanguage = assistantConfig.targetLanguage || 'en';
      const referenceByUnitId = assistantConfig.referenceExistingTranslation
        && artifact.translation?.language === targetLanguage
        ? new Map(artifact.translation.lines.map((text, unitId) => [unitId, text]))
        : null;
      const detectLanguage = assistantConfig.translateLyrics !== false || assistantConfig.detectLanguage !== false;
      const cleanDirtyLyrics = assistantConfig.cleanDirtyLyrics === true;
      const translateLyrics = assistantConfig.translateLyrics !== false;
      const selectedCleanupUnits = cleanDirtyLyrics ? cleanupUnits(artifact.original) : [];
      const allowedCleanupIndices = new Set(selectedCleanupUnits.map(({ index }) => index));
      const suggestedCleanup = new Set(cleanDirtyLyrics
        ? artifact.original.lines.flatMap((line, index) => isNonLyricText(line.text) ? [index] : [])
        : []);
      const translatedByIndex = new Map();
      const notNeededBatches = [];
      let inferredLanguage = null;
      let validationLanguage = initialNeed.sourceLanguage;
      let hasForeignPassages = false;
      const decisionSong = () => inferredLanguage && !/^yt:[A-Za-z0-9_-]{11}$/u.test(song.id)
        ? { ...song, language: inferredLanguage } : song;
      let retriedInvalidJson = false;
      const askForBatch = async (batch, firstAnalysis = false, analysisOnly = false) => {
        let messages = withAnalysisRequest(batch.messages, languageUnits, artifact.original,
          { detectLanguage, cleanDirtyLyrics: firstAnalysis && cleanDirtyLyrics });
        if (analysisOnly) messages = [
          { role: 'system', content: [
            '你在分析歌曲歌词。只返回 JSON 对象 {"notNeeded":true,"songLanguage":"语言代码","discardLineIndices":[行号]}。不得输出译文。',
            detectLanguage ? LANGUAGE_INSTRUCTION : '',
            cleanDirtyLyrics ? CLEANUP_INSTRUCTION : '',
          ].filter(Boolean).join('\n\n') },
          { role: 'user', content: JSON.stringify({ title: song.title, artist: song.artist,
            ...(detectLanguage ? { languageSample: languageSample(languageUnits) } : {}),
            ...(cleanDirtyLyrics ? { cleanupUnits: selectedCleanupUnits } : {}),
          }) },
        ];
        if (assistantConfig.systemPrompt && messages[0]?.role === 'system') {
          const systemPrompt = [
            assistantConfig.systemPrompt,
            messages[0].content,
          ].filter(Boolean).join('\n\n');
          messages = [
            { role: 'system', content: systemPrompt },
            ...messages.slice(1),
          ];
        }
        const requestConfig = assistantConfig.provider === 'deepseek'
          ? { ...assistantConfig, enableThinking: false }
          : assistantConfig;
        const parseResponse = (response) => {
          const parsed = parseLanguageAwareTranslationResponse(response, batch.units,
            { targetLanguage, allowedCleanupIndices, sourceLanguage: validationLanguage, analysisOnly });
          if (detectLanguage && parsed.language && !inferredLanguage) inferredLanguage = parsed.language;
          if (parsed.sourceLanguage && (!validationLanguage || firstAnalysis)) validationLanguage = parsed.sourceLanguage;
          hasForeignPassages ||= parsed.hasForeignPassages === true;
          if (firstAnalysis) parsed.discardLineIndices.forEach((index) => suggestedCleanup.add(index));
          return parsed.translations;
        };
        const request = async (requestMessages) => {
          const remainingMs = deadline.remainingMs();
          if (remainingMs < MIN_AI_REQUEST_BUDGET_MS) throw completionTimeoutError();
          const execute = () => access.client.ask(requestMessages, {
            ...(requestConfig.temperature === undefined ? {} : { temperature: requestConfig.temperature }),
            ...(requestConfig.enableThinking === undefined ? {} : { enableThinking: requestConfig.enableThinking }),
          }, {
            timeoutMs: remainingMs,
          });
          const response = access.budget ? await access.budget.executeAi(execute) : await execute();
          deadline.assertRemaining();
          return parseResponse(response);
        };
        try { return await request(messages); }
        catch (error) {
          if (error?.message !== 'INVALID_JSON' || retriedInvalidJson) throw error;
          retriedInvalidJson = true;
          // Reissue the original task once. Never repair untrusted output or send
          // it back as instructions; keep the original whole-completion deadline.
          const retryMessages = messages.map((message, index) => index === 0 && message.role === 'system'
            ? { ...message, content: `${message.content}\n\n上一轮响应不是有效 JSON。请重新完成原任务，严格检查 JSON 语法，特别是数字 unitId 后不得多出引号；不要输出 Markdown 或说明。` }
            : message);
          return request(retryMessages);
        }
      };

      // These DeepSeek models can emit malformed numeric IDs in long JSON
      // responses. Smaller outputs retain context while fitting the same deadline.
      const compactJsonBatches = (assistantConfig.source || assistantConfig.provider) === 'deepseek'
        && ['deepseek-flash', 'deepseek-v4-pro'].includes(assistantConfig.model);
      const batches = buildTranslationBatches(units, song.title, song.artist,
        { targetLanguage, referenceByUnitId, ...(compactJsonBatches ? { maxUnits: 20 } : {}) });
      if (!translateLyrics) {
        if (detectLanguage || cleanDirtyLyrics) {
          await askForBatch(batches[0], true, true);
        }
      } else {
        for (const [index, batch] of batches.entries()) {
          const parsed = await askForBatch(batch, index === 0 && (detectLanguage || cleanDirtyLyrics));
          if (parsed === null) {
            notNeededBatches.push(batch);
            continue;
          }
          parsed.forEach(({ unitId, text }) => translatedByIndex.set(unitId, text));
        }
      }

      const cleanupIndices = [...suggestedCleanup].sort((a, b) => a - b);
      if (cleanupIndices.length >= artifact.original.lines.length) cleanupIndices.length = 0;
      if (translatedByIndex.size === 0) {
        access.budget?.settle();
        const completedAt = new Date((deps.now || Date.now)()).toISOString();
        const finished = await conditionallyFinish(store, song.id, startedAt, textHash,
          async current => {
            const next = await applySuggestedCleanup(current, cleanupIndices, completedAt, song, lyricAiProcessingKey(assistantConfig));
            if (translateLyrics) next.translationDecision = buildLyricNoTranslationDecision(next, decisionSong(),
              { targetLanguage, sourceLanguage: validationLanguage || inferredLanguage, basis: 'ai' });
            return next;
          });
        return finishWithInferredLanguage(store, db, song, finished, inferredLanguage, deps);
      }
      for (const batch of notNeededBatches) {
        // A same-target batch stays empty even when another batch is foreign.
        // Reissuing it with forced translations would create a same-language rewrite.
        batch.units.forEach(({ unitId }) => translatedByIndex.set(unitId, ''));
      }
      if (translatedByIndex.size !== units.length) throw new Error('INVALID_COVERAGE');
      access.budget?.settle();

      const completedAt = new Date((deps.now || Date.now)()).toISOString();
      const lines = artifact.original.lines.map((_line, index) => translatedByIndex.get(index) || '');
      const finished = await conditionallyFinish(store, song.id, startedAt, textHash, async current => {
        const next = await applySuggestedCleanup({
          ...current, translation: {
          source: 'ai',
          kind: 'ai',
          originalTextHash: textHash,
          lines,
          language: targetLanguage,
          updatedAt: completedAt,
          },
        }, cleanupIndices, completedAt, song);
        next.translationDecision = buildLyricTranslationDecision(next, decisionSong(),
          { status: 'translated', targetLanguage, sourceLanguage: validationLanguage || inferredLanguage,
            basis: 'ai', hasForeignPassages });
        // Validate the actual kept rows again at the storage boundary. The
        // completed decision supplies language evidence for virtual/unknown songs.
        if (!projectLyricArtifact(next, { song: decisionSong(), targetLanguage })?.translation) throw new Error('INVALID_TRANSLATION_OUTPUT');
        return next;
      });
      return finishWithInferredLanguage(store, db, song, finished, inferredLanguage, deps);
    });
  } catch (error) {
    access.budget?.settle();
    try { await access.client.assertCurrent(); } catch { return { state: 'superseded' }; }
    const failedAt = new Date((deps.now || Date.now)()).toISOString();
    return conditionallyFinish(store, song.id, startedAt, textHash, (current) => ({
      ...current,
      aiCompletion: { status: 'failed', errorCode: access.budget?.depleted ? 'request_budget_exhausted' : safeErrorCode(error), updatedAt: failedAt },
      updatedAt: failedAt,
    }));
  }
}

export async function beginLyricAssetAiCompletion({
  env,
  db,
  song,
  store,
  actorAccountId = null,
  force = false,
  targetLanguage = null,
  automatic = false,
  deps = {},
}) {
  const access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
    context: deps.consumerContext, signal: deps.signal, deps });
  db = access.db;
  store = guardLyricsStore(store, access.client.assertCurrent);
  // Internal source adapters may reuse their already authorized snapshot. The
  // pending write below still CAS-checks its ETag before any AI work starts.
  const read = deps.initialRead || await store.get(song.id);
  const current = deps.checkCurrent ? deps.checkCurrent(read) : read;
  if (current.state !== 'found' || current.artifact.status !== 'ready') {
    return { state: 'missing', task: null };
  }
  if (current.artifact.aiCompletion?.status === 'review') {
    const resolved = await resolveLegacyLyricCleanup(store, song, current, deps.now || Date.now);
    return { state: 'already_cleaned', artifact: resolved.artifact, etag: resolved.etag, task: null };
  }
  const effectiveTarget = targetLanguage || access.config.targetLanguage || 'en';
  if (access.config.translateLyrics !== false && (hasCurrentLyricNoTranslationDecision(current.artifact, song, { targetLanguage: effectiveTarget })
    || resolveLyricTranslationNeed(current.artifact.original, song, { targetLanguage: effectiveTarget }).state === 'not_needed')) {
    return { state: 'not_needed', artifact: current.artifact, etag: current.etag, task: null };
  }
  const now = (deps.now || Date.now)();
  if (isFreshLyricAiPending(current.artifact.aiCompletion, now)) {
    return { state: 'pending', artifact: current.artifact, etag: current.etag, task: null };
  }
  const activeLayer = projectLyricArtifact(current.artifact, { song,
    targetLanguage: targetLanguage || access.config.targetLanguage || 'en' })?.translation;
  if (!force && activeLayer) {
    return { state: 'already_translated', artifact: current.artifact, etag: current.etag, task: null };
  }

  const startedAt = new Date(now).toISOString();
  const existingTranslation = current.artifact.translation;
  const pending = {
    ...current.artifact,
    aiCompletion: { status: 'pending', updatedAt: startedAt },
    updatedAt: startedAt,
  };
  access.budget?.requireSettlementRoom();
  const written = await store.putIfMatch(song.id, pending, current.etag,
    { automation: automatic ? current.automation : undefined });
  if (written.state === 'conflict') {
    const winner = await store.get(song.id);
    if (winner.state === 'found'
      && winner.artifact.status === 'ready'
      && isFreshLyricAiPending(winner.artifact.aiCompletion, now)) {
      return { state: 'pending', artifact: winner.artifact, etag: winner.etag, task: null };
    }
    return { state: 'conflict', task: null };
  }
  return {
    state: 'started',
    artifact: written.artifact,
    etag: written.etag,
    automation: written.automation,
    task: runLyricAssetAiCompletion({
      env,
      db,
      song,
      store,
      startedAt,
      textHash: written.artifact.textHash,
      actorAccountId,
      force,
      deps: { ...deps, aiAccess: access, initialRead: { ...written, state: 'found' } },
    }),
  };
}
