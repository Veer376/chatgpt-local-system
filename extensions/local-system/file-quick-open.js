/* global document, location, parent, requestAnimationFrame */
const params=new URLSearchParams(location.search);
const threadId=params.get("threadId")||"";
const initialQuery=(params.get("query")||"").slice(0,300);
const search=document.getElementById("search"); const status=document.getElementById("status"); const results=document.getElementById("results");
const modeFiles=document.getElementById("mode-files"); const modeText=document.getElementById("mode-text"); const shortcutHint=document.getElementById("shortcut-hint");
let files=[]; let activeIndex=0; let searchTimer=null; let sequence=0; let hostActive=true; let activeSearchController=null; let searchNote="";
let pointerBaseline=null; let pointerSelectionArmed=false;
let mode=params.get("mode")==="text"?"text":"files";

globalThis.addEventListener("message",(event)=>{ if(event.data?.source!=="local-system-host")return; if(event.data.theme)applyTheme(event.data.theme); if(typeof event.data.active==="boolean")hostActive=event.data.active; });
search.addEventListener("input",()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(runSearch,55); });
search.addEventListener("keydown",(event)=>{ if(event.key==="Escape"){event.preventDefault(); close();} else if(event.key==="ArrowDown"){event.preventDefault();move(1);} else if(event.key==="ArrowUp"){event.preventDefault();move(-1);} else if(event.key==="Enter"){event.preventDefault();openActive();} });
modeFiles.addEventListener("click",()=>setMode("files"));
modeText.addEventListener("click",()=>setMode("text"));
results.addEventListener("pointermove",handlePointerMove,{passive:true});
requestAnimationFrame(()=>{ syncMode(); if(initialQuery)search.value=initialQuery; search.focus(); if(initialQuery)search.select(); runSearch(); parent.postMessage({source:"local-system-file-quick-open",action:"ready"},"*"); });

async function runSearch(){ const current=++sequence; const query=search.value; activeSearchController?.abort(); const controller=new AbortController(); activeSearchController=controller; searchNote=""; if(mode==="text"&&!query.trim()){files=[];activeIndex=0;render(); if(activeSearchController===controller)activeSearchController=null; return;} try{ const endpoint=mode==="text"?"/local-ui/files/content-search":"/local-ui/files/search"; const payload=await request(endpoint,{threadId,query,active:hostActive,workspaceOnly:true},{signal:controller.signal}); if(current!==sequence||controller.signal.aborted)return; files=mode==="text"?(Array.isArray(payload.matches)?payload.matches:[]):(Array.isArray(payload.files)?payload.files:[]); if(payload.truncated===true||Number(payload.total)>files.length)searchNote=`Showing first ${files.length} result${files.length===1?"":"s"}.`; activeIndex=0; render(); }catch(error){ if(current!==sequence||controller.signal.aborted||error?.name==="AbortError")return; files=[]; searchNote=""; renderStatus(error instanceof Error?error.message:String(error)); }finally{ if(activeSearchController===controller)activeSearchController=null; } }
function render(){ resetPointerActivation(); results.replaceChildren(); if(!files.length){ renderStatus(emptyMessage()); return;} status.textContent=searchNote; files.forEach((file,index)=>{ const row=document.createElement("button"); row.type="button"; row.className=`row ls-ui-list-row${index===activeIndex?" active":""}`; row.setAttribute("role","option"); row.setAttribute("aria-selected",index===activeIndex?"true":"false"); const type=fileType(file.name); const ext=document.createElement("span"); ext.className="file-icon"; ext.dataset.kind=type.kind; ext.textContent=type.label; ext.title=type.title; const copy=document.createElement("span"); copy.className="file-copy"; const name=document.createElement("span"); name.className="file-name"; name.textContent=file.name; const path=document.createElement("span"); path.className="file-path"; path.textContent=mode==="text"?`${file.displayPath||file.path}:${file.line||1}`:(file.displayPath||file.path); copy.append(name,path); if(mode==="text"&&file.preview){ const preview=document.createElement("span"); preview.className="match-preview"; preview.textContent=file.preview; copy.append(preview); } const source=document.createElement("span"); source.className="source"; if(mode==="text"){ source.dataset.source="line"; source.textContent=`L${file.line||1}`; }else{ source.dataset.source=sourceKind(file.source); source.textContent=sourceLabel(file.source); } row.append(ext,copy,source); row.addEventListener("mouseenter",()=>{if(pointerSelectionArmed)setActive(index);}); row.addEventListener("click",()=>openFile(file)); results.appendChild(row); }); reportSize(); }
function renderStatus(message){ results.replaceChildren(); status.textContent=message; reportSize(); }
function emptyMessage(){ if(mode==="text")return search.value.trim()?"No matching text in this workspace.":"Type to search file contents in the current workspace."; return search.value.trim()?"No matching files.":"Type to search files by name or path."; }
function setMode(next){ if(next!=="files"&&next!=="text"||next===mode)return; mode=next; activeIndex=0; files=[]; syncMode(); runSearch(); }
function syncMode(){ const text=mode==="text"; modeFiles.classList.toggle("active",!text); modeText.classList.toggle("active",text); modeFiles.setAttribute("aria-selected",text?"false":"true"); modeText.setAttribute("aria-selected",text?"true":"false"); search.placeholder=text?"Search text in workspace…":"Search files by name or path…"; search.setAttribute("aria-label",text?"Search workspace text":"Search files"); shortcutHint.textContent=text?"⌘⇧F":"⌘P"; }
function setActive(index){ activeIndex=Math.max(0,Math.min(files.length-1,index)); [...results.children].forEach((row,i)=>{row.classList.toggle("active",i===activeIndex);row.setAttribute("aria-selected",i===activeIndex?"true":"false");}); results.children[activeIndex]?.scrollIntoView({block:"nearest"}); }
function resetPointerActivation(){ pointerBaseline=null; pointerSelectionArmed=false; document.documentElement.dataset.pointerActive="false"; }
function handlePointerMove(event){ if(pointerSelectionArmed)return; if(!pointerBaseline){pointerBaseline={x:event.clientX,y:event.clientY};return;} if(Math.hypot(event.clientX-pointerBaseline.x,event.clientY-pointerBaseline.y)<2)return; pointerSelectionArmed=true; document.documentElement.dataset.pointerActive="true"; const row=event.target?.closest?.(".row"); if(row){const index=[...results.children].indexOf(row);if(index>=0)setActive(index);} }
function move(delta){ if(!files.length)return; setActive((activeIndex+delta+files.length)%files.length); }
function openActive(){ if(files[activeIndex])openFile(files[activeIndex]); }
function openFile(file){ parent.postMessage({source:"local-system-file-quick-open",action:"open-file",path:file.path,line:Number(file.line)||null,column:Number(file.column)||null,length:typeof file.match==="string"?file.match.length:null},"*"); }
function close(){ activeSearchController?.abort(); activeSearchController=null; parent.postMessage({source:"local-system-file-quick-open",action:"close"},"*"); }
function fileType(name){
  const base=String(name||"").trim();
  const lower=base.toLowerCase();
  if(/^dockerfile(?:\..+)?$/i.test(base))return {kind:"docker",label:"D",title:"Dockerfile"};
  if(/^\.env(?:\..+)?$/i.test(base))return {kind:"config",label:"⚙",title:"Environment file"};
  const idx=lower.lastIndexOf(".");
  const ext=idx>0?lower.slice(idx+1):"";
  const types={
    html:["html","</>","HTML"],htm:["html","</>","HTML"],
    py:["python","Py","Python"],pyw:["python","Py","Python"],
    js:["javascript","JS","JavaScript"],jsx:["javascript","JS","JavaScript"],mjs:["javascript","JS","JavaScript"],cjs:["javascript","JS","JavaScript"],
    ts:["typescript","TS","TypeScript"],tsx:["typescript","TS","TypeScript"],
    css:["css","#","CSS"],scss:["css","#","Stylesheet"],sass:["css","#","Stylesheet"],less:["css","#","Stylesheet"],
    json:["json","{}","JSON"],jsonc:["json","{}","JSON"],
    md:["markdown","MD","Markdown"],mdx:["markdown","MD","Markdown"],markdown:["markdown","MD","Markdown"],
    sh:["shell","$","Shell"],bash:["shell","$","Shell"],zsh:["shell","$","Shell"],fish:["shell","$","Shell"],
    java:["java","J","Java"],kt:["kotlin","K","Kotlin"],kts:["kotlin","K","Kotlin"],swift:["swift","S","Swift"],
    go:["go","Go","Go"],rs:["rust","Rs","Rust"],rb:["ruby","Rb","Ruby"],php:["php","P","PHP"],
    sql:["sql","DB","SQL"],xml:["xml","<>","XML"],svg:["xml","<>","SVG"],
    yml:["yaml","Y","YAML"],yaml:["yaml","Y","YAML"],toml:["config","⚙","TOML"],ini:["config","⚙","Config"],conf:["config","⚙","Config"],
    png:["image","◈","Image"],jpg:["image","◈","Image"],jpeg:["image","◈","Image"],gif:["image","◈","Image"],webp:["image","◈","Image"],
  };
  const type=types[ext];
  if(type)return {kind:type[0],label:type[1],title:type[2]};
  return {kind:"generic",label:ext?ext.slice(0,2).toUpperCase():"•",title:ext?`${ext.toUpperCase()} file`:"File"};
}
function sourceKind(value){ const source=String(value||"").trim().toLowerCase(); if(source==="workspace")return "workspace"; if(source==="scratch")return "scratch"; return "root"; }
function sourceLabel(value){ const source=String(value||"").trim(); if(!source)return "Root"; if(source.toLowerCase()==="workspace")return "Workspace"; if(source.toLowerCase()==="scratch")return "Scratch"; return source; }
async function request(path,body,{signal}={}){ const api=globalThis.LocalSystemExtensionApi; if(!api?.request)throw new Error("Local System extension API unavailable"); return api.request(path,body,{signal,timeoutMs:2500}); }
function applyTheme(theme){ globalThis.LocalSystemSharedRuntime?.applyTheme(theme,{aliases:true,composerTypography:true,mainFontSizeVariable:"--ls-file-picker-font-size"}); }
function reportSize(){ requestAnimationFrame(()=>parent.postMessage({source:"local-system-file-quick-open",action:"resize",height:Math.ceil(document.getElementById("panel").getBoundingClientRect().height)},"*")); }
