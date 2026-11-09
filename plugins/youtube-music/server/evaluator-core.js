// Shared QuickJS isolation policy. The engine is supplied by the host-specific loader.
// No host callbacks, files, network APIs, environment variables, or module loader
// are installed in the guest context. Only n/sig strings can leave that context.
import {shouldInterruptAfterDeadline} from 'quickjs-emscripten-core';
import {YouTubeError} from "./core.js";

export const PLAYER_EVALUATOR_LIMITS=Object.freeze({
  maxTimeMs:1500,
  memoryBytes:33554432,
  // Keep guest recursion below the host Wasm stack. A 1MiB guest allowance
  // can exhaust the host first, preventing QuickJS from returning an error.
  stackBytes:262144,
  maxInterrupts:10000,
});

export function evaluatePlayerInEngine(engine,data,{
  maxTimeMs=PLAYER_EVALUATOR_LIMITS.maxTimeMs,
  memoryBytes=PLAYER_EVALUATOR_LIMITS.memoryBytes,
  maxInterrupts=PLAYER_EVALUATOR_LIMITS.maxInterrupts,
}={}) {
  if(typeof data?.output!=='string'||data.output.length>2097152)throw new YouTubeError('YOUTUBE_JS_INPUT_LIMIT');
  const runtime=engine.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(PLAYER_EVALUATOR_LIMITS.stackBytes);
  const timeExpired=shouldInterruptAfterDeadline(Date.now()+maxTimeMs);
  let interrupts=0;
  // Deployed Workers freeze their clock during synchronous execution. The
  // callback budget still terminates execution there; it is not a wall-time cap.
  runtime.setInterruptHandler(()=>++interrupts>maxInterrupts||timeExpired());
  let context,result;
  try {
    context=runtime.newContext();
    result=context.evalCode('(function(){const value=(function(){\n'+data.output+'\n})();if(typeof value!=="object"||value===null)throw new TypeError("Invalid signature result");return {n:value.n,sig:value.sig};})()','player-diagnostic.js',{type:'global'});
    if(result.error){
      const nameHandle=context.getProp(result.error,'name');
      let rawName;
      try{rawName=context.getString(nameHandle);}finally{nameHandle.dispose();}
      const kind=['ReferenceError','SyntaxError','TypeError','InternalError','RangeError','Error'].includes(rawName)?rawName:'Error';
      throw new YouTubeError('YOUTUBE_QUICKJS_'+kind.toUpperCase());
    }
    const output={};
    for(const key of ['n','sig']){
      const value=context.getProp(result.value,key);
      try{if(context.typeof(value)==='string'){
        const text=context.getString(value);
        if(text.length>16384)throw new YouTubeError('YOUTUBE_JS_RESULT_LIMIT');
        output[key]=text;
      }}finally{value.dispose();}
    }
    return output;
  }finally{result?.error?.dispose();result?.value?.dispose();context?.dispose();runtime.dispose();}
}

