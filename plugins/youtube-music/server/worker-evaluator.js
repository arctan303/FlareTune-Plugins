// Loading pattern from the maintained quickjs-emscripten Cloudflare example:
// https://github.com/justjake/quickjs-emscripten/tree/main/examples/cloudflare-workers
// Run prepare-wasm.mjs before bundling. Wrangler resolves the variant's workerd
// condition and imports a precompiled WebAssembly.Module, avoiding dynamic
// WebAssembly compilation in the Worker.
import baseVariant from '@jitl/quickjs-wasmfile-release-sync';
import wasmModule from "./vendor/quickjs-release.wasm";
import {newVariant,newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import {evaluatePlayerInEngine,PLAYER_EVALUATOR_LIMITS} from "./evaluator-core.js";

const cloudflareVariant=newVariant(baseVariant,{wasmModule});
let enginePromise;

export function ready(){
  if(!enginePromise){
    enginePromise=newQuickJSWASMModuleFromVariant(cloudflareVariant).catch(error=>{
      enginePromise=undefined;
      throw error;
    });
  }
  return enginePromise;
}

// Each call gets a fresh VM runtime/context. The Wasm engine alone is reused.
// The 1500ms deadline is supplemented by an interrupt callback budget, because
// deployed workerd clocks do not advance while synchronous code is running.
export async function evaluatePlayer(data,limits){
  return evaluatePlayerInEngine(await ready(),data,limits);
}

export {PLAYER_EVALUATOR_LIMITS};
