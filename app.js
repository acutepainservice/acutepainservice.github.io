const HARD_CODED_API_URL = 'https://script.google.com/macros/s/AKfycbztZL9dngPMuQxtOcewNcvk138BHA6VrpMNKJh-zZBaFveF-JP6oL0hBgBOHmtXk4bvZg/exec';
const SETTINGS_KEY='apsSettingsV126';
const LEGACY_SETTINGS_KEY='apsSettingsV123';
const DEFAULT_SETTINGS={theme:'system',defaultView:'cards',autoCollapse:false,sessionTimeout:8};
function loadSettings(){
  try{
    const saved=localStorage.getItem(SETTINGS_KEY);
    if(saved)return {...DEFAULT_SETTINGS,...JSON.parse(saved)};
    const legacy=JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY)||'{}');
    const migrated={...DEFAULT_SETTINGS,...legacy,defaultView:'cards',autoCollapse:false};
    localStorage.setItem(SETTINGS_KEY,JSON.stringify(migrated));
    return migrated;
  }catch(e){return {...DEFAULT_SETTINGS}}
}
const S={
  apiUrl:HARD_CODED_API_URL,
  token:sessionStorage.getItem('apsToken')||'',
  today:[],current:null,roundFilter:'all',modalityFilter:'',docUrl:'',
  settings:loadSettings(),viewMode:sessionStorage.getItem('apsCurrentViewModeV126')||loadSettings().defaultView,
  scrollPositions:JSON.parse(sessionStorage.getItem('apsScrollPositions')||'{}'),
  wardOpen:JSON.parse(sessionStorage.getItem('apsWardOpen')||'{}'),
  patientOriginal:null,editOriginal:null,allowPop:false,retryFn:null,
  favorites:JSON.parse(localStorage.getItem('apsMedFavorites')||'[]'),
  recentMeds:JSON.parse(localStorage.getItem('apsRecentMeds')||'[]'),
  lastActivity:+(sessionStorage.getItem('apsLastActivity')||Date.now()),lastLoad:0,
  medications:[],medsLoaded:false,medsLoading:false,medSearchIndex:[],medVisibleLimit:30
};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function natural(a,b){return String(a||'').localeCompare(String(b||''),undefined,{numeric:true,sensitivity:'base'})}
function localDateKey(){try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}catch(e){return new Date().toLocaleDateString('en-CA')}}
function patientSort(a,b){return natural(a.Ward,b.Ward)||natural(a.Name,b.Name)||natural(a.RN,b.RN)}
function isActive(p){const s=String(p.Status||p._status||'').trim().toLowerCase();return s==='new patient'||s==='continue review'}
function isDischarged(p){return String(p.Status||p._status||'').trim().toLowerCase()==='discharged'}
function searchable(p){return ['Name','RN','Age','Sex','Race','Ward','Diagnosis','Operation','Mode','Date Commenced',"Doctor's name",'Remark','Status'].map(k=>p[k]||'').join(' ').toLowerCase()}
function toast(msg,type='',duration=1800){const t=$('#toast');t.textContent=msg;t.className='toast show '+type;clearTimeout(toast.t);toast.t=setTimeout(()=>t.className='toast',duration)}
function setConnection(online){const b=$('#connectionBadge');if(!b)return;const ok=online!==false;b.textContent=ok?'● Online':'○ Offline';b.className='connection-badge '+(ok?'online':'offline');$('#offlineBanner')?.classList.toggle('hidden',ok)}
function touchActivity(){S.lastActivity=Date.now();sessionStorage.setItem('apsLastActivity',String(S.lastActivity))}
function saveSettings(){localStorage.setItem(SETTINGS_KEY,JSON.stringify(S.settings))}
function applyTheme(){let t=S.settings.theme;if(t==='system')t=window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}
function saveScroll(view=currentViewName()){S.scrollPositions[view]=window.scrollY;sessionStorage.setItem('apsScrollPositions',JSON.stringify(S.scrollPositions))}
function restoreScroll(view){requestAnimationFrame(()=>window.scrollTo({top:S.scrollPositions[view]||0,behavior:'instant'}))}
function saveWardState(){sessionStorage.setItem('apsWardOpen',JSON.stringify(S.wardOpen))}
const TODAY_SESSION_CACHE='apsTodayCacheV130';
function cacheTodaySession(){
  try{
    if(!S.today?.length)return;
    sessionStorage.setItem(TODAY_SESSION_CACHE,JSON.stringify({
      date:localDateKey(),patients:S.today,docUrl:S.docUrl,lastLoad:S.lastLoad
    }));
  }catch(e){}
}
function hydrateTodaySession(){
  try{
    const x=JSON.parse(sessionStorage.getItem(TODAY_SESSION_CACHE)||'null');
    if(!x||x.date!==localDateKey()||!Array.isArray(x.patients)||!x.patients.length)return false;
    S.today=x.patients.sort(patientSort);S.docUrl=x.docUrl||'';S.lastLoad=+x.lastLoad||0;
    $('#openDocBtn').disabled=!S.docUrl;
    $('#updatedAt').textContent='Cached '+new Date(S.lastLoad||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    $('#todayDate').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    populateModalityFilter();renderToday();return true;
  }catch(e){return false}
}
function updateLocalPatient(patient){
  if(!patient||!patient._key)return;
  const i=S.today.findIndex(p=>p._key===patient._key);
  if(i>=0)S.today[i]={...S.today[i],...patient};
  else S.today.push(patient);
  S.today.sort(patientSort);cacheTodaySession();populateModalityFilter();renderToday();
}
function showSaveError(msg,retry){S.retryFn=retry||null;$('#saveErrorText').textContent=msg||'Not saved — connection problem';$('#saveError').classList.remove('hidden')}
function hideSaveError(){$('#saveError').classList.add('hidden');S.retryFn=null}

async function api(action,data={}){
  if(!S.apiUrl)throw new Error('Apps Script URL is not configured.');
  if(!navigator.onLine){setConnection(false);throw new Error('No internet connection. Changes cannot currently be saved.');}
  let res;
  try{res=await fetch(S.apiUrl,{method:'POST',redirect:'follow',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,token:S.token,...data})});setConnection(true)}
  catch(e){setConnection(false);throw new Error('Could not reach the APS backend. Check your internet connection and try again.');}
  let out;try{out=await res.json()}catch(e){throw new Error('The APS backend returned an unreadable response.');}
  if(!out.ok){if(/session expired/i.test(out.error||''))lockApp();throw new Error(out.error||'APS backend error');}
  touchActivity();return out;
}
function lockApp(){S.token='';sessionStorage.removeItem('apsToken');sessionStorage.removeItem(TODAY_SESSION_CACHE);$('#gate').classList.remove('hidden');$('#passwordInput').value='';setConnection(false)}
async function login(){const password=$('#passwordInput').value;if(!password){toast('Enter the APS password');return}$('#loginBtn').disabled=true;try{const out=await fetch(S.apiUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'login',password})}).then(r=>r.json());if(!out.ok)throw new Error(out.error||'Incorrect password');S.token=out.token;sessionStorage.setItem('apsToken',S.token);touchActivity();$('#gate').classList.add('hidden');setConnection(true);await loadToday();}catch(e){toast(e.message,'error')}finally{$('#loginBtn').disabled=false}}

function currentViewName(){const v=document.querySelector('.view.active');return v?v.id.replace(/^view/,''):'Today'}
function routeHash(name){return '#'+String(name||'Today').toLowerCase()}
function showView(name,{push=true,restore=true,refresh=false}={}){
  const target=$('#view'+name);if(!target)return;
  const previous=currentViewName();if(previous!==name)saveScroll(previous);
  $$('.view').forEach(v=>v.classList.remove('active'));target.classList.add('active');
  $$('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $('#appTitle').textContent=name==='Today'?'APS Rounds':name;
  if(name==='Meds')ensureMedsLoaded().then(()=>renderMeds()).catch(e=>{$('#medList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'});
  if(push&&(previous!==name||history.state?.type!=='view'))history.pushState({aps:true,type:'view',view:name},'',routeHash(name));
  if(restore)restoreScroll(name);
}
function replaceOverlayWithViewState(){const st=history.state;if(st?.aps&&['patient','patientEdit','scale','settings'].includes(st.type)){const view=st.view||currentViewName();history.replaceState({aps:true,type:'view',view},'',routeHash(view));}}
function closeScaleViaHistory(){if(history.state?.aps&&history.state.type==='scale')history.back();else $('#scaleScreen').classList.remove('open')}
function closeSettingsViaHistory(){if(history.state?.aps&&history.state.type==='settings')history.back();else if($('#settingsDialog').open)$('#settingsDialog').close()}
function openSettings(push=true){syncSettingsUI();if(!$('#settingsDialog').open)$('#settingsDialog').showModal();if(push)history.pushState({aps:true,type:'settings',view:currentViewName()},'','#settings')}

function askConfirm({title='Confirm',message='',ok='Confirm',cancel='Cancel',danger=false}={}){return new Promise(resolve=>{const d=$('#confirmDialog');$('#confirmTitle').textContent=title;$('#confirmMessage').textContent=message;$('#confirmOk').textContent=ok;$('#confirmCancel').textContent=cancel;$('#confirmOk').className='btn '+(danger?'danger':'');let settled=false;const done=v=>{if(settled)return;settled=true;d.close();resolve(v)};$('#confirmOk').onclick=()=>done(true);$('#confirmCancel').onclick=()=>done(false);d.oncancel=e=>{e.preventDefault();done(false)};d.showModal()})}
function patientDirty(){if(!S.current||!S.patientOriginal)return false;const status=$('input[name="detailStatus"]:checked')?.value||'Continue review';return $('#detailRemark').value!==S.patientOriginal.remark||status!==S.patientOriginal.status}
function patientEditMode(){return !$('#editPatientForm').classList.contains('hidden')}
function normalizedEditData(){
  const race=$('#editRace').value==='__other__'?$('#editRaceOther').value.trim():$('#editRace').value.trim();
  const ward=$('#editWard').value==='__other__'?$('#editWardOther').value.trim():$('#editWard').value.trim();
  const mode=$('#editMode').value==='__other__'?$('#editModeOther').value.trim():$('#editMode').value.trim();
  return {
    name:$('#editName').value.trim(),rn:$('#editRn').value.trim(),age:$('#editAge').value.trim(),
    sex:$('#editSex').value.trim(),race,ward,diagnosis:$('#editDiagnosis').value.trim(),
    operation:$('#editOperation').value.trim(),mode,dateCommenced:$('#editDateCommenced').value,
    doctorName:$('#editDoctorName').value.trim()
  };
}
function patientEditDirty(){return !!(patientEditMode()&&S.editOriginal&&JSON.stringify(normalizedEditData())!==JSON.stringify(S.editOriginal))}
async function confirmDiscardIfDirty(){
  if(patientEditDirty())return await askConfirm({title:'Unsaved changes',message:'Discard the unsaved patient-detail changes?',ok:'Discard',cancel:'Keep editing',danger:true});
  if(patientDirty())return await askConfirm({title:'Unsaved changes',message:'Discard the unsaved changes to this patient?',ok:'Discard',cancel:'Keep editing',danger:true});
  return true;
}
function showPatientDetailMode(){
  $('#editPatientForm').classList.add('hidden');$('#patientDetailView').classList.remove('hidden');
  $('#patientDialogTitle').textContent='Patient';$('#detailRoundChip').classList.remove('hidden');S.editOriginal=null;
}
async function cancelPatientEditViaHistory(){
  if(!await confirmDiscardIfDirty())return;
  S.editOriginal=null;
  if(history.state?.aps&&history.state.type==='patientEdit')history.back();else showPatientDetailMode();
}
async function closePatientViaHistory(){
  if(patientEditMode())return cancelPatientEditViaHistory();
  if(!await confirmDiscardIfDirty())return;S.patientOriginal=null;S.editOriginal=null;
  if(history.state?.aps&&history.state.type==='patient')history.back();else if($('#patientDialog').open)$('#patientDialog').close()
}

async function loadToday({preserveScroll=false,force=false,background=false}={}){
  if(!S.token)return;
  const y=window.scrollY;
  if(!S.today.length&&!background)$('#todayContent').innerHTML='<div class="empty">Loading APS round…</div>';
  try{
    const out=await api('today',{bypassCache:!!force});
    S.today=(out.patients||[]).sort(patientSort);S.docUrl=out.googleDocUrl||'';
    $('#openDocBtn').disabled=!S.docUrl;S.lastLoad=Date.now();
    $('#updatedAt').textContent='Updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+(out.cached?' · cached':'');
    $('#todayDate').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    populateModalityFilter();renderToday();cacheTodaySession();
    if(preserveScroll)requestAnimationFrame(()=>window.scrollTo({top:y,behavior:'instant'}));
  }catch(e){
    if(!S.today.length)$('#todayContent').innerHTML='<div class="empty">'+esc(e.message)+'</div>';
    if(!background)toast(e.message,'error',2600);
  }
}
function populateModalityFilter(){const sel=$('#modalityFilter');const current=S.modalityFilter;const modes=[...new Set(S.today.filter(isActive).map(p=>String(p.Mode||'').trim()).filter(Boolean))].sort(natural);sel.innerHTML='<option value="">All modalities</option>'+modes.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');if(modes.includes(current))sel.value=current;else S.modalityFilter=''}
function dischargedToday(p){return !!p._dischargedToday||(p._roundCompleted&&String(p._roundOutcome||'').trim().toLowerCase()==='discharged')}
function filteredToday({ignoreRound=false}={}){const q=$('#todaySearch').value.trim().toLowerCase();return S.today.filter(p=>{if(q&&!searchable(p).includes(q))return false;if(S.modalityFilter&&String(p.Mode||'')!==S.modalityFilter)return false;if(!ignoreRound){if(S.roundFilter==='active'&&!isActive(p))return false;if(S.roundFilter==='pending'&&p._roundCompleted)return false;if(S.roundFilter==='done'&&!p._roundCompleted)return false;if(S.roundFilter==='discharged'&&!dischargedToday(p))return false;}return true;}).sort(patientSort)}
function renderToday(){const total=S.today.length,done=S.today.filter(p=>p._roundCompleted).length,pending=total-done,active=S.today.filter(isActive).length,discharged=S.today.filter(dischargedToday).length,pct=total?Math.round(done/total*100):0;$('#progDone').textContent=done;$('#statActive').textContent=active;$('#statPending').textContent=pending;$('#progressFill').style.width=pct+'%';$('#progressPct').textContent=pct+'%';$('#progressText').textContent=`${done} of ${total} completed`;const labels={all:'All',active:`Active ${active}`,pending:`Pending ${pending}`,done:`Done ${done}`,discharged:`Discharged today ${discharged}`};$$('#roundFilterSeg button').forEach(b=>{b.textContent=labels[b.dataset.filter]||b.textContent;b.classList.toggle('active',b.dataset.filter===S.roundFilter)});$$('#viewModeSeg button').forEach(b=>b.classList.toggle('active',b.dataset.mode===S.viewMode));const patients=filteredToday();if(S.viewMode==='cards')renderCards($('#todayContent'),patients,true);else if(S.viewMode==='list')renderList($('#todayContent'),patients,true);else renderCensus($('#todayContent'),patients)}
function wardGroups(patients){const map={};patients.forEach(p=>{const w=(p.Ward||'Unspecified').trim()||'Unspecified';(map[w]??=[]).push(p)});return Object.entries(map).sort((a,b)=>natural(a[0],b[0]))}
function statusChip(p){const st=String(p.Status||p._status||'').trim().toLowerCase();if(st==='discharged')return '<span class="chip danger">Discharged</span>';if(st==='new patient')return '<span class="chip warn">New patient</span>';return '<span class="chip good">Continue review</span>'}
function roundChip(p){return p._roundCompleted?'<span class="chip good">✓ Done</span>':'<span class="chip warn">● Pending</span>'}
function conciseStatus(p){const st=String(p.Status||p._status||'').trim().toLowerCase();if(st==='discharged')return 'Discharged';if(st==='continue review')return "Cont'";if(st==='new patient')return 'New';return p.Status||''}
function cardStatusText(p){const st=String(p.Status||p._status||'').trim().toLowerCase();if(st==='discharged')return 'Discharge';if(st==='continue review')return 'Continue Review';if(st==='new patient')return 'New Patient';return p.Status||''}
function listRoundState(p){if(p._roundCompleted)return `<span class="list-review-state done"><span class="tick">✓</span><span class="review-status">${esc(conciseStatus(p))}</span></span>`;return '<span class="list-review-state pending">Pending</span>'}
function cardRoundState(p){const first=p._roundCompleted?'<span class="round-line done">✓ Done</span>':'<span class="round-line pending">Pending</span>';return `<div class="card-round-state">${first}<span class="status-line">${esc(cardStatusText(p))}</span></div>`}
function wardOpenDefault(ward,ps,mode){const key=mode+'|'+ward;const pending=ps.filter(p=>!p._roundCompleted).length;if(pending)return true;if(S.wardOpen[key]!==undefined)return !!S.wardOpen[key];return !S.settings.autoCollapse}
function wardShell(ward,ps,mode,inner){const pending=ps.filter(p=>!p._roundCompleted).length,completed=ps.length-pending,open=wardOpenDefault(ward,ps,mode);return `<details class="patient-ward-group ward-details ${mode==='cards'?'cards-group':''}" data-ward="${esc(ward)}" data-mode="${mode}" ${open?'open':''}><summary class="patient-ward-head"><span class="ward-chevron">▶</span><span class="ward-dot"></span><h3>${esc(ward)}</h3><div class="ward-summary-meta"><b>${ps.length} patients</b><span>${pending} pending · ${completed} completed</span></div></summary><div class="patient-ward-stack">${inner}</div></details>`}
function cardHtml(p,round){return `<div class="card patient-card" data-key="${esc(p._key)}"><div class="patient-top"><div><div class="patient-name">${esc(p.Name)}</div><div class="patient-meta">RN ${esc(p.RN||'—')} · ${esc(p.Age||'—')} ${esc(p.Sex||'')}</div></div>${round?cardRoundState(p):`<div class="chips">${statusChip(p)}</div>`}</div><div class="chips">${p.Mode?`<span class="chip">${esc(p.Mode)}</span>`:''}${p['Date Commenced']?`<span class="chip">${esc(p['Date Commenced'])}</span>`:''}</div>${p.Operation?`<div class="patient-meta"><b>Operation:</b> ${esc(p.Operation)}</div>`:''}${p.Remark?`<div class="remark">${esc(p.Remark)}</div>`:'<div class="remark muted">No remark</div>'}<div class="card-quick-actions"><button class="btn secondary remark-action" data-action="remark" data-key="${esc(p._key)}">Add/Edit Remark</button>${isDischarged(p)?`<button class="btn cancel-mini" data-action="cancel" data-key="${esc(p._key)}">Cancel discharge</button>`:`<button class="btn secondary" data-action="continue" data-key="${esc(p._key)}">Continue Review</button><button class="btn discharge-mini" data-action="discharge" data-key="${esc(p._key)}">Discharge</button>`}</div></div>`}
function bindWardDetails(el){el.querySelectorAll('.ward-details').forEach(d=>d.addEventListener('toggle',()=>{S.wardOpen[d.dataset.mode+'|'+d.dataset.ward]=d.open;saveWardState()}))}
function bindPatientClicks(el){el.querySelectorAll('[data-key].patient-card,[data-key].compact-row').forEach(n=>n.addEventListener('click',e=>{if(e.target.closest('button'))return;openPatient(n.dataset.key)}));el.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const a=b.dataset.action,k=b.dataset.key;if(a==='remark')openPatient(k);else if(a==='continue')directStatusAction(k,'Continue review');else if(a==='discharge')directStatusAction(k,'Discharged');else if(a==='cancel')directCancelDischarge(k)}))}
function renderCards(el,patients,round){if(!patients.length){el.innerHTML='<div class="empty">No matching patients.</div>';return}el.innerHTML=wardGroups(patients).map(([w,ps])=>wardShell(w,ps,'cards',ps.map(p=>`<div class="patient-node">${cardHtml(p,round)}</div>`).join(''))).join('');bindWardDetails(el);bindPatientClicks(el)}
function renderList(el,patients,round){if(!patients.length){el.innerHTML='<div class="empty">No matching patients.</div>';return}el.innerHTML=wardGroups(patients).map(([w,ps])=>wardShell(w,ps,'list',ps.map(p=>`<div class="patient-node"><div class="compact-row" data-key="${esc(p._key)}"><div>${p['Date Commenced']?`<div class="list-date-commenced">${esc(p['Date Commenced'])}</div>`:''}<div class="n">${esc(p.Name)}</div><div class="m">RN ${esc(p.RN||'—')} · ${esc(p.Mode||'—')}${p.Remark?' · '+esc(p.Remark):''}</div></div><div>${round?listRoundState(p):statusChip(p)}</div></div></div>`).join(''))).join('');bindWardDetails(el);bindPatientClicks(el)}
function renderCensus(el,patients){const active=patients.filter(isActive);const modeMap={},wardMap={};active.forEach(p=>{const mode=(p.Mode||'Unspecified').trim()||'Unspecified';modeMap[mode]=(modeMap[mode]||0)+1;const w=(p.Ward||'Unspecified').trim()||'Unspecified';wardMap[w]??={total:0,newP:0,continueP:0};wardMap[w].total++;if(String(p.Status||'').toLowerCase()==='new patient')wardMap[w].newP++;else wardMap[w].continueP++});const modes=Object.entries(modeMap).sort((a,b)=>b[1]-a[1]||natural(a[0],b[0])),max=Math.max(1,...modes.map(x=>x[1]));const wards=Object.entries(wardMap).sort((a,b)=>natural(a[0],b[0]));el.innerHTML=`<div class="census-title">DAILY MODE BREAKDOWN & ACTIVE PATIENTS BY WARD</div><div class="census-grid"><div class="card census-panel"><h3>Daily mode breakdown</h3>${modes.length?modes.map(([m,n])=>`<div class="mode-row"><span class="label">${esc(m)}</span><span class="mode-bar"><i style="width:${Math.round(n/max*100)}%"></i></span><b>${n}</b></div>`).join(''):'<div class="empty">No active patients</div>'}</div><div class="card census-panel"><h3>Active patients by ward</h3>${wards.length?wards.map(([w,x])=>`<div class="ward-census-row"><div><strong>${esc(w)}</strong><span>${x.newP} new · ${x.continueP} continue</span></div><span class="ward-census-count">${x.total}</span></div>`).join(''):'<div class="empty">No active patients</div>'}</div></div>`}

function patientSequence(){return filteredToday().slice().sort(patientSort)}
function renderPatientDetailGrid(p){
  const fields=[['Race',p.Race],['Diagnosis',p.Diagnosis],['Operation',p.Operation],['Mode',p.Mode],['Date commenced',p['Date Commenced']],["Doctor's name",p["Doctor's name"]]];
  $('#detailGrid').innerHTML=fields.filter(([,v])=>v).map(([k,v])=>`<div class="detail-line"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')||'<div class="muted small">Loading additional registration details…</div>';
}
function populatePatientDialog(p){
  $('#detailName').textContent=String(p.Name||'').toUpperCase();
  $('#detailMeta').textContent=`${p.Ward||'Ward —'} · RN ${p.RN||'—'} · ${p.Age||'—'} ${p.Sex||''}`;
  $('#detailRoundChip').textContent=p._roundCompleted?'✓ Done':'Pending';
  $('#detailRoundChip').className='chip '+(p._roundCompleted?'good':'warn');
  renderPatientDetailGrid(p);
  $('#detailRemark').value=p.Remark||'';
  const val=isDischarged(p)?'Discharged':'Continue review';
  document.querySelector(`input[name="detailStatus"][value="${val}"]`).checked=true;
  $('#cancelDischargeBtn').classList.toggle('hidden',!isDischarged(p));
  S.patientOriginal={remark:p.Remark||'',status:val};updatePatientPager();
}
async function loadPatientDetail(key){
  const p=S.today.find(x=>x._key===key);if(!p)return null;if(p._detailLoaded)return p;
  try{
    const out=await api('patientDetail',{recordKey:key});
    const detail=out.patient||{};const current=S.today.find(x=>x._key===key);
    if(current){Object.assign(current,detail,{_detailLoaded:true});cacheTodaySession();}
    if(S.current?._key===key){
      S.current=current||detail;
      $('#detailName').textContent=String(S.current.Name||'').toUpperCase();
      $('#detailMeta').textContent=`${S.current.Ward||'Ward —'} · RN ${S.current.RN||'—'} · ${S.current.Age||'—'} ${S.current.Sex||''}`;
      renderPatientDetailGrid(S.current);
    }
    return current||detail;
  }catch(e){toast(e.message||'Could not load patient details','error',2200);return null}
}
function openPatient(key,push=true){
  const p=S.today.find(x=>x._key===key);if(!p)return;
  S.current=p;showPatientDetailMode();populatePatientDialog(p);
  if(!$('#patientDialog').open)$('#patientDialog').showModal();
  if(push)history.pushState({aps:true,type:'patient',view:currentViewName(),key},'','#patient');
  loadPatientDetail(key);
}

function cloneEditSelectOptions(){
  const copy=(from,to)=>{
    const src=$('#'+from),dst=$('#'+to);if(!src||!dst)return;
    dst.innerHTML=[...src.options].map(o=>`<option value="${esc(o.value)}"${o.disabled?' disabled':''}>${esc(o.textContent)}</option>`).join('');
  };
  copy('raceSelect','editRace');copy('wardSelect','editWard');copy('modeSelect','editMode');
}
function setEditSelect(selectId,otherId,value){
  const sel=$('#'+selectId),other=$('#'+otherId),v=String(value||'').trim();
  const option=[...sel.options].find(o=>String(o.value).toLowerCase()===v.toLowerCase()&&o.value!=='__other__');
  if(option){sel.value=option.value;other.value='';other.classList.add('hidden');other.required=false}
  else{sel.value='__other__';other.value=v;other.classList.remove('hidden');other.required=true}
}
function editSelectOtherSync(selectId,otherId){
  const sel=$('#'+selectId),other=$('#'+otherId);
  const sync=()=>{const on=sel.value==='__other__';other.classList.toggle('hidden',!on);other.required=on;if(!on)other.value=''};
  sel.addEventListener('change',sync);
}
function dateInputValue(value){
  const s=String(value||'').trim();if(!s)return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  let m=s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
  if(m){const mo=months[m[2].slice(0,3).toLowerCase()];if(mo)return `${m[3]}-${String(mo).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`}
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m){let a=+m[1],b=+m[2];let day,mo;if(a>12){day=a;mo=b}else{mo=a;day=b}return `${m[3]}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
  const d=new Date(s);if(!isNaN(d.getTime()))return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return '';
}
function populatePatientEditForm(p){
  $('#editName').value=p.Name||'';$('#editRn').value=p.RN||'';$('#editAge').value=p.Age||'';
  const sex=String(p.Sex||'').toLowerCase();$('#editSex').value=sex==='female'?'Female':'Male';
  setEditSelect('editRace','editRaceOther',p.Race||'');
  setEditSelect('editWard','editWardOther',p.Ward||'');
  $('#editDiagnosis').value=p.Diagnosis||'';$('#editOperation').value=p.Operation||'';
  setEditSelect('editMode','editModeOther',p.Mode||'');
  $('#editDateCommenced').value=dateInputValue(p['Date Commenced']);
  $('#editDoctorName').value=p["Doctor's name"]||'';
  S.editOriginal=normalizedEditData();
}
async function openPatientEdit(push=true){
  if(!S.current)return;
  const p=await loadPatientDetail(S.current._key);if(!p)return;
  S.current=S.today.find(x=>x._key===S.current._key)||p;
  populatePatientEditForm(S.current);
  $('#patientDetailView').classList.add('hidden');$('#editPatientForm').classList.remove('hidden');
  $('#patientDialogTitle').textContent='Edit patient';$('#detailRoundChip').classList.add('hidden');
  if(push)history.pushState({aps:true,type:'patientEdit',view:currentViewName(),key:S.current._key},'','#patient-edit');
}
function identityChangeMessage(oldP,data){
  const changes=[];
  if(String(oldP.Name||'').trim()!==data.name)changes.push(`Name: ${oldP.Name||'—'} → ${data.name}`);
  if(String(oldP.RN||'').trim()!==data.rn)changes.push(`RN: ${oldP.RN||'—'} → ${data.rn}`);
  return changes.join(' · ');
}
async function savePatientDetails(ev,{confirmDuplicate=false,identityConfirmed=false}={}){
  ev?.preventDefault();if(!S.current)return;
  const data=normalizedEditData();
  if(!data.name||!data.rn||!data.age||!data.sex||!data.race||!data.ward||!data.diagnosis||!data.mode||!data.dateCommenced||!data.doctorName){
    toast('Complete all required patient details.','error',2000);return;
  }
  const old={...S.current};const identityMsg=identityChangeMessage(old,data);
  if(identityMsg&&!identityConfirmed){
    const ok=await askConfirm({title:'Change patient identification?',message:`${identityMsg}. The existing APS ID and round record will remain unchanged.`,ok:'Save identity change',cancel:'Cancel'});
    if(!ok)return;
    identityConfirmed=true;
  }
  const btn=$('#savePatientEditBtn');btn.disabled=true;btn.textContent='Saving…';
  try{
    hideSaveError();
    const out=await api('editPatientDetails',{recordKey:S.current._key,patient:data,confirmDuplicate});
    if(out.requiresDuplicateConfirmation){
      btn.disabled=false;btn.textContent='Save changes';
      const d=(out.duplicates||[]).map(x=>`${x.name||'Patient'} (${x.ward||'ward unknown'})`).join(', ');
      const ok=await askConfirm({title:'RN already active in APS',message:`Another active APS patient has RN ${data.rn}${d?' — '+d:''}. Save this RN anyway?`,ok:'Save anyway',cancel:'Cancel',danger:true});
      if(ok)return savePatientDetails(null,{confirmDuplicate:true,identityConfirmed:true});
      return;
    }
    if(out.patient)updateLocalPatient(out.patient);
    S.current=S.today.find(p=>p._key===old._key)||out.patient||S.current;
    S.editOriginal=null;
    toast('✓ Patient details updated','success',1300);
    if(history.state?.aps&&history.state.type==='patientEdit')history.back();else{showPatientDetailMode();populatePatientDialog(S.current)}
  }catch(e){showSaveError('Details not saved — '+e.message,()=>savePatientDetails(null,{confirmDuplicate,identityConfirmed:true}))}
  finally{btn.disabled=false;btn.textContent='Save changes'}
}
function updatePatientPager(){const seq=patientSequence(),idx=seq.findIndex(p=>p._key===S.current?._key);$('#patientPosition').textContent=idx>=0?`${idx+1} of ${seq.length}`:'—';$('#prevPatientBtn').disabled=seq.length<2;$('#nextPatientBtn').disabled=seq.length<2}
async function movePatient(delta){if(!await confirmDiscardIfDirty())return;const seq=patientSequence(),idx=seq.findIndex(p=>p._key===S.current?._key);if(idx<0||!seq.length)return;const next=seq[(idx+delta+seq.length)%seq.length];S.patientOriginal=null;openPatient(next._key,false);history.replaceState({aps:true,type:'patient',view:currentViewName(),key:next._key},'','#patient')}
async function directStatusAction(key,status){
  const p=S.today.find(x=>x._key===key);if(!p)return;
  const discharge=status==='Discharged';
  const ok=await askConfirm({
    title:discharge?'Discharge from APS?':'Continue APS review?',
    message:discharge?`${p.Name} will be marked Discharged and will be removed from the next day's active APS round list.`:`${p.Name} will remain under APS and today's round will be marked completed.`,
    ok:discharge?'Discharge':'Continue review',danger:discharge
  });if(!ok)return;
  const retry=()=>directStatusAction(key,status);
  try{
    hideSaveError();const out=await api('savePatient',{recordKey:key,remark:p.Remark||'',status});
    updateLocalPatient(out.patient||{...p,Status:status,_status:status,_roundCompleted:true,_roundOutcome:status,_dischargedToday:discharge});
    toast('✓ Saved','success',1200);
  }catch(e){showSaveError('Not saved — '+e.message,retry)}
}
async function directCancelDischarge(key){
  const p=S.today.find(x=>x._key===key);if(!p)return;
  const ok=await askConfirm({title:'Cancel discharge?',message:`Return ${p.Name} to Continue review and keep the patient on the active APS list?`,ok:'Cancel discharge'});
  if(!ok)return;const retry=()=>directCancelDischarge(key);
  try{
    hideSaveError();const out=await api('savePatient',{recordKey:key,remark:p.Remark||'',status:'Continue review'});
    updateLocalPatient(out.patient||{...p,Status:'Continue review',_status:'Continue review',_roundCompleted:true,_roundOutcome:'Continue review',_dischargedToday:false});
    toast('✓ Discharge cancelled','success',1200);
  }catch(e){showSaveError('Not saved — '+e.message,retry)}
}
async function saveCurrent(goNext){
  if(!S.current)return;
  const status=$('input[name="detailStatus"]:checked')?.value||'Continue review';
  if(status==='Discharged'&&!isDischarged(S.current)){
    const ok=await askConfirm({title:'Discharge from APS?',message:`${S.current.Name} will be marked Discharged and removed from the next day's active APS round list.`,ok:'Discharge',danger:true});if(!ok)return
  }
  const oldKey=S.current._key,retry=()=>saveCurrent(goNext);
  const seq=patientSequence(),idx=seq.findIndex(p=>p._key===oldKey),nextKey=goNext&&seq.length>1?seq[(idx+1)%seq.length]._key:null;
  $('#savePatientBtn').disabled=$('#saveNextBtn').disabled=$('#cancelDischargeBtn').disabled=true;
  try{
    hideSaveError();const out=await api('savePatient',{recordKey:oldKey,remark:$('#detailRemark').value,status});
    updateLocalPatient(out.patient||{...S.current,Remark:$('#detailRemark').value,Status:status,_status:status,_roundCompleted:status!=='New patient',_roundOutcome:status==='New patient'?'':status,_dischargedToday:status==='Discharged'});
    S.current=S.today.find(p=>p._key===oldKey)||S.current;
    S.patientOriginal={remark:S.current.Remark||'',status:isDischarged(S.current)?'Discharged':'Continue review'};
    toast('✓ Saved','success',1100);
    if(!goNext){
      replaceOverlayWithViewState();$('#patientDialog').close();S.patientOriginal=null;
    }else if(nextKey&&S.today.some(p=>p._key===nextKey)){
      openPatient(nextKey,false);history.replaceState({aps:true,type:'patient',view:currentViewName(),key:nextKey},'','#patient');
    }else{
      replaceOverlayWithViewState();$('#patientDialog').close();S.patientOriginal=null;
    }
  }catch(e){showSaveError('Not saved — '+e.message,retry)}
  finally{$('#savePatientBtn').disabled=$('#saveNextBtn').disabled=$('#cancelDischargeBtn').disabled=false}
}
async function cancelDischarge(){
  if(!S.current||!isDischarged(S.current))return;
  const ok=await askConfirm({title:'Cancel discharge?',message:`Return ${S.current.Name} to Continue review and keep the patient on the active APS list?`,ok:'Cancel discharge'});if(!ok)return;
  try{
    const out=await api('savePatient',{recordKey:S.current._key,remark:$('#detailRemark').value,status:'Continue review'});
    updateLocalPatient(out.patient||{...S.current,Status:'Continue review',_status:'Continue review',_roundCompleted:true,_roundOutcome:'Continue review',_dischargedToday:false});
    toast('✓ Discharge cancelled','success',1200);replaceOverlayWithViewState();$('#patientDialog').close();S.patientOriginal=null;
  }catch(e){showSaveError('Not saved — '+e.message,()=>cancelDischarge())}
}

async function registerPatient(ev){
  ev.preventDefault();const f=new FormData(ev.target),patient=Object.fromEntries(f.entries());
  if(patient.race==='__other__')patient.race=$('#raceOther').value.trim();
  if(patient.ward==='__other__')patient.ward=$('#wardOther').value.trim();
  if(patient.mode==='__other__')patient.mode=$('#modeOther').value.trim();
  if(!patient.race||!patient.ward||!patient.mode){toast('Complete all required fields, including any Other value.');return}
  const btn=ev.target.querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Registering…';
  try{
    const out=await api('register',{patient});if(out.patient)updateLocalPatient(out.patient);
    toast('✓ Patient registered','success',1300);ev.target.reset();showView('Today');
  }catch(e){showSaveError('Registration not saved — '+e.message,()=>registerPatient(ev))}
  finally{btn.disabled=false;btn.textContent='Register patient'}
}
function bindOtherSelect(selectId,inputId){const sel=$('#'+selectId),inp=$('#'+inputId);const sync=()=>{const on=sel.value==='__other__';inp.classList.toggle('hidden',!on);inp.required=on;if(!on)inp.value=''};sel.addEventListener('change',sync);sync()}

/* Tools */
const opioidPotency={Morphine:1,Oxycodone:1.5,Hydromorphone:5,Tapentadol:.4,Tramadol:.1,Codeine:.1,Dihydrocodeine:.1};
function initOpioids(){for(const id of ['opFrom','opTo']){$('#'+id).innerHTML=Object.keys(opioidPotency).map(n=>`<option>${n}</option>`).join('')}$('#opTo').value='Oxycodone'}
function calcOpioid(){const from=$('#opFrom').value,to=$('#opTo').value,d=+$('#opDose').value,red=+$('#opReduction').value;if(!(d>=0)){return}const ome=d*opioidPotency[from],equiv=ome/opioidPotency[to],start=equiv*(1-red);$('#opResult').innerHTML=`OME ≈ <b>${ome.toFixed(1)} mg oral morphine/24 h</b><br>Calculated ${esc(to)} equivalent ≈ <b>${equiv.toFixed(1)} mg/24 h</b><br>${red?`After ${red*100}% reduction: <b>${start.toFixed(1)} mg/24 h</b>`:'No switch reduction applied.'}`}
function val(id){return parseFloat($('#'+id).value)}
function simpleResult(id,text){$('#'+id).innerHTML=text}
function calcBMI(){let w=val('bmiW'),h=val('bmiH')/100;if(w>0&&h>0)simpleResult('bmiResult',`BMI = <b>${(w/(h*h)).toFixed(1)} kg/m²</b>`)}
function ibw(sex,hcm){let inches=hcm/2.54,extra=Math.max(0,inches-60),base=sex==='Female'?45.5:50;return base+2.3*extra}
function calcIBW(){
  const h=val('ibwH'),sex=$('#ibwSex').value,actual=val('ibwActual');
  if(!(h>0))return;
  const ideal=ibw(sex,h);
  let out=`IBW ≈ <b>${ideal.toFixed(1)} kg</b>`;
  if(actual>0){
    if(actual>ideal){const adj=ideal+.4*(actual-ideal);out+=`<br>Adjusted body weight ≈ <b>${adj.toFixed(1)} kg</b><br><span class="small">AjBW = IBW + 0.4 × (actual − IBW)</span>`}
    else out+=`<br><span class="small">Actual body weight is not above IBW; an obesity AjBW correction is generally not applicable.</span>`;
  }
  if(h<152.4)out+=`<br><span class="small">Height is below 5 ft; interpret the Devine estimate cautiously.</span>`;
  simpleResult('ibwResult',out);
}
function calcCG(){let age=val('cgAge'),w=val('cgW'),cru=val('cgCr');if(age>0&&w>0&&cru>0){let cr=cru/88.4,cl=(140-age)*w/(72*cr);if($('#cgSex').value==='Female')cl*=.85;simpleResult('cgResult',`Cockcroft–Gault CrCl ≈ <b>${cl.toFixed(1)} mL/min</b>`)}}
function calcCKDEPI(){
  const age=val('ckdAge'),cru=val('ckdCr'),sex=$('#ckdSex').value,cys=val('ckdCys');
  if(!(age>=18&&cru>0))return;
  const female=sex==='Female',scr=cru/88.4,k=female?0.7:0.9,alpha=female?-.241:-.302;
  const ecr=142*Math.pow(Math.min(scr/k,1),alpha)*Math.pow(Math.max(scr/k,1),-1.2)*Math.pow(.9938,age)*(female?1.012:1);
  let out=`2021 CKD-EPI eGFRcr ≈ <b>${ecr.toFixed(1)} mL/min/1.73 m²</b>`;
  if(cys>0){
    const a2=female?-.219:-.144;
    const comb=135*Math.pow(Math.min(scr/k,1),a2)*Math.pow(Math.max(scr/k,1),-.544)*Math.pow(Math.min(cys/.8,1),-.323)*Math.pow(Math.max(cys/.8,1),-.778)*Math.pow(.9961,age)*(female?0.963:1);
    out=`2021 CKD-EPI eGFRcr-cys ≈ <b>${comb.toFixed(1)} mL/min/1.73 m²</b><br><span class="small">Creatinine-only estimate: ${ecr.toFixed(1)} mL/min/1.73 m²</span>`;
  }else out+=`<br><span class="small">Add cystatin C when available for the more accurate combined estimate, especially near a critical decision threshold.</span>`;
  if(age<=25)out+=`<br><span class="small">Age 18–25: also compare with CKiD U25.</span>`;
  simpleResult('ckdResult',out);
}
function calcPed(){
  const age=val('pedAge'),hcm=val('pedH'),cru=val('pedCr'),sex=$('#pedSex').value;
  if(!(age>=1&&age<=25&&hcm>0&&cru>0))return;
  const female=sex==='Female'; let kappa;
  if(age<12)kappa=(female?36.1:39.0)*Math.pow(1.008,age-12);
  else if(age<18)kappa=female?36.1*Math.pow(1.023,age-12):39.0*Math.pow(1.045,age-12);
  else kappa=female?41.4:50.8;
  const scr=cru/88.4,g=kappa*((hcm/100)/scr);
  let out=`CKiD U25 eGFRcr ≈ <b>${g.toFixed(1)} mL/min/1.73 m²</b>`;
  if(age>=18)out+=`<br><span class="small">Age 18–25: compare with the adult CKD-EPI estimate.</span>`;
  simpleResult('pedResult',out);
}
function openScale(kind,push=true){
  $('#scaleScreen').classList.add('open');
  if(kind==='nrs')renderNRS();if(kind==='faces')renderFaces();if(kind==='flacc')renderFLACC();if(kind==='bromage')renderBromage();
  if(push)history.pushState({aps:true,type:'scale',view:currentViewName(),kind},'','#scale-'+kind);
}
function zoomControls(kind){return `<div class="scale-zoom"><button class="iconbtn" data-zoom="down" aria-label="Reduce size">🔍−</button><span class="zoom-label" id="${kind}ZoomLabel">100%</span><button class="iconbtn" data-zoom="up" aria-label="Increase size">🔍+</button></div>`}
function bindScaleZoom(kind,selector){
  const root=$(selector);if(!root)return;const key='apsScaleZoom_'+kind;let zoom=parseFloat(localStorage.getItem(key)||'1');zoom=Math.min(1.35,Math.max(.75,zoom));
  const apply=()=>{root.style.setProperty('--scale-zoom',zoom);const l=$('#'+kind+'ZoomLabel');if(l)l.textContent=Math.round(zoom*100)+'%';localStorage.setItem(key,String(zoom))};apply();
  $$('#scaleBody [data-zoom]').forEach(b=>b.onclick=()=>{zoom=Math.min(1.35,Math.max(.75,zoom+(b.dataset.zoom==='up' ? 0.1 : -0.1)));apply()});
}
function renderNRS(){
  $('#scaleTitle').textContent='Numeric Rating Scale (NRS)';
  $('#scaleBody').innerHTML=`<div class="scale-panel">${zoomControls('nrs')}<div class="nrs">${[0,1,2,3,4,5,6,7,8,9,10].map(n=>`<button data-n="${n}">${n}</button>`).join('')}</div><div class="scale-result" id="nrsSelected">Select pain score</div>
  <details class="scale-guidance"><summary>Guidance, interpretation & references</summary><div class="evidence-body">
    <p><b>Use:</b> patient self-report of pain intensity, where 0 = no pain and 10 = worst possible pain. The patient's own report takes priority when they can communicate reliably.</p>
    <p><b>Practical severity bands:</b> 1–3 mild, 4–6 moderate, 7–10 severe are commonly used clinically, but thresholds should not replace assessment of function, distress, trajectory and the individual patient's acceptable pain goal.</p>
    <p>For serial assessment, change from baseline is often more useful than a single category. Acute-pain validation found a minimum clinically significant change around 1.3/10; a 2025 postoperative analysis found approximately 50% reduction to be a consistent marker of meaningful pain relief across studied surgical models.</p>
    <p><a href="https://pubmed.ncbi.nlm.nih.gov/12670856/" target="_blank" rel="noopener">Bijur et al. — NRS validation in acute pain</a> · <a href="https://pubmed.ncbi.nlm.nih.gov/40359379/" target="_blank" rel="noopener">2025 postoperative meaningful pain-relief analysis</a></p>
  </div></details></div>`;
  bindScaleZoom('nrs','.nrs');
  $$('.nrs button').forEach(b=>b.onclick=()=>{$$('.nrs button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#nrsSelected').textContent='NRS '+b.dataset.n+'/10'});
}
function renderFaces(){
  const faces=[['🙂',0],['😐',2],['🙁',4],['😣',6],['😫',8],['😭',10]];
  $('#scaleTitle').textContent='Faces pain assessment aid';
  $('#scaleBody').innerHTML=`<div class="scale-panel">${zoomControls('faces')}<div class="faces">${faces.map(([e,n])=>`<button class="facebtn" data-n="${n}"><span class="faceemoji">${e}</span><strong>${n}</strong><div class="small muted">/10</div></button>`).join('')}</div><div class="scale-result" id="faceSelected">Select the face that best matches the patient's pain</div><div class="note" style="text-align:center">Generic visual faces aid; not the validated FPS-R artwork.</div>
  <details class="scale-guidance"><summary>Guidance, interpretation & references</summary><div class="evidence-body">
    <p>This in-app emoji row is a <b>generic communication aid</b>, not a validated replacement for the official Faces Pain Scale–Revised (FPS-R). For formal paediatric self-report, use the official unmodified FPS-R where appropriate.</p>
    <p><b>FPS-R evidence:</b> intended as a self-report pain-intensity measure, particularly for children around 4–16 years; official scores are 0, 2, 4, 6, 8 and 10. Numerical 0–10 self-rating can usually be used in most children older than about 8 years. Avoid asking about “happy/sad”; ask how much the child hurts.</p>
    <p>Published FPS-R cut-points in children have classified 0/2 as no pain, 4 mild, 6 moderate and 8/10 severe; interpret in clinical context.</p>
    <p><a href="https://www.iasp-pain.org/resources/faces-pain-scale-revised/" target="_blank" rel="noopener">IASP — Faces Pain Scale–Revised</a> · <a href="https://pubmed.ncbi.nlm.nih.gov/27228146/" target="_blank" rel="noopener">FPS-R severity cut-points study</a></p>
  </div></details></div>`;
  bindScaleZoom('faces','.faces');
  $$('.facebtn').forEach(b=>b.onclick=()=>{$$('.facebtn').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#faceSelected').textContent='Selected '+b.dataset.n+'/10'});
}
const flacc=[
 ['Face','Relaxed / neutral','Occasional grimace or withdrawn','Frequent/constant frown, clenched jaw or quivering chin'],
 ['Legs','Normal / relaxed','Restless or tense','Kicking or legs drawn up'],
 ['Activity','Quiet, normal movement','Squirming, shifting or tense','Arched, rigid or jerking'],
 ['Cry','No cry','Moans/whimpers; intermittent complaint','Persistent crying/screaming or frequent complaint'],
 ['Consolability','Content / relaxed','Reassured by touch/talking/distraction','Difficult to console']
];
function renderFLACC(){
  $('#scaleTitle').textContent='FLACC score';
  $('#scaleBody').innerHTML=`<div class="scale-panel flacc-panel"><div class="flacc-table">${flacc.map((r,ri)=>`<section class="flacc-row"><div class="flacc-label">${r[0]}</div><div class="flacc-options">${[0,1,2].map(sc=>`<button class="flacc-option" data-r="${ri}" data-s="${sc}"><b>${sc}</b><span>${esc(r[sc+1])}</span></button>`).join('')}</div></section>`).join('')}</div><div class="scale-result">FLACC <span id="flaccTotal">0</span>/10</div>
  <details class="scale-guidance"><summary>Guidance, interpretation & references</summary><div class="evidence-body">
    <p><b>Use:</b> behavioural pain assessment when reliable self-report is not possible. Score Face, Legs, Activity, Cry and Consolability from 0–2 each; total 0–10.</p>
    <p><b>Practical interpretation:</b> 0 = relaxed/comfortable; 1–3 = mild discomfort/pain; 4–6 = moderate pain; 7–10 = severe pain. Reassess after an intervention and interpret alongside clinical context and baseline behaviour.</p>
    <p>The original FLACC tool was developed and validated for postoperative pain in young children. In children/adults with cognitive impairment, use the locally validated observational approach (including revised FLACC where applicable) rather than assuming behaviours have the same meaning for every patient.</p>
    <p><a href="https://pubmed.ncbi.nlm.nih.gov/9220806/" target="_blank" rel="noopener">Merkel et al. — Original FLACC validation</a> · <a href="https://www.moh.gov.my/moh/resources/Penerbitan/Program%20Bebas%20Kesakitan/Garis%20Panduan/PAEDIATRIC_PAIN_MANAGEMENT_GUIDELINE_-_2023.pdf" target="_blank" rel="noopener">MOH Malaysia — Paediatric Pain Management Guideline 2023</a></p>
  </div></details></div>`;
  const scores=[0,0,0,0,0];
  $$('.flacc-option').forEach(b=>b.onclick=()=>{const r=+b.dataset.r,sc=+b.dataset.s;scores[r]=sc;$$(`.flacc-option[data-r="${r}"]`).forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#flaccTotal').textContent=scores.reduce((a,v)=>a+v,0)});
}
function renderBromage(){
  const items=[
    ['0','FULL MOVEMENT','Full movement of hip, knee and ankle.'],
    ['1','PARTIAL BLOCK','Unable to raise the extended leg, but able to flex the knee and move the ankle/foot.'],
    ['2','MARKED BLOCK','Unable to flex the knee, but able to move the ankle/foot.'],
    ['3','COMPLETE BLOCK','Unable to move the leg or foot.']
  ];
  $('#scaleTitle').textContent='Bromage motor block score';
  $('#scaleBody').innerHTML=`<div class="scale-panel flacc-panel"><div class="bromage-grid">${items.map(([sc,name,txt])=>`<button class="bromage-option" data-score="${sc}"><b>${sc}</b><span class="bromage-copy"><b class="bromage-name">${esc(name)}</b><span>${esc(txt)}</span></span></button>`).join('')}</div><div class="scale-result" id="bromageSelected">Select motor block score</div>
  <details class="scale-guidance"><summary>Clinical notes & references</summary><div class="evidence-body">
    <p><b>Use:</b> rapid assessment of lower-limb motor block during neuraxial/epidural analgesia. Record and trend the score; a new, unexpectedly dense or progressive block requires prompt clinical assessment.</p>
    <p>The MOH Malaysia Pain Management Handbook advises active management for Bromage 2–3 during postoperative epidural analgesia, including reducing/stopping local anaesthetic as clinically appropriate, informing the pain/anaesthetic team and reassessing. Persistent motor block requires investigation for serious neuraxial complications according to local protocol.</p>
    <p><a href="https://www.moh.gov.my/images/04-penerbitan/penerbitan-klinikal/perkhidmatan-pembedahan/8_May_2024_-_FINAL_ARTWORK_-_PAIN_MANAGEMENT_HANDBOOK_Third_Edition_MOH_PDF_compressed.pdf" target="_blank" rel="noopener">MOH Malaysia — Pain Management Handbook, 3rd ed.</a></p>
  </div></details></div>`;
  $$('.bromage-option').forEach(b=>b.onclick=()=>{$$('.bromage-option').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#bromageSelected').textContent='BROMAGE '+b.dataset.score});
}



/* Medications */
async function ensureMedsLoaded(){
  if(S.medsLoaded)return S.medications;
  if(S.medsLoading){
    while(S.medsLoading)await new Promise(r=>setTimeout(r,40));
    return S.medications;
  }
  S.medsLoading=true;
  $('#medList').innerHTML='<div class="med-loading">Loading medication reference…</div>';
  try{
    const res=await fetch('./medications.json',{cache:'force-cache'});
    if(!res.ok)throw new Error('Medication reference could not be loaded.');
    S.medications=await res.json();
    S.medSearchIndex=S.medications.map(m=>[
      m.name,m.category,
      ...(m.blue||[]).flatMap(x=>[x.name,x.genericName,x.brandName,x.prescriberCategory,x.indications,x.dose,x.adverseReaction,x.contraindications,x.interactions,x.precautions,x.prescribingRestrictions,x.neml]),
      ...(m.frank||[]).flatMap(x=>[x.name,x.dose]),m.renal?.text,m.renal?.referenceLabel
    ].filter(Boolean).join(' ').toLowerCase());
    S.medsLoaded=true;initMeds();
    return S.medications;
  }finally{S.medsLoading=false}
}
function initMeds(){
  const cats=[...new Set((S.medications||[]).map(x=>x.category))].sort();
  $('#medCategory').innerHTML='<option value="">All categories</option><option value="__renal__">Renal Dose</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join('');
}
function medField(label,value){if(!value)return '';return `<div class="mono-label">${esc(label)}</div><div class="mono-value">${esc(value)}</div>`}
function blueDetailGroups(m){const fields=['brandName','prescriberCategory','indications','adverseReaction','contraindications','interactions','precautions','prescribingRestrictions','neml'];const groups=[];for(const x of (m.blue||[])){const sig=JSON.stringify(fields.map(f=>String(x[f]||'').trim()));let g=groups.find(z=>z.sig===sig);if(!g){g={sig,items:[],sample:x};groups.push(g)}g.items.push(x)}return groups}
function renderBlueMonograph(m){if(!m.blue?.length)return '<div class="source-missing">No matching Blue Book+ entry found.</div>';const doses=(m.blueDoseGroups||m.blue.map(x=>({names:[x.name],dose:x.dose||''}))).map(g=>`<div class="blue-dose-group"><strong>${g.names.map(esc).join(' / ')}</strong><div class="dose-text">${g.dose?esc(g.dose):'<span class="source-missing">No dosage text parsed for this formulation.</span>'}</div></div>`).join('');const details=blueDetailGroups(m).map(g=>{const x=g.sample;const names=g.items.map(i=>i.name),generic=[...new Set(g.items.map(i=>i.genericName).filter(Boolean))].join(' / ');return `<section class="formulation-mono"><h5>${names.map(esc).join(' / ')}</h5><div class="mono-grid">${medField('Generic name',generic)}${medField('Brand name',x.brandName)}${medField('Prescriber category',x.prescriberCategory)}${medField('Indications',x.indications)}${medField('Adverse reactions',x.adverseReaction)}${medField('Contraindications',x.contraindications)}${medField('Interactions',x.interactions)}${medField('Precautions',x.precautions)}${medField('Prescribing restrictions',x.prescribingRestrictions)}${medField('NEML',x.neml)}</div></section>`}).join('');return `${doses}<details class="monograph-details"><summary>Blue Book formulary details</summary>${details}</details>`}
const ORGAN_RULES=[
  ['Renal',/renal|kidney|nephro|dialysis|creatinine clearance/i],['Liver',/hepatic|liver|cirrhos|hepat/i],
  ['Heart',/heart failure|cardiac|cardiovascular|ischaemic heart|ischemic heart|coronary|myocardial|angina|arrhythm|qt prolong|cor pulmonale/i],
  ['Respiratory',/respiratory|asthma|bronch|copd|airway|sleep apnoea|sleep apnea/i],
  ['GI',/peptic|gastrointestinal|gastro-intestinal|gi bleed|ulcer|intestinal obstruction|ileus|gastric bleeding/i],
  ['CNS',/epilep|seizure|convuls|intracranial|head injury|cns depression|coma/i],
  ['Bleeding',/coagul|bleed|haemorr|hemorr|platelet|anticoagul/i]
];
function blueOrganFlags(m){const out=[];for(const [label,re] of ORGAN_RULES){let severity='';for(const x of (m.blue||[])){if(re.test(String(x.contraindications||''))){severity='danger';break}if(!severity&&re.test(String(x.precautions||'')))severity='warn'}if(severity)out.push({label,severity})}return out}
function renalTagInfo(m){if(!m.renal)return null;const txt=String(m.renal.text||'');const blueRenalCI=(m.blue||[]).some(x=>/renal|kidney|nephro/i.test(String(x.contraindications||'')));const avoid=blueRenalCI||/\bavoid(?:ed|ance|ing)?\b|contraindicat|not recommended|should not be used|do not use/i.test(txt);return {label:avoid?'Renal restriction':'Renal dose',severity:avoid?'danger':'warn'}}
function medSafetyTags(m){const renal=renalTagInfo(m),flags=blueOrganFlags(m).filter(f=>!(renal&&f.label==='Renal'));const all=[...(renal?[renal]:[]),...flags];return all.length?`<div class="med-safety-tags">${all.map(f=>`<span class="safety-tag ${f.severity}">${esc(f.label)}</span>`).join('')}</div>`:''}
function toggleFavorite(name){const i=S.favorites.indexOf(name);if(i>=0)S.favorites.splice(i,1);else S.favorites.unshift(name);S.favorites=S.favorites.slice(0,12);localStorage.setItem('apsMedFavorites',JSON.stringify(S.favorites));renderMeds()}
function addRecentMed(name){S.recentMeds=[name,...S.recentMeds.filter(x=>x!==name)].slice(0,8);localStorage.setItem('apsRecentMeds',JSON.stringify(S.recentMeds));renderMedQuick()}
async function focusMed(name){await ensureMedsLoaded();$('#medSearch').value=name;S.medVisibleLimit=30;renderMeds();requestAnimationFrame(()=>{const d=$(`#medList details[data-med="${CSS.escape(name)}"]`);if(d){d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'})}})}
function renderMedQuick(){const mk=(arr,empty)=>arr.length?arr.map(n=>`<button class="quick-med" data-medquick="${esc(n)}">${esc(n)}</button>`).join(''):`<span class="muted small">${empty}</span>`;$('#medQuick').innerHTML=`<div class="quick-row"><div class="quick-label">Favourites</div><div class="quick-chips">${mk(S.favorites,'Star medicines to keep them here.')}</div></div><div class="quick-row"><div class="quick-label">Recently used</div><div class="quick-chips">${mk(S.recentMeds,'Recently opened medicines appear here.')}</div></div>`;$$('[data-medquick]').forEach(b=>b.onclick=()=>focusMed(b.dataset.medquick))}
function renderMeds(){
  if(!S.medsLoaded){$('#medList').innerHTML='<div class="med-loading">Loading medication reference…</div>';return}
  const q=$('#medSearch').value.trim().toLowerCase(),cat=$('#medCategory').value;
  const indices=[];for(let i=0;i<S.medications.length;i++){const m=S.medications[i];if(cat==='__renal__'&&!m.renal)continue;if(cat&&cat!=='__renal__'&&m.category!==cat)continue;if(q&&!S.medSearchIndex[i].includes(q))continue;indices.push(i)}
  const total=indices.length,shown=indices.slice(0,S.medVisibleLimit).map(i=>S.medications[i]);
  $('#medCount').textContent=`${total} medication groups${total>S.medVisibleLimit?` · showing ${shown.length}`:''}`;
  $('#medList').innerHTML=shown.map(m=>{const rt=renalTagInfo(m);return `<details class="card med-card" data-med="${esc(m.name)}"><summary><div class="med-title-wrap"><div class="medname">${esc(m.name)}</div><div class="small muted">${esc(m.category)}</div>${medSafetyTags(m)}</div><div class="med-summary-right"><button class="favorite-star ${S.favorites.includes(m.name)?'active':''}" data-fav="${esc(m.name)}" aria-label="Favourite">${S.favorites.includes(m.name)?'★':'☆'}</button><span class="chip">${m.blue.length} Blue Book · ${m.frank.length} Frank Shann</span></div></summary><div class="source-block"><h4>Blue Book+</h4>${renderBlueMonograph(m)}</div><div class="source-block"><h4>Frank Shann DrugDoses</h4>${m.frank.length?m.frank.map(x=>`<div class="dose-entry"><strong>${esc(x.name)}</strong><div>${esc(x.dose)}</div></div>`).join(''):'<div class="source-missing">No matching Frank Shann entry found.</div>'}</div>${m.renal?`<div class="source-block renal-block ${rt?.severity==='danger'?'avoid':''}"><h4>Renal Dose <span class="safety-tag ${rt?.severity||'warn'}">${esc(rt?.label||'Renal dose')}</span></h4><div class="renal-text">${esc(m.renal.text)}</div><a class="renal-ref" href="${esc(m.renal.referenceUrl)}" target="_blank" rel="noopener">Reference: ${esc(m.renal.referenceLabel)}</a></div>`:''}</details>`}).join('')||'<div class="empty">No medications match your search.</div>';
  if(total>S.medVisibleLimit)$('#medList').insertAdjacentHTML('beforeend',`<div class="med-more"><button class="btn secondary" id="medMoreBtn">Show more</button></div>`);
  $$('[data-fav]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();toggleFavorite(b.dataset.fav)});
  $$('#medList details[data-med]').forEach(d=>d.addEventListener('toggle',()=>{if(d.open)addRecentMed(d.dataset.med)}));
  $('#medMoreBtn')?.addEventListener('click',()=>{S.medVisibleLimit+=30;renderMeds()});
  renderMedQuick();
}
function syncSettingsUI(){$('#settingsTheme').value=S.settings.theme;$('#settingsDefaultView').value=S.settings.defaultView;$('#settingsAutoCollapse').checked=!!S.settings.autoCollapse;$('#settingsSessionTimeout').value=String(S.settings.sessionTimeout)}
function updateSetting(key,value){S.settings[key]=value;saveSettings();if(key==='theme')applyTheme();if(key==='defaultView'){S.viewMode=value;sessionStorage.setItem('apsCurrentViewModeV126',S.viewMode);if(currentViewName()==='Today')renderToday();}if(key==='autoCollapse'){S.wardOpen={};saveWardState();renderToday();}touchActivity()}
function checkSessionTimeout(){if(!S.token)return;const ms=(+S.settings.sessionTimeout||8)*3600000;if(Date.now()-S.lastActivity>ms){toast('Session timed out — app locked','error',2200);lockApp()}}

/* Events */
$('#loginBtn').onclick=login;$('#passwordInput').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$$('.navbtn').forEach(b=>b.onclick=()=>showView(b.dataset.view));
$('#refreshBtn').onclick=()=>loadToday({preserveScroll:true,force:true});
$('#todaySearch').oninput=renderToday;
$('#modalityFilter').onchange=e=>{S.modalityFilter=e.target.value;renderToday()};
$$('#viewModeSeg button').forEach(b=>b.onclick=()=>{S.viewMode=b.dataset.mode;sessionStorage.setItem('apsCurrentViewModeV126',S.viewMode);renderToday()});
$$('#roundFilterSeg button').forEach(b=>b.onclick=()=>{S.roundFilter=b.dataset.filter;$$('#roundFilterSeg button').forEach(x=>x.classList.toggle('active',x===b));renderToday()});
$('#openDocBtn').onclick=()=>{if(S.docUrl)window.open(S.docUrl,'_blank','noopener')};
$('#closePatient').onclick=closePatientViaHistory;$('#editPatientBtn').onclick=()=>openPatientEdit(true);$('#editPatientForm').onsubmit=savePatientDetails;$('#cancelPatientEditBtn').onclick=cancelPatientEditViaHistory;$('#savePatientBtn').onclick=()=>saveCurrent(false);$('#saveNextBtn').onclick=()=>saveCurrent(true);$('#cancelDischargeBtn').onclick=cancelDischarge;$('#prevPatientBtn').onclick=()=>movePatient(-1);$('#nextPatientBtn').onclick=()=>movePatient(1);
$('#registrationForm').onsubmit=registerPatient;$('#registrationForm').addEventListener('reset',()=>setTimeout(()=>{['raceOther','wardOther','modeOther'].forEach(id=>{$('#'+id).classList.add('hidden');$('#'+id).required=false})},0));
$('#settingsBtn').onclick=()=>openSettings(true);$('#closeSettings').onclick=closeSettingsViaHistory;$('#logoutBtn').onclick=async()=>{try{if(S.token)await api('logout')}catch(e){}replaceOverlayWithViewState();$('#settingsDialog').close();lockApp()};
$('#settingsTheme').onchange=e=>updateSetting('theme',e.target.value);$('#settingsDefaultView').onchange=e=>updateSetting('defaultView',e.target.value);$('#settingsAutoCollapse').onchange=e=>updateSetting('autoCollapse',e.target.checked);$('#settingsSessionTimeout').onchange=e=>updateSetting('sessionTimeout',+e.target.value);
$$('[data-scale]').forEach(b=>b.onclick=()=>openScale(b.dataset.scale,true));$('#closeScale').onclick=closeScaleViaHistory;
$('#opCalc').onclick=calcOpioid;$('#bmiCalc').onclick=calcBMI;$('#ibwCalc').onclick=calcIBW;$('#cgCalc').onclick=calcCG;$('#ckdCalc').onclick=calcCKDEPI;$('#pedCalc').onclick=calcPed;
$('#medSearch').oninput=()=>{S.medVisibleLimit=30;renderMeds()};$('#medCategory').onchange=()=>{S.medVisibleLimit=30;renderMeds()};
$('#retrySave').onclick=()=>{const fn=S.retryFn;hideSaveError();if(fn)fn()};
$('#backToTop').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
window.addEventListener('scroll',()=>{saveScroll();$('#backToTop').classList.toggle('show',window.scrollY>520)},{passive:true});
window.addEventListener('online',()=>{setConnection(true);if(currentViewName()==='Today'&&S.token)loadToday({preserveScroll:true,background:true})});window.addEventListener('offline',()=>setConnection(false));
['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev,touchActivity,{passive:true}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&currentViewName()==='Today'&&S.token&&Date.now()-S.lastLoad>15000)loadToday({preserveScroll:true,background:true})});
window.addEventListener('pageshow',()=>{if(S.token&&currentViewName()==='Today'&&Date.now()-S.lastLoad>15000)loadToday({preserveScroll:true,background:true})});

window.addEventListener('popstate',async e=>{
  if($('#patientDialog').open&&(patientEditDirty()||patientDirty())&&!S.allowPop){
    const editing=patientEditMode(),currentState={aps:true,type:editing?'patientEdit':'patient',view:currentViewName(),key:S.current?._key};
    history.pushState(currentState,'',editing?'#patient-edit':'#patient');
    const discard=await confirmDiscardIfDirty();
    if(discard){S.patientOriginal=editing?S.patientOriginal:null;S.editOriginal=null;S.allowPop=true;history.back();setTimeout(()=>S.allowPop=false,50)}
    return
  }
  if($('#patientDialog').open)$('#patientDialog').close();if($('#settingsDialog').open)$('#settingsDialog').close();$('#scaleScreen').classList.remove('open');const st=e.state;if(!st?.aps)return;
  if(st.type==='view')showView(st.view||'Today',{push:false,restore:true,refresh:false});
  else if(st.type==='patient'){showView(st.view||'Today',{push:false,restore:true,refresh:false});openPatient(st.key,false)}
  else if(st.type==='patientEdit'){showView(st.view||'Today',{push:false,restore:true,refresh:false});openPatient(st.key,false);openPatientEdit(false)}
  else if(st.type==='scale'){showView(st.view||'Tools',{push:false,restore:true,refresh:false});openScale(st.kind,false)}
  else if(st.type==='settings'){showView(st.view||'Today',{push:false,restore:true,refresh:false});openSettings(false)}
});
$('#patientDialog').addEventListener('cancel',e=>{e.preventDefault();closePatientViaHistory()});$('#settingsDialog').addEventListener('cancel',e=>{e.preventDefault();closeSettingsViaHistory()});

function bootstrap(){
  applyTheme();history.replaceState({aps:true,type:'view',view:'Today'},'',routeHash('Today'));
  bindOtherSelect('raceSelect','raceOther');bindOtherSelect('wardSelect','wardOther');bindOtherSelect('modeSelect','modeOther');cloneEditSelectOptions();editSelectOtherSync('editRace','editRaceOther');editSelectOtherSync('editWard','editWardOther');editSelectOtherSync('editMode','editModeOther');
  initOpioids();syncSettingsUI();
  const now=new Date();$('#appSubtitle').textContent=now.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  setConnection(navigator.onLine);
  if(S.token){
    const ms=(+S.settings.sessionTimeout||8)*3600000;
    if(Date.now()-S.lastActivity>ms)lockApp();
    else{
      $('#gate').classList.add('hidden');
      const hydrated=hydrateTodaySession();
      loadToday({background:hydrated,preserveScroll:hydrated});
    }
  }
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  setInterval(checkSessionTimeout,60000);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(S.settings.theme==='system')applyTheme()});
}
bootstrap();