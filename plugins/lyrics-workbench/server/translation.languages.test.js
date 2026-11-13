import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { TRANSLATION_TARGETS, targetScriptEvidence } from '../shared/translation-languages.js';
import { languageDecisionCapabilities } from './translation.fixture.js';
const built = await build({ entryPoints: [fileURLToPath(new URL('./translationFormat.js',import.meta.url))], bundle:true, write:false, format:'esm', platform:'node', plugins:[{name:'format-capabilities', setup(api){
  api.onResolve({filter:/^@flaretune\//},args=>({path:args.path,namespace:'format-test'}));
  api.onLoad({filter:/.*/,namespace:'format-test'},()=>({contents:`export const computeHash = async () => 'a'.repeat(64); export const isValidSongLanguage = value => ['zh','en','ja','ko','ru','es','fr','de','sv','vi','yue','it','th','pt'].includes(value); export const analyzeLrcLanguage = () => ({}); export const isNonLyricText = () => false; export const normalizeLrcForHash = x => x; export const parseLrcLines = () => [];` + languageDecisionCapabilities}));
}}]});
const {parseTranslationResponse,parseLanguageAwareTranslationResponse,buildTranslationPrompt,getTranslationPromptVersion}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const units=[{unitId:0,text:'Hello world'}];
const translated = text => ({translations:[{unitId:0,text}]});
const valid={zh:'你好世界','zh-Hant':'愛與夢想',en:'A beautiful world',ja:'美しい世界だね',ko:'아름다운 세상이야',ru:'Прекрасный мир',es:'Un mundo hermoso',fr:'Un beau monde',de:'Eine schöne Welt',sv:'En vacker värld',vi:'Một thế giới đẹp',yue:'呢個世界真靚',it:'Un mondo bellissimo',th:'โลกที่สวยงาม',pt:'Um mundo bonito'};
for(const target of TRANSLATION_TARGETS){
  test(`target ${target} accepts script-compatible output and rejects clearly incompatible script`,()=>{
    assert.equal(parseTranslationResponse(translated(valid[target]),units,{targetLanguage:target})[0].text,valid[target]);
    const wrong=['zh','zh-Hant','ja','ko','ru','yue','th'].includes(target)?'An untranslated English line':'これは日本語です';
    assert.throws(()=>parseTranslationResponse(translated(wrong),units,{targetLanguage:target}),/TARGET_LANGUAGE_MISMATCH/u);
  });
}
test('Traditional Chinese does not silently accept clearly Simplified-only wording',()=>{
  assert.throws(()=>parseTranslationResponse(translated('我们爱这个世界'),units,{targetLanguage:'zh-Hant'}),/TARGET_LANGUAGE_MISMATCH/u);
  assert.throws(()=>parseTranslationResponse(translated('我們愛這個世界'),units,{targetLanguage:'zh'}),/TARGET_LANGUAGE_MISMATCH/u);
  assert.equal(targetScriptEvidence('你好','zh-Hant'),'unknown');
});
test('Latin text remains unknown instead of being guessed as English',()=>{
  assert.equal(targetScriptEvidence('Hola mundo','en'),'unknown');
  assert.throws(()=>parseLanguageAwareTranslationResponse({notNeeded:true},[{unitId:0,text:'Hola mundo'}],{targetLanguage:'en'}),/LANGUAGE_UNDETERMINED/u);
});
test('a response declaration contradicting the requested Latin language is rejected',()=>{
  assert.throws(()=>parseLanguageAwareTranslationResponse({...translated('Hola mundo'),translationLanguage:'es'},units,{targetLanguage:'en'}),/TARGET_LANGUAGE_MISMATCH/u);
});
test('actual Japanese units cannot be skipped as already English based on a claimed metadata language',()=>{
  assert.throws(()=>parseLanguageAwareTranslationResponse({notNeeded:true,songLanguage:'en'},[{unitId:0,text:'君が好きだよ'}],{targetLanguage:'en'}),/INVALID_NOT_NEEDED|SOURCE_LANGUAGE_MISMATCH/u);
});
test('unchanged whole-body output is not a translation, while an explicitly completed mixed batch can retain target-language lines',()=>{
  assert.throws(()=>parseTranslationResponse(translated('Hello world'),units,{targetLanguage:'en'}),/UNCHANGED_TRANSLATION/u);
  assert.equal(parseTranslationResponse(translated('Hello world'),units,{targetLanguage:'en',allowUnchanged:true})[0].text,'Hello world');
});
test('a Traditional target declaration does not become a catalog song-language value',()=>{
  const result=parseLanguageAwareTranslationResponse({...translated('愛與夢想'),songLanguage:'zh-Hant',translationLanguage:'zh-Hant'},units,{targetLanguage:'zh-Hant',sourceLanguage:'en'});
  assert.equal(result.language,null); assert.equal(result.translations.length,1);
});
test('all target prompts carry the same fidelity rules with their own requested language',()=>{
  for(const target of TRANSLATION_TARGETS){
    const prompt=buildTranslationPrompt(units,'Context title','Context artist',{targetLanguage:target});
    assert.ok(prompt[0].content.includes(`（${target}）`));
    assert.ok(prompt[0].content.includes('信、达、雅')); assert.deepEqual(JSON.parse(prompt[1].content).units,[{unitId:0,text:'Hello world'}]);
  }
  assert.equal(getTranslationPromptVersion(),'lyrics-target-v8-vocalization');
});

test('same-request AI language evidence turns an already-target copy into no translation, not a fake layer',()=>{
  const result=parseLanguageAwareTranslationResponse({...translated('Hello world'),songLanguage:'en'},units,{targetLanguage:'en'});
  assert.equal(result.translations,null); assert.equal(result.language,'en');
  assert.throws(()=>parseLanguageAwareTranslationResponse(translated('Hello world'),units,{targetLanguage:'en'}),/UNCHANGED_TRANSLATION|LANGUAGE_UNDETERMINED/u);
});
