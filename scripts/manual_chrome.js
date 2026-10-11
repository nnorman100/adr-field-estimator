/* Launch normal private Chrome. Attach automation only after the human finishes Google sign-in. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process');
function chromePath(){
  for(const base of [process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean)){
    const candidate=path.join(base,'Google','Chrome','Application','chrome.exe');
    if(fs.existsSync(candidate))return candidate;
  }
  throw Error('Installed Chrome was not found.');
}
function launchArgs(profile,port,base){
  return ['--user-data-dir='+profile,'--incognito','--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port='+port,'--no-first-run','--no-default-browser-check',base];
}
async function launchManual(base,port=9337){
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error("Invalid private Chrome port.");
  await new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',()=>reject(Error('Private Chrome port is busy; no existing browser was touched.')));
    probe.listen(port,'127.0.0.1',()=>probe.close(resolve));
  });
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'adr-manual-chrome-'));
  const child=spawn(chromePath(),launchArgs(profile,port,base),{stdio:'ignore',windowsHide:true});
  let launchError=null;child.on('error',error=>{launchError=error;});
  const endpoint='http://127.0.0.1:'+port;
  for(let attempt=0;attempt<100;attempt++){
    if(launchError)throw Error('Chrome could not start.');
    try{
      const response=await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(1000)});
      if(response.ok)return {process:child,profile,endpoint};
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  child.kill();throw Error('Manual Chrome did not become ready.');
}
function removeOwnedProfile(profile){
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('adr-manual-chrome-'))
    throw Error('Refusing to remove an unexpected profile directory.');
  if(process.platform==='win32'){
    const literal=resolved.replaceAll("'","''");
    const script="$taskProfile = '"+literal+"'; $taskResolved = [IO.Path]::GetFullPath($taskProfile); $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\'); if ([IO.Directory]::GetParent($taskResolved).FullName -ne $taskTempRoot -or [IO.Path]::GetFileName($taskResolved) -notlike 'adr-manual-chrome-*') { throw 'Unexpected temporary profile path.' }; if (Test-Path -LiteralPath $taskResolved) { Remove-Item -LiteralPath $taskResolved -Recurse -Force -ErrorAction Stop }";
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','ignore','pipe'],timeout:20000});
  }else fs.rmSync(resolved,{recursive:true,force:true,maxRetries:4,retryDelay:300});
}
async function closeManual(browser,manual){
  if(browser){
    try{const session=await browser.newBrowserCDPSession();await session.send('Browser.close');}catch{}
    await browser.close().catch(()=>{});
  }
  if(!manual)return;
  manual.process.kill();
  for(let attempt=0;attempt<30;attempt++){
    try{await fetch(manual.endpoint+'/json/version',{signal:AbortSignal.timeout(300)});}
    catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
  for(let attempt=0;attempt<4;attempt++){
    try{removeOwnedProfile(manual.profile);return;}catch{
      if(attempt===3)console.error('Private Chrome temporary profile cleanup needs attention; original verification result preserved.');
      else await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
}
async function sameContextPage(browser,original){
  const opened=original.waitForEvent('popup');opened.catch(()=>{});
  await original.evaluate(()=>{window.open('about:blank','_blank');});
  return opened;
}
module.exports={launchArgs,launchManual,removeOwnedProfile,closeManual,sameContextPage};
