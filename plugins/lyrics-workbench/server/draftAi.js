import { buildEditedLyricArtifact, projectLyricArtifact } from "@flaretune/plugin-sdk/server/lyric-workflow";
import { runLyricAssetAiCompletion } from "./translation.js";
import { createLyricDraftReceipt } from "./draftReceipt.js";

/** Run the configured lyric AI against an isolated draft. No R2 asset or song
 * metadata is changed; the caller still has to save its edited document. */
export async function completeLyricDraft({ env, db, song, lines, translationLanguage, actorAccountId, etag, deps = {} }) {
  const now = deps.now || Date.now;
  const draft = await buildEditedLyricArtifact(song, lines, { now: now(), translationLanguage });
  const startedAt = new Date(now()).toISOString();
  let artifact = {
    ...draft,
    aiCompletion: { status: 'pending', updatedAt: startedAt },
    updatedAt: startedAt,
  };
  let revision = 0;
  let inferredLanguage = null;
  const store = {
    async get() { return { state: 'found', artifact, etag: String(revision) }; },
    async putIfMatch(_songId, next, etag) {
      if (etag !== String(revision)) return { state: 'conflict' };
      artifact = next;
      revision += 1;
      return { state: 'updated', artifact, etag: String(revision) };
    },
  };
  const finished = await runLyricAssetAiCompletion({
    env, db, song, store, startedAt, textHash: artifact.textHash,
    actorAccountId, force: true,
    deps: {
      ...deps,
      updateSongLanguage: async (_songId, language) => { inferredLanguage = language; },
    },
  });
  if (finished.state === 'unavailable' || finished.state === 'superseded' || artifact.aiCompletion?.status === 'pending') {
    return { status: 'failed', errorCode: 'completion_superseded' };
  }
  if (artifact.aiCompletion?.status === 'failed') {
    return { status: 'failed', errorCode: artifact.aiCompletion.errorCode };
  }
  inferredLanguage ||= artifact.translationDecision?.sourceLanguage || null;
  // Local completion binds its decision to the inferred tag without writing
  // that tag from a draft. Virtual songs retain their original tag scope.
  const projectionSong = inferredLanguage && !/^yt:[A-Za-z0-9_-]{11}$/u.test(song.id)
    ? { ...song, language: inferredLanguage } : song;
  const projected = projectLyricArtifact(artifact, { song: projectionSong,
    targetLanguage: artifact.translationDecision?.targetLanguage || null });
  const translations = projected?.translation?.lines || [];
  const receipt = await createLyricDraftReceipt(env, { songId: song.id, accountId: actorAccountId,
    etag, language: inferredLanguage, textHash: artifact.textHash, decision: artifact.translationDecision, now: now() });
  return {
    status: 'ready',
    lines: artifact.original.lines.map((line, index) => ({
      ...line,
      ...(translations[index] ? { tlyric: translations[index] } : {}),
    })),
    inferredLanguage,
    translationLanguage: projected?.translation?.language || null,
    receipt,
  };
}
