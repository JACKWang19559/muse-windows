'use strict';
const ALLOWED = new Set(['workspace_list_files','workspace_read_file','muse_list_apps','muse_read_app','memory_search','memory_read']);
function readOnlyRuntime(runtimes, options = {}) {
  const owners = new Map(),tools=[];
  for(const runtime of runtimes){
    const entries=typeof runtime.getTools==='function'?runtime.getTools():runtime.tools;
    for(const tool of entries){const name=tool?.function?.name;if(!ALLOWED.has(name))continue;if(owners.has(name))throw new Error('重复的只读能力。');owners.set(name,runtime);tools.push(tool);}
  }
  return {getTools:()=>structuredClone(tools),execute:call=>{
    const owner=owners.get(call?.function?.name);
    if(!owner)return Promise.resolve({ok:false,error:{code:options.code||'scheduled_read_only',message:options.message||'计划只允许读取明确授权的资料和应用源码，不能写入、构建或创建更多计划。'}});
    return typeof owner.execute==='function'?owner.execute(call):owner.executeTool(call);
  }};
}
module.exports={readOnlyRuntime};
