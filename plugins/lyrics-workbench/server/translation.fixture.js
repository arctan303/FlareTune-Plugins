import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Isolated public-capability fixture for plugin-only CI. The host runs separate
// integration tests against its real SDK and artifact schema.
export const languageDecisionCapabilities = String.raw`
const spoken = x => /^zh(?:-|$)/u.test(x || '') ? 'zh' : x;
const known = x => ['zh','en','ja','ko','ru','es','fr','de','sv','vi','yue','it','th','pt'].includes(x) ? x : null;
export const resolveLyricTranslationNeed = (original, song, {targetLanguage = 'zh'} = {}) => {
  const sourceLanguage = known(song?.language), text = original.lines.map(x => x.text).join('\n');
  const result = (state, reason) => ({state, reason, sourceLanguage});
  if (!text.trim()) return result('not_needed','empty');
  if (!sourceLanguage) return result('unknown','unknown_language');
  const han = /\p{Script=Han}/u.test(text), latin = /\p{Script=Latin}/u.test(text), kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const expected = ['zh','yue'].includes(sourceLanguage) ? han : sourceLanguage === 'ja' ? han || kana
    : sourceLanguage === 'ko' ? /\p{Script=Hangul}/u.test(text) : sourceLanguage === 'ru' ? /\p{Script=Cyrillic}/u.test(text)
      : sourceLanguage === 'th' ? /\p{Script=Thai}/u.test(text) : latin;
  if (!expected) return result('unknown','script_mismatch');
  if ((['zh','yue','ja'].includes(sourceLanguage) && latin) || (!['zh','yue','ja'].includes(sourceLanguage) && han)) return result('unknown','mixed_content');
  return result(spoken(sourceLanguage) === spoken(targetLanguage) ? 'not_needed' : 'needed','catalog_language');
};
export const getCurrentLyricTranslationDecision = (artifact, song, {targetLanguage} = {}) => {
  const d = artifact.translationDecision;
  return d && d.textHash === artifact.textHash && d.targetLanguage === targetLanguage && d.policyVersion === 1
    && d.songLanguage === known(song?.language) ? d : null;
};
export const hasCurrentLyricNoTranslationDecision = (artifact, song, options) => getCurrentLyricTranslationDecision(artifact,song,options)?.status === 'not_needed';
export const buildLyricTranslationDecision = (artifact, song, options) => {
  const d = {status: options.status || 'translated', textHash: artifact.textHash, targetLanguage: options.targetLanguage,
    sourceLanguage: options.sourceLanguage, songLanguage: known(song?.language), basis: options.basis, policyVersion: 1,
    ...(options.hasForeignPassages ? {hasForeignPassages:true} : {})};
  if (!known(d.sourceLanguage) && d.basis !== 'rules') throw Error('INVALID_LYRIC_TRANSLATION_DECISION');
  if (d.status === 'not_needed' && d.basis !== 'rules' && spoken(d.sourceLanguage) !== spoken(d.targetLanguage)) throw Error('INVALID_LYRIC_TRANSLATION_DECISION');
  return d;
};
export const buildLyricNoTranslationDecision = (artifact,song,options) => buildLyricTranslationDecision(artifact,song,{...options,status:'not_needed'});
`;

export const completionCapabilities = String.raw`
export const createLyricDocument = x => x;
export const isSingableLineText = x => /[\p{L}\p{N}]/u.test(x || '');
export const isLeadingProviderMetadata = () => false;
export const computeHash = async text => (await import('node:crypto')).createHash('sha256').update(String(text)).digest('hex');
export const isNonLyricText = () => false;
export const analyzeLrcLanguage = () => ({});
export const normalizeLrcForHash = x => x;
export const parseLrcLines = () => [];
export const isValidSongLanguage = x => ['en','zh','ja','ko','ru','es','fr','de','sv','vi','yue','it','th','pt','other'].includes(x);
export const lyricTextForHash = lines => lines.map(x => x.text).join('\n');
export const buildReadyLyricArtifact = async (song, doc) => ({artifact:{schemaVersion:1,status:'ready',songId:song.id,
  textHash:await computeHash(lyricTextForHash(doc.lines)),original:{source:doc.source,format:doc.format,syncMode:'line',lines:doc.lines},
  translation:null,aiCompletion:null,offsetMs:0,provenance:{},updatedAt:new Date().toISOString()}});
export const buildEditedLyricArtifact = async (song, lines, {translationLanguage = 'zh'} = {}) => {
  const original = lines.map(({tlyric,...line}) => line);
  const artifact = (await buildReadyLyricArtifact(song,{source:'manual',format:'lrc',lines:original})).artifact;
  if (lines.some(line => line.tlyric)) artifact.translation = {source:'manual',language:translationLanguage,
    originalTextHash:artifact.textHash,lines:lines.map(line => line.tlyric || ''),updatedAt:artifact.updatedAt};
  return artifact;
};
export const projectLyricArtifact = (artifact, {targetLanguage,song = {}}) => ({translation: artifact.translation && artifact.translation.language === targetLanguage
  && !hasCurrentLyricNoTranslationDecision(artifact,song,{targetLanguage})
  && !artifact.original.lines.every((line,i) => line.text === artifact.translation.lines[i]) ? artifact.translation : null,
  translationAvailable: !!artifact.translation && !hasCurrentLyricNoTranslationDecision(artifact,song,{targetLanguage})});
export const isFreshLyricAiPending = x => x?.status === 'pending' && Date.now() - Date.parse(x.updatedAt) < 30000;
export const storeAuthorityGuard = Symbol('guard');
export const guardStoreAuthority = x => x;
export const createPluginServiceLease = () => {throw Error('Unexpected external lease')};
export const isPluginServiceLease = () => false;
export const createSubsonicPluginServiceLease = createPluginServiceLease;
export const createAiGatewayClient = createPluginServiceLease;
export const getAIAssistantConfig = createPluginServiceLease;
export const createInvocationDatabase = x => x;
export const invocationBudget = () => null;
` + languageDecisionCapabilities;

export async function loadTestModule(path, { workflow = false, leadingTitleMetadata = false } = {}) {
  const capabilities = leadingTitleMetadata ? completionCapabilities.replace('export const isLeadingProviderMetadata = () => false;',
    'export const isLeadingProviderMetadata = (line, index, song) => index === 0 && line.text === song?.title;') : completionCapabilities;
  const entry = workflow ? `export * from ${JSON.stringify(fileURLToPath(path))}; export * from '@flaretune/plugin-sdk/server/lyric-workflow';` : undefined;
  const bundled = await build({ ...(entry ? { stdin: { contents: entry, resolveDir: fileURLToPath(new URL('.', path)) } } : { entryPoints: [fileURLToPath(path)] }),
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'test-capabilities', setup(api) {
      api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
      api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js' }));
    } }] });
  return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
}
