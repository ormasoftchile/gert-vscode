const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..','..'),binary=path.join(root,'gert-typed-results-public.exe');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'public-producer',name),'utf8'));
const client=require('../out/presentationClient'),{AuthoringClient}=require('../out/authoringClient');
const {decodeAuthoringCapabilities,decodeAuthoringReply}=require('../out/authoringProtocol');
const {decodeExpressionCapabilities}=require('../out/expressionPresentationProtocol');
const {resolveExpressionPresentation}=require('../out/expressionPresentationClient');
const {parseGraphDocument}=require('../out/directGraphPreview');
const {ResultsAssembly,canonicalResultsJSON,validateResults}=require('../out/typedResults');
const {buildStdioRunArgs}=require('../out/directRunSession');
test('real public v3 capabilities and real authoring/expression replies cross strict consumer',async()=>{
  client.requireTypedPlanVersion(await client.finiteHelper(binary,['presentation','capabilities','--v3']));
  decodeAuthoringCapabilities(await client.finiteHelper(binary,['authoring','capabilities','--v3']),3);
  decodeExpressionCapabilities(await client.finiteHelper(binary,['presentation','expressions','capabilities','--v3']),3);
  const author=new AuthoringClient();
  try {
    const request=read('authoring-request-v3.json'),actual=await author.resolve(binary,request);
    assert.deepEqual(actual,decodeAuthoringReply(read('authoring-reply-v3.json'),request));
    assert.ok(actual.items.some(item=>item.kind==='variable'&&item.value_type==='array'));
  } finally {author.dispose();}
  const request=read('expression-request-v3.json');
  const reply=await resolveExpressionPresentation(binary,{...request,schema_version:'presentation-resolve/v1'});
  assert.deepEqual(reply,read('expression-reply-v3.json'));
});
test('actual authored/frozen v3 graph metadata, ordered bindings, null presence and closed fields',()=>{
  for(const file of ['example-authored-graph.json','example-frozen-graph.json']){
    const raw=read(file),graph=parseGraphDocument(JSON.stringify(raw));
    assert.equal(graph.schema_version,'3');
    assert.deepEqual(graph.frames[0].invocation.bindings.map(x=>x.name),['phase','observations']);
    assert.equal(graph.nodes.find(n=>n.data.kind==='assign').data.details.role,'technical');
    for(const mutate of [
      g=>g.frames[0].invocation.extra=true,
      g=>g.frames[0].invocation.bindings[0].value_present='yes',
      g=>delete g.frames[0].invocation.bindings[0].value,
      g=>g.nodes.find(n=>n.data.kind==='assign').data.details.assign[0].value_present='yes',
      g=>g.nodes.find(n=>n.data.kind==='results').data.details.role='technical',
    ]) {const bad=structuredClone(raw);mutate(bad);assert.throws(()=>parseGraphDocument(JSON.stringify(bad)));}
  }
});
test('all real producer inline publications and actual 22 chunks validate exact canonical documents',()=>{
  const fixtures=JSON.parse(fs.readFileSync(path.join(root,'producer-fixtures.json')));
  const dir=path.dirname(path.join(root,fixtures.actual_runtime_fixtures.verification));
  for(const name of ['singleton','multiple','resolved-empty','large-native']){
    const file=path.join(dir,name,'canonical-public-results.json');
    assert.ok(fs.existsSync(file));
    const text=fs.readFileSync(file,'utf8').trim(),publication=validateResults(JSON.parse(text));
    assert.equal(canonicalResultsJSON(publication),text);
  }
});
test('typed run requires features while legacy argv retains original flags',()=>{
  assert.deepEqual(buildStdioRunArgs('test.yaml',{},undefined,false,new Set(),undefined,true),
    ['run','--stdio','--require-capabilities','typed-results/v1,run-results-chunks/v1','test.yaml']);
  assert.deepEqual(buildStdioRunArgs('test.yaml',{}),['run','--stdio','test.yaml']);
});
test('redacted and unavailable responses retain honest reasons and failed executions never publish',()=>{
  for(const [status,reason] of [['unavailable','no-publication'],['redacted','protected-content']]){
    const frame={runID:'r',status:'completed',results:null,results_unavailable:{status,reason}};
    assert.deepEqual(new ResultsAssembly('r').complete(frame),{state:'unavailable',status,reason});
    assert.deepEqual(new ResultsAssembly('r').complete({...frame,status:'failed'}),{state:'unavailable',reason:'execution-not-completed'});
  }
});
test('shared browser/host canonical encoder preserves astral ordering, HTML, Unicode separators, numeric forms',()=>{
  assert.equal(canonicalResultsJSON({'😀':-0,'\ue000':1e-7,a:'<>&\u2028\u2029',b:1.2345678901234567}),
    '{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029","b":1.2345678901234567,"":1e-7,"😀":-0}');
});
test('capability transport rejects duplicate members and invalid UTF8 before caching',async()=>{
  for(const bytes of ['{"version":1,"version":1}',Buffer.from([0x22,0xff,0x22])]){
    const data=Buffer.from(bytes).toString('base64');
    await assert.rejects(client.finiteHelper(process.execPath,['-e',`process.stdout.write(Buffer.from('${data}','base64'))`]),/invalid-helper-response/);
  }
});
test('actual admitted historical helper retains metadata v1/v2 and exact v3 opt-in fallback without execution',async()=>{
  const legacy=path.join(root,'gert-typed-results-core.exe');
  await client.verifyPresentationHelper(legacy);
  await assert.rejects(client.requireCompatibleExecution(legacy,{nodes:[{data:{kind:'results'}}]}),/capability query failed/);
  await client.requireCompatibleExecution(legacy,{nodes:[{data:{kind:'noop'}}]});
  const fixture=require('./fixtures/authoring-include.json'),file=path.join(__dirname,'historical-metadata.runbook.yaml');
  const request={schema_version:'authoring-request/v3',request_id:'historical',operation:'complete',
    document:{uri:require('node:url').pathToFileURL(file).href,path:file,version:1,text:fixture.prefix+'\n'},
    context:{project_root:__dirname,generation:1},overlays:[],position:fixture.prefix.length};
  const author=new AuthoringClient();
  try{
    const reply=await author.resolve(legacy,request);assert.equal(reply.schema_version,'authoring-reply/v2');
    assert.deepEqual(reply.items.map(i=>i.name),['runbook','runbook_ref']);
  }finally{author.dispose();}
  const {operation,position,...base}=request;
  const expression=await resolveExpressionPresentation(legacy,{...base,schema_version:'presentation-resolve/v1',
    document:{...request.document,text:'apiVersion: runbook/v1\nid: old\nflow:\n  - step:\n      id: n\n      type: noop\n      when: true\n'}});
  assert.equal(expression.schema_version,'expression-resolve/v1');
  assert.equal(expression.status,'resolved');
});
