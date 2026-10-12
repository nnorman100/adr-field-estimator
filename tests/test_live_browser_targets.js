const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {backendUrl,parseOptions,createArtifactDirectory}=require('../scripts/verify_live_browser');
const HOST='alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app';
const PRODUCTION='https://alert-disaster-field-estimator-545776254070.us-west2.run.app';

test('candidate URL construction is restrictive and deterministic',()=>{
  for(const tag of ['a','harden-fixes','workspaces','v13-hup','a'.repeat(16)]){
    assert.equal(backendUrl(tag),`https://${tag}---${HOST}`);
    const options=parseOptions(['--backend-tag',tag]);
    assert.equal(options.service,backendUrl(tag));
    assert.equal(options.mode,'staged');
    assert.equal(options.local,true);
  }
  for(const tag of ['', 'A','1abc','-abc','abc-','a'.repeat(17),'a'.repeat(63),'a'.repeat(64),'a.b','a/b','a@evil','a:443','a?b','a#b','a_b','a%2fb','a\n',' a','https://evil.test']){
    assert.throws(()=>backendUrl(tag));
    assert.throws(()=>parseOptions(['--backend-tag',tag]));
  }
});

test('authenticated runs require an unambiguous explicit target',()=>{
  for(const args of [[],['--headless'],['--backend-tag'],['--backend-tag','--production'],
    ['--backend-tag','a','--backend-tag','b'],['--production','--production'],
    ['--production','--backend-tag','a'],['--workspaces','--backend-tag','a'],
    ['--production','--workspaces'],['--unknown'],['https://evil.test']]){
    assert.throws(()=>parseOptions(args));
  }
  const production=parseOptions(['--production']);
  assert.equal(production.service,PRODUCTION);
  assert.equal(production.mode,'production');
  assert.equal(production.local,false);
  assert.equal(parseOptions(['--workspaces']).service,backendUrl('workspaces'));
});

test('unsigned smoke keeps local UI coverage without an obsolete candidate',()=>{
  const options=parseOptions(['--auth-smoke','--headless','--slow-init']);
  assert.equal(options.service,PRODUCTION);
  assert.equal(options.local,true);
  assert.equal(parseOptions(['--auth-smoke','--backend-tag=harden-fixes']).service,backendUrl('harden-fixes'));
});

test('artifact validation terminates at inaccessible roots',t=>{
  t.mock.method(fs,'existsSync',()=>false);
  assert.throws(()=>createArtifactDirectory(path.resolve(os.tmpdir(),'missing')),/filesystem root/);
});

test('artifacts use unique external directories and preserve existing evidence',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'adr-target-test-'));
  try{
    const historical=path.join(parent,'staged-authenticated.txt');
    fs.writeFileSync(historical,'historical evidence');
    const options=parseOptions(['--production','--artifact-dir',parent]);
    const first=createArtifactDirectory(options.artifactDir);
    const second=createArtifactDirectory(options.artifactDir);
    assert.notEqual(first,second);
    assert.equal(path.dirname(first),fs.realpathSync(parent));
    assert.equal(fs.readFileSync(historical,'utf8'),'historical evidence');
    assert.throws(()=>createArtifactDirectory(path.resolve(__dirname,'..','review-artifacts')));
    assert.throws(()=>parseOptions(['--production','--artifact-dir','relative']));
    assert.throws(()=>parseOptions(['--production','--artifact-dir','']));
    const link=path.join(parent,'repository-link');
    fs.symlinkSync(path.resolve(__dirname,'..'),link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>createArtifactDirectory(path.join(link,'review-artifacts','new-run')));
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
