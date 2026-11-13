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
test('Latin script compatibility does not guess the underlying language',()=>{
  assert.equal(targetScriptEvidence('Hola mundo','en'),'unknown');
});
test('translation role rejects source-language and target-language declarations',()=>{
  for(const field of [{songLanguage:'en'},{translationLanguage:'es'},{unitLanguages:[]},{notNeeded:true}]){
    assert.throws(()=>parseLanguageAwareTranslationResponse({...translated('Un bello mundo'),...field},units,{targetLanguage:'es'}),/INVALID_RESPONSE_FIELDS/u);
  }
});
test('unchanged whole-body output cannot be saved as a translation',()=>{
  assert.throws(()=>parseTranslationResponse(translated('Hello world'),units,{targetLanguage:'en'}),/UNCHANGED_TRANSLATION/u);
});
test('all target prompts carry fidelity rules and delegate only translation',()=>{
  for(const target of TRANSLATION_TARGETS){
    const prompt=buildTranslationPrompt(units,'Context title','Context artist',{targetLanguage:target});
    assert.ok(prompt[0].content.includes('（'+target+'）'));
    assert.ok(prompt[0].content.includes('信、达、雅'));
    assert.ok(prompt[0].content.includes('不重新判断语言或是否需要翻译'));
    assert.deepEqual(JSON.parse(prompt[1].content).units,[{unitId:0,text:'Hello world'}]);
  }
  assert.equal(getTranslationPromptVersion(),'lyrics-1.0.0-translation');
});
