const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const yaml=require('yaml');
const root='C:\\One\\gert-sqllivesite', evidence=path.resolve(__dirname,'..','..','caller-baseline-profile');
const lib='hands-on-tests\\lib\\icm-db-info-probe.runbook.yaml';
const load=file=>yaml.parse(fs.readFileSync(file,'utf8'));
function steps(flow) {
  return flow.flatMap(item=>{
    if(item.iterate)return[{id:item.iterate.id,kind:'iterate',value:item.iterate},...steps(item.iterate.steps)];
    const step=item.step;
    return [{id:step.id,kind:step.type,value:step},...(step.branches??[]).flatMap(branch=>steps(branch.steps))];
  });
}
test('only mechanical initialization/publication changes; genuine configuration and meaningful checks preserved',()=>{
  const before=load(path.join(evidence,'source',lib)),after=load(path.join(root,lib));
  const old=steps(before.flow),next=steps(after.flow);
  for(const step of old.filter(step=>['assert','branch','collector','end','tool'].includes(step.kind))) {
    const actual=next.find(item=>item.id===step.id);
    assert.ok(actual,`Lost operational node ${step.id}`);
    if(step.kind==='assert'||step.kind==='collector'||step.kind==='end')assert.deepEqual(actual.value,step.value);
  }
  for(const id of ['initialize_probe','initialize_observations','no_initial_observation'])assert.ok(!next.some(step=>step.id===id));
  for(const id of ['incident_loaded','missing_target_status','retain_query_scope','prepare_database_query','record_outcome'])
    assert.equal(next.find(step=>step.id===id).kind,'assign');
  assert.equal(next.find(step=>step.id==='configurations').value.over,'db_observations');
  assert.equal(after.flow.at(-1).step.type,'results');
  assert.ok(!next.some(step=>step.kind==='iterate'&&step.value.over==='publish'));
  assert.deepEqual(after.bindings.find(binding=>binding.name==='db_observations').value,[]);
  assert.equal(after.bindings.find(binding=>binding.name==='db_observations').type,'array');
  assert.deepEqual(after.outputs.result.value_tree.incident,before.flow.at(-1).iterate.collect_values.probe_results.incident);
  assert.deepEqual(after.outputs.result.value_tree.scope,before.flow.at(-1).iterate.collect_values.probe_results.scope);
  assert.equal(after.outputs.result.value_tree.database_info,'${database_info_public}');
  assert.equal(next.find(step=>step.id==='get_database_info').value.capture.database_info_public,'outputs');
  assert.equal(next.filter(step=>step.id==='get_database_info').length,1);
  const oldDisplay=old.find(step=>step.id==='configuration').value;
  assert.deepEqual(next.find(step=>step.id==='configuration').value,oldDisplay,'Existing display is not renderer work');
});
test('synthetic callers forward explicit public outputs and publish only at root terminal Results',()=>{
  for(const name of ['singleton','multiple','resolved-empty','query-failure','invalid-window']) {
    const file=`tests\\icm-db-info-probe\\prefilled-${name}.runbook.yaml`,before=load(path.join(evidence,'source',file)),after=load(path.join(root,file));
    assert.deepEqual(after.requires,before.requires);assert.deepEqual(after.toolRefs,before.toolRefs);
    assert.deepEqual(after.flow[0].step.include,before.flow[0].step.include,'Scope and fixture inputs remain immutable');
    assert.equal(after.flow[0].step.capture.probe_result,'outputs.result');
    assert.equal(after.outputs.result.value_expr,'probe_result');
    assert.equal(after.flow.at(-1).step.type,'results');
    assert.ok(!fs.readFileSync(path.join(root,file),'utf8').includes('probe_results'));
  }
});
test('all fixture payloads, package maps, tool definitions and negative controls outside narrow migration remain byte-identical',()=>{
  const admission=JSON.parse(fs.readFileSync(path.join(evidence,'admission.json'),'utf8'));
  const migrated=new Set([lib,...['singleton','multiple','resolved-empty','query-failure','invalid-window'].map(name=>`tests\\icm-db-info-probe\\prefilled-${name}.runbook.yaml`)]);
  for(const item of admission.files.filter(item=>!migrated.has(item.file))) {
    const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,item.file))).digest('hex');
    assert.equal(actual,item.sha256,item.file);
  }
});
