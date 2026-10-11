/* Company dashboards. The backend remains the authority for every permission. */
window.WorkspaceUI=(()=>{
  let viewEpoch=0,coordination=null,mirroredAddress=null,refreshing=false,initialized=false;
  const enabled=()=>!!state.session?.workspaces_enabled;
  const can=cap=>!enabled()||state.session.capabilities?.includes(cap);
  const context=()=>[state.user?.uid,state.session?.company_id,state.session?.role,state.session?.membership_version].join(':');
  const roleName=role=>({owner:'Owner',estimator:'Estimator',office:'Office staff'})[role]||'No company access';
  function formField(form,label,name,value='',type='text'){
    const wrapper=node('label',label),input=node(type==='textarea'?'textarea':'input');input.name=name;
    if(type!=='textarea')input.type=type;input.value=value;input.maxLength=type==='textarea'?1500:500;
    wrapper.append(input);form.append(wrapper);return input;
  }
  function selectField(form,label,name,choices,value){
    const wrapper=node('label',label),select=node('select');select.name=name;
    for(const [key,title] of choices){const option=node('option',title);option.value=key;select.append(option);}select.value=value;
    wrapper.append(select);form.append(wrapper);return select;
  }
  function submit(form,label,action){
    const control=node('button',label,'primary');control.type='submit';form.append(control);
    form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;control.disabled=true;try{await action(new FormData(form));}catch(e){say(e.message,'error');}finally{control.disabled=false;}});
  }
  function show(title,description=''){
    ++viewEpoch;document.body.classList.add('dashboard-open');$('workspaceDashboard').hidden=false;
    $('dashboardHeading').textContent=title;$('dashboardDescription').textContent=description;$('dashboardContent').replaceChildren();
    $('jobCoordination').hidden=true;return viewEpoch;
  }
  function policy(){
    if(!enabled())return;
    const editable=can('scope')&&!!state.draft&&!state.signed&&!confirmedAuthorization;
    $('inspectionFields').disabled=!editable;$('technicianTranscript').readOnly=!editable;
    for(const [id,cap] of [['startWalk','live'],['takePhoto','photos'],['uploadPhoto','photos'],['finishAudit','audit'],['saveDraft','scope'],['fillScope','scope'],['fillScopeProperty','scope'],['authorizeJob','sign']]){
      if(!can(cap))$(id).disabled=true;
    }
    $('signingArea').hidden=!can('sign')||!!state.signed||!!confirmedAuthorization;
    for(const control of $('coordinationForm').querySelectorAll('input,select,textarea,button'))control.disabled=!navigator.onLine||!can('coordination')||(control.id==='coordAddress'&&coordination?.status==='signed');
    for(const control of $('dashboardContent').querySelectorAll('form input,form select,form textarea,form button'))control.disabled=!navigator.onLine;
    $('newInspection').disabled=!can('jobs_create');document.body.classList.toggle('office-view',state.session.role==='office');
  }
  function branding(){
    if(!enabled())return;
    const company=state.session.company,profile=company?.profile;
    const image=document.querySelector('.masthead .brand img'),title=document.querySelector('.masthead .brand strong');
    title.textContent=profile?.name||'Company administration';
    document.body.classList.toggle('company-brand',!!company&&company.company_id!=='adr');
    image.hidden=!profile||(!profile.logo_data_url&&company.company_id!=='adr');
    if(profile){image.src=profile.logo_data_url||'/brand/adr-logo.jpg';image.alt=profile.name;}
    const menu=$('accountMenu').querySelector('.menu-content');
    if(!menu.querySelector('#workspaceAccountDetails')){
      const start=menu.querySelector('hr');let sibling=start?.nextSibling;while(sibling){const next=sibling.nextSibling;sibling.remove();sibling=next;}
      const details=node('div');details.id='workspaceAccountDetails';menu.append(details);
    }
    const details=$('workspaceAccountDetails');details.replaceChildren(node('strong',profile?.name||'Platform administration'),node('p',roleName(state.session.role)));
    if(profile)details.append(node('p',[profile.address,profile.phone,profile.license?'CSLB #'+profile.license:''].filter(Boolean).join(' · ')));
    document.querySelector('footer').textContent=(profile?.name||'Restoration Field Estimator')+' · Private company workspaces';
  }
  async function ready(){
    if(!enabled())return;
    if(!initialized){
      initialized=true;
      for(const [id,fn] of [['dashboardHome',home],['dashboardJobs',jobs],['dashboardTeam',team],['dashboardProfile',profile],['dashboardAdmin',companies]])$(id).addEventListener('click',()=>fn().catch(e=>say(e.message,'error')));
      $('coordinationForm').addEventListener('submit',event=>{event.preventDefault();saveCoordination().catch(e=>say(e.message,'error'));});
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(e=>say(e.message,'error'));});
      window.addEventListener('focus',()=>refresh().catch(e=>say(e.message,'error')));
      window.addEventListener('online',()=>refresh().catch(e=>say(e.message,'error')));
      setInterval(()=>{if(!document.hidden&&navigator.onLine)refresh().catch(e=>say(e.message,'error'));},20000);
    }
    for(const control of $('workspaceNav').querySelectorAll('button'))control.disabled=!!state.workspaceInitializing;
    $('workspaceNav').hidden=false;$('dashboardJobs').hidden=!state.session.role;
    $('dashboardJobs').textContent=state.session.role==='estimator'?'My jobs':'Company jobs';
    $('dashboardTeam').hidden=!can('team_manage');$('dashboardProfile').hidden=!can('profile_manage');$('dashboardAdmin').hidden=!state.session.superadmin;
    branding();policy();
  }
  async function refresh(){
    if(!enabled()||!state.user||!navigator.onLine||refreshing||state.workspaceInitializing)return;
    refreshing=true;const uid=state.user.uid,previous=context();
    try{
      const token=await state.user.getIdToken();const response=await fetch('/api/access',{cache:'no-store',headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw Error('Could not refresh company access. Reconnect before continuing.');
      const access=await response.json();if(state.user?.uid!==uid)return;
      const next=[uid,access.company_id,access.role,access.membership_version].join(':');
      if(previous!==next){
        state.queuePaused=true;clearTimeout(saveTimer);clearTimeout(state.queueRetry);await stopWalk({drain:false});await persist();
        await syncChain.catch(()=>{});for(const url of state.photoUrls.values())URL.revokeObjectURL(url);state.photoUrls.clear();
        state.draft=null;state.record=null;state.signed=null;state.ack=null;confirmedAuthorization=null;invalidate();
        clearDisplayedInspection();
      }
      state.session={...state.session,...access};state.queuePaused=!access.role;await ready();
      if(previous!==next){say('Your company access changed. Local drafts are retained for authorized recovery.');await landing();}
    }finally{refreshing=false;}
  }
  async function home(){
    if(!enabled())return;
    await stopWalk();await persist();const epoch=show(state.session.company?.profile.name||'Welcome','Manage your workspace and continue a saved job.');
    $('dashboardEyebrow').textContent=state.session.superadmin?(state.session.role?'PLATFORM & COMPANY WORKSPACE':'PLATFORM ADMINISTRATION'):roleName(state.session.role).toUpperCase();
    const content=$('dashboardContent'),grid=node('div',undefined,'dashboard-grid');content.append(grid);
    if(state.session.role){
      const card=node('section',undefined,'dashboard-card');card.append(node('h2',state.session.role==='estimator'?'My jobs':'Company jobs'),node('p','Open drafts, review documents and recover signed agreements.'));
      const actions=node('div',undefined,'actions');actions.append(button('Open jobs',jobs));if(can('jobs_create'))actions.append(button('New job',()=>openNew()));card.append(actions);grid.append(card);
    }
    if(can('team_manage')){const card=node('section',undefined,'dashboard-card');card.append(node('h2','Your team'),node('p','Invite estimators and office staff, and manage their access.'),button('Manage team',team));grid.append(card);}
    if(state.session.superadmin){const card=node('section',undefined,'dashboard-card');card.append(node('h2','Companies'),node('p','Create workspaces and manage owners. Customer jobs stay within each company.'),button('Manage companies',companies));grid.append(card);}
    const invitationId=new URL(location.href).searchParams.get('invite');
    let invitations=state.session.invitations||[];
    if(invitationId&&/^[a-f0-9]{32}$/.test(invitationId)&&!invitations.some(i=>i.invitation_id===invitationId))invitations=[{invitation_id:invitationId},...invitations];
    for(const entry of invitations){
      try{
        const invite=await jsonApi('/api/invitations/'+entry.invitation_id);if(epoch!==viewEpoch)return;
        const card=node('section',undefined,'dashboard-card');card.append(node('h2','Join '+invite.company_name),node('p','Invited as '+roleName(invite.role)+' · '+invite.email));
        if(invite.status==='pending'&&invite.expires_at*1000>Date.now())card.append(button('Accept invitation',async()=>{
          await jsonApi('/api/invitations/'+invite.invitation_id+'/accept','POST',{});
          const url=new URL(location.href);url.searchParams.delete('invite');history.replaceState(null,'',url);
          const token=await state.user.getIdToken();const response=await fetch('/api/session',{cache:'no-store',headers:{Authorization:'Bearer '+token}});
          if(!response.ok)throw Error('Invitation accepted. Reload to refresh access.');state.session=await response.json();state.queuePaused=false;await ready();await landing();say('Company invitation accepted.','success');
        }));else card.append(node('p','This invitation is '+invite.status+'. Ask for a new invitation if needed.'));
        grid.append(card);
      }catch(e){if(epoch===viewEpoch)say(e.message,'error');}
    }
    if(!state.session.role&&!state.session.superadmin&&!invitations.length)content.append(node('p','Ask your company owner to invite this Google account.'));
  }
  async function landing(){
    if(['estimator','office'].includes(state.session?.role))await jobs();else await home();
  }
  async function jobs(){
    await stopWalk();await persist();const epoch=show(state.session.role==='estimator'?'My jobs':'Company jobs','Draft inspections and saved agreements.');
    const content=$('dashboardContent');if(can('jobs_create'))content.append(button('New job',()=>openNew()));
    const list=node('div',undefined,'dashboard-list');content.append(list);
    const seen=new Set();
    const append=(records,signed)=>{for(const record of records){if(!signed&&record.status==='signed')continue;const id=signed?record.auth_id:record.inspection_id;if(seen.has(id))continue;seen.add(id);list.append(Object.assign(button((record.address||'Untitled job')+'\n'+(signed?'Signed · '+estimateLabel(record):'Draft · revision '+record.revision),()=>signed?restoreSigned(id):restoreDraft(id)),{className:'job-link'}));}};
    const load=async(path,key,signed,cursor)=>{
      const result=await jsonApi(path+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(epoch!==viewEpoch)return;
      append(result[key],signed);
      if(result.next_cursor){const more=button('Load older '+(signed?'agreements':'drafts'),async()=>{more.disabled=true;try{await load(path,key,signed,result.next_cursor);more.remove();}catch(e){more.disabled=false;throw e;}});list.append(more);}
    };
    if(navigator.onLine){await load('/api/inspections','inspections',false);await load('/api/authorizations','authorizations',true);}
    if(epoch!==viewEpoch)return;
    if(can('scope'))for(const row of await localDrafts())if(!seen.has(row.draft.inspection_id)&&row.record?.status!=='signed')list.append(Object.assign(button((row.draft.data.address||'Local draft')+'\nSaved on this device',()=>restoreDraft(row.draft.inspection_id)),{className:'job-link'}));
    if(!list.childElementCount)list.append(node('p','No jobs saved yet.'));
  }
  function invitationList(container,invitations,companyId){
    const list=node('div',undefined,'dashboard-list');container.append(list);
    if(!invitations.length)list.append(node('p','No invitations yet.'));
    for(const invite of invitations){
      const card=node('section',undefined,'dashboard-card');card.append(node('h3',invite.email),node('p',roleName(invite.role)+' · '+invite.status+' · Email '+invite.delivery_status));
      if(invite.delivery_error)card.append(node('p',invite.delivery_error));
      if(invite.status==='pending')for(const action of ['resend','cancel'])card.append(button(action==='resend'?'Resend invitation':'Cancel invitation',async()=>{const result=await jsonApi('/api/companies/'+companyId+'/invitations/'+invite.invitation_id+'/'+action,'POST',{});say(result.delivery_status==='failed'?result.delivery_error:'Invitation updated.',result.delivery_status==='failed'?'error':'success');await (state.session.role==='owner'&&companyId===state.session.company_id?team():companyAdmin(companyId));}));
      list.append(card);
    }
  }
  function inviteForm(container,companyId,owner=false){
    const form=node('form',undefined,'dashboard-form');form.append(node('h2',owner?'Invite / replace owner':'Invite staff'));
    const email=formField(form,'Google account email','email','','email');email.required=true;
    const select=selectField(form,'Role','role',owner?[['owner','Owner']]:[['estimator','Estimator'],['office','Office staff']],owner?'owner':'estimator');
    if(owner)form.append(node('p','The current owner keeps access until the replacement accepts. Acceptance disables the former owner’s company membership.'));
    submit(form,'Send invitation',async values=>{const invite=await jsonApi('/api/companies/'+companyId+'/invitations','POST',{email:values.get('email'),role:values.get('role')});say(invite.delivery_status==='sent'?'Invitation email sent.':invite.delivery_error||'Invitation delivery is pending.',invite.delivery_status==='failed'?'error':'success');await(owner?companyAdmin(companyId):team());});container.append(form);
  }
  async function team(){
    const cid=state.session.company_id,epoch=show('Team & invitations','Add staff and manage their company access.');
    const [teamData,invites]=await Promise.all([jsonApi('/api/companies/'+cid+'/team'),jsonApi('/api/companies/'+cid+'/invitations')]);if(epoch!==viewEpoch)return;
    const content=$('dashboardContent');inviteForm(content,cid);const grid=node('div',undefined,'dashboard-grid');content.append(grid);
    for(const member of teamData.members){const card=node('section',undefined,'dashboard-card');card.append(node('h3',member.email),node('p',roleName(member.role)+' · '+member.status));
      if(member.role!=='owner'||member.status!=='active'){
        const form=node('form');selectField(form,'Role','role',[['estimator','Estimator'],['office','Office staff']],member.role==='owner'?'estimator':member.role);
        selectField(form,'Access','status',[['active','Active'],['disabled','Disabled']],member.status);
        submit(form,'Save access',async values=>{await jsonApi('/api/companies/'+cid+'/team/'+member.uid,'PUT',{expected_version:member.version,role:values.get('role'),status:values.get('status')});await team();say('Staff access updated.','success');});card.append(form);
      }grid.append(card);
    }content.append(node('h2','Invitations'));invitationList(content,invites.invitations,cid);
  }
  async function profile(){
    const cid=state.session.company_id,epoch=show('Company settings','These details appear on new proposals. Changes require unsigned documents to be regenerated.');
    const company=await jsonApi('/api/companies/'+cid);if(epoch!==viewEpoch)return;
    const form=node('form',undefined,'dashboard-form'),p=company.profile;
    for(const [key,label] of [['name','Company name'],['address','Company address'],['phone','Phone'],['email','Contact email'],['license','CSLB license'],['signoff','Document sign-off']])formField(form,label,key,p[key]||'',key==='email'?'email':'text').required=['name','address','license','signoff'].includes(key);
    if(cid!=='adr')formField(form,'Water-heater coordination notice','water_heater_notice',p.water_heater_notice||'','textarea');
    const logo=formField(form,'Optional logo (PNG or JPEG, up to 1 MB)','logo','','file');logo.accept='image/png,image/jpeg';
    submit(form,'Save company details',async values=>{
      const updated={...p};for(const key of ['name','address','phone','email','license','signoff','water_heater_notice'])if(values.has(key))updated[key]=values.get(key);
      if(logo.files[0]){if(logo.files[0].size>1000000)throw Error('Logo exceeds 1 MB.');updated.logo_data_url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Logo could not be read.'));reader.readAsDataURL(logo.files[0]);});}
      state.session.company=await jsonApi('/api/companies/'+cid,'PUT',{expected_version:company.version,profile:updated});branding();await profile();say('Company details saved. Regenerate unsigned documents before signing.','success');
    });$('dashboardContent').append(form);
  }
  async function companies(){
    const epoch=show('Companies','Manage isolated company workspaces and their owners.');
    const result=await jsonApi('/api/admin/companies');if(epoch!==viewEpoch)return;
    const content=$('dashboardContent'),form=node('form',undefined,'dashboard-form');form.append(node('h2','Create a company'));
    formField(form,'Company name','name').required=true;formField(form,'Owner’s Google email','owner_email','','email').required=true;
    submit(form,'Create & invite owner',async values=>{const result=await jsonApi('/api/admin/companies','POST',{name:values.get('name'),owner_email:values.get('owner_email')});await companyAdmin(result.company.company_id);say(result.invitation.delivery_status==='sent'?'Company created and owner invitation sent.':result.invitation.delivery_error||'Company created; email pending.',result.invitation.delivery_status==='failed'?'error':'success');});content.append(form);
    const grid=node('div',undefined,'dashboard-grid');content.append(grid);
    for(const company of result.companies){const card=node('section',undefined,'dashboard-card');card.append(node('h2',company.profile.name),node('p',company.status+' · '+(company.owner_uid?'Owner assigned':'Owner invitation pending')),button('Manage company',()=>companyAdmin(company.company_id)));grid.append(card);}
  }
  async function companyAdmin(cid){
    const epoch=show('Company administration','Manage ownership and workspace availability.');
    const [company,invites]=await Promise.all([jsonApi('/api/companies/'+cid),jsonApi('/api/companies/'+cid+'/invitations')]);if(epoch!==viewEpoch)return;
    $('dashboardHeading').textContent=company.profile.name;const content=$('dashboardContent');
    content.append(node('p','Company status: '+company.status),button(company.status==='active'?'Suspend company':'Reactivate company',async()=>{await jsonApi('/api/admin/companies/'+cid+'/status','PUT',{expected_version:company.version,status:company.status==='active'?'suspended':'active'});await refresh();await companyAdmin(cid);}));
    if(company.status==='active')inviteForm(content,cid,true);content.append(node('h2','Invitations'));invitationList(content,invites.invitations,cid);
  }
  async function editor(){
    if(!enabled())return;
    ++viewEpoch;document.body.classList.remove('dashboard-open');$('workspaceDashboard').hidden=true;policy();await loadCoordination();
  }
  async function loadCoordination(){
    coordination=null;$('jobCoordination').hidden=true;
    if(!enabled()||!can('coordination')||!state.draft?.inspection_id||!navigator.onLine)return;
    const id=state.draft.inspection_id,key=context();
    const [job,directory]=await Promise.all([jsonApi('/api/jobs/'+id+'/coordination'),jsonApi('/api/companies/'+state.session.company_id+'/team')]);
    if(id!==state.draft?.inspection_id||key!==context())return;
    coordination=job;mirroredAddress=job.address;$('coordAddress').value=job.address;$('coordAddress').disabled=job.status==='signed';
    $('coordName').value=job.customer_name;$('coordPhone').value=job.customer_phone;$('coordEmail').value=job.customer_email;$('coordNotes').value=job.office_notes;
    $('coordEstimator').replaceChildren();const empty=node('option','Unassigned');empty.value='';$('coordEstimator').append(empty);
    for(const member of directory.members.filter(m=>m.role==='estimator'&&m.status==='active')){const option=node('option',member.email);option.value=member.uid;$('coordEstimator').append(option);}
    scopeAddressChanged();$('coordEstimator').value=job.assigned_estimator_uid||'';$('jobCoordination').hidden=false;$('saveCoordination').disabled=false;$('coordinationStatus').textContent='';
  }
  function scopeAddressChanged(){
    if(!coordination||!can('scope')||state.signed||!state.draft||coordination.job_id!==state.draft.inspection_id)return;
    if($('coordAddress').value===mirroredAddress){mirroredAddress=state.draft.data.address;$('coordAddress').value=mirroredAddress;}
  }
  async function saveCoordination(){
    if(!coordination||!$('coordinationForm').reportValidity())return;
    $('saveCoordination').disabled=true;
    try{
      if(can('scope'))await syncDraft();
      const id=state.draft.inspection_id;
      coordination=await jsonApi('/api/jobs/'+id+'/coordination','PUT',{expected_version:coordination.version,address:$('coordAddress').value,assigned_estimator_uid:$('coordEstimator').value||null,customer_name:$('coordName').value,customer_phone:$('coordPhone').value,customer_email:$('coordEmail').value,office_notes:$('coordNotes').value});
      mirroredAddress=coordination.address;
      if(!state.signed){const record=await jsonApi('/api/inspections/'+id);state.draft.data=record.data;state.ack=stable(record.data);absorb(record);fillForm();policy();await persist();}
      $('coordinationStatus').textContent='Coordination saved.';
    }finally{$('saveCoordination').disabled=false;policy();}
  }
  function documentBranding(){
    if(!state.documents)return;
    const identity=state.documents.company_identity;
    const name=identity?.name||'Alert Disaster Restoration',letter=document.querySelector('.document-letterhead');
    document.querySelector('#doc-proposal > h2').textContent=name+(identity&&identity.company_id!=='adr'?' · Official proposal':' · Official ADR Proposal');
    letter.querySelector('p').textContent=identity?[identity.address,identity.phone,identity.license?'CSLB #'+identity.license:'License not provided'].filter(Boolean).join(' · '):'3300 Patton Way · Bakersfield, CA 93308 · (661) 426-2151 · CSLB #950983';
    const image=letter.querySelector('img');image.hidden=!!identity&&!identity.logo_data_url&&identity.company_id!=='adr';image.src=identity?.logo_data_url||'/brand/adr-logo.jpg';image.alt=name;
    document.querySelector('[data-tab=proposal]').textContent=identity?.company_id&&identity.company_id!=='adr'?'Proposal':'ADR proposal';
    policy();
  }
  return {enabled,can,context,ready,home,landing,jobs,editor,policy,refresh,documentBranding,scopeAddressChanged};
})();
