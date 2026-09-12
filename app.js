
// スマホの横向き回転を抑止（PWA/対応ブラウザで有効）
function lockPortraitOrientation(){
  try {
    if (screen.orientation && typeof screen.orientation.lock === "function") {
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      if (isStandalone) {
        screen.orientation.lock("portrait").catch(() => {});
      }
    }
  } catch (e) {}
}

window.addEventListener("load", lockPortraitOrientation);
document.addEventListener("visibilitychange", () => { if (!document.hidden) lockPortraitOrientation(); });
const KEY={events:"event_parent_v1",products:"product_v1",schedules:"schedule_v1",settings:"app_settings_v1"};
let events=load(KEY.events,[]),products=load(KEY.products,[]),schedules=load(KEY.schedules,[]);
let appSettings=load(KEY.settings,{prizePeriods:{"一番くじ":30,"UFOキャッチャー":14,"その他景品":30},notifications:{deadline1day:true,deadline1hour:true}});
appSettings.prizePeriods=Object.assign({"一番くじ":30,"UFOキャッチャー":14,"その他景品":30},appSettings.prizePeriods||{});
appSettings.notifications=Object.assign({deadline1day:true,deadline1hour:true},appSettings.notifications||{});
// イベントの公演日ごとの情報を正規化。旧形式の出演者は公演1へ移行する。
function normalizeEvent(e){
  e=e||{};
  e.performances=Array.isArray(e.performances)?e.performances:[];
  if(!e.performances.length)e.performances=[{date:""}];
  e.performances=e.performances.map((p,i)=>{
    p=p||{};
    if(i===0 && !p.performers && e.performers)p.performers=e.performers;
    p.performers=String(p.performers||"");
    p.dayName=String(p.dayName||"");
    p.id=String(p.id||id());
    return p;
  });
  // 旧形式の申込はイベント全体への申込として扱い、既存データとの互換性を保つ。
  e.applications=Array.isArray(e.applications)?e.applications:[];
  e.applications=e.applications.map(a=>{
    a=a||{};
    if(!Array.isArray(a.performanceIds)) a.performanceIds=e.performances.map(p=>p.id);
    if(!a.performanceStatuses || typeof a.performanceStatuses!=="object") a.performanceStatuses={};
    a.performanceIds.forEach(pid=>{ if(!a.performanceStatuses[pid]) a.performanceStatuses[pid]=a.status||"未応募"; });
    return a;
  });
  // 旧イベントの全体出演者は公演1へ移したため、イベント全体欄は空にする。
  e.performers="";
  return e;
}
events=events.map(normalizeEvent);

// 旧形式・旧保存形式を含め、予定を常に「開始日～終了日＋日ごとの予定」の形へ正規化
function normalizeSchedule(s){
  s=s||{};
  if(!s.date&&s.start){
    const parts=String(s.start).split("T");
    s.date=parts[0]||"";
    s.meetingTime=s.meetingTime||parts[1]||"";
    s.startTime=s.startTime||parts[1]||"";
  }
  s.date=String(s.date||"").slice(0,10);
  s.endDate=String(s.endDate||"").slice(0,10);
  s.eventIds=Array.isArray(s.eventIds)?s.eventIds:[];

  let plans=[];
  if(Array.isArray(s.dailyPlans)) plans=s.dailyPlans;
  else if(s.dailyPlans && typeof s.dailyPlans==="object"){
    plans=Object.entries(s.dailyPlans).map(([date,text])=>({date,text:String(text||"")}));
  }

  // 日付を統一し、同じ日付の重複は最後の内容を保持する
  const planMap=new Map();
  plans.forEach(x=>{
    if(!x)return;
    const d=String(x.date||"").slice(0,10);
    if(d) planMap.set(d,{date:d,text:String(x.text??"")});
  });
  s.dailyPlans=[...planMap.values()].sort((a,b)=>a.date.localeCompare(b.date));

  // 終了日が消えていても、保存済みの日ごとの予定から期間を復元する。
  const maxDaily=s.dailyPlans.reduce((m,x)=>x.date>m?x.date:m,"");
  if(!s.endDate || (s.date && s.endDate<s.date) || (maxDaily && maxDaily>s.endDate)){
    s.endDate=maxDaily||s.date||"";
  }
  if(!s.endDate) s.endDate=s.date||"";
  return s;
}
schedules=schedules.map(normalizeSchedule);
const state={page:"home",returnPage:"home",scheduleReturnPage:null,eventId:null,productId:null,scheduleId:null,orderId:null,saleItemIndex:null,calendarDate:new Date(),selectedDate:new Date(),calendarView:"month",filters:{events:{type:"",keyword:""},products:{type:"",keyword:""},schedules:{type:"",keyword:""}},scheduleSections:{current:true,future:false,past:false},schedulePastMonths:{},eventPastMonths:{},productDisplayMode:"goods",productSections:{soon:true,comfortable:false,expired:false,general:false,purchased:false},calendarFilters:{event:true,applicationStart:true,applicationEnd:true,announcement:true,popup:true,order:true,prize:true,schedule:true},calendarFilterOpen:false};
function load(k,d){try{return JSON.parse(localStorage.getItem(k))||d}catch{return d}}
function save(k,v){
  localStorage.setItem(k,JSON.stringify(v));
  if(window.raffleDb?.user && typeof window.queueRaffleSync === "function") window.queueRaffleSync();
}

// 申込の受付ステータスを日時に応じて自動更新
// ・受付開始日時を過ぎたら「未応募」「応募予定」「受付前」→「受付中」
// ・受付終了日時を過ぎても「応募済み」になっていない受付中系ステータス→「受付終了」
// ・応募済み等の確定済みステータスは上書きしない
function updateApplicationStatuses(){
  const now=new Date();
  let changed=false;
  events.forEach(e=>{
    (e.applications||[]).forEach(a=>{
      if(!a.start&&!a.end)return;
      const start=a.start?new Date(a.start):null;
      const end=a.end?new Date(a.end):null;
      const status=a.status||"未応募";

      if(start && !Number.isNaN(start.getTime()) && now>=start &&
         (!end || Number.isNaN(end.getTime()) || now<=end) &&
         ["未応募","応募予定","受付前"].includes(status)){
        a.status="受付中";
        changed=true;
      }

      if(end && !Number.isNaN(end.getTime()) && now>end &&
         ["未応募","応募予定","受付前","受付中"].includes(a.status)){
        a.status="受付終了";
        changed=true;
      }
    });
  });
  if(changed)save(KEY.events,events);
  return changed;
}

function id(){
  try{if(window.crypto?.randomUUID)return window.crypto.randomUUID();}catch(e){}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==="x"?r:(r&3|8);return v.toString(16)});
}function esc(v=""){return String(v).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function date(v){if(!v)return"-";const d=new Date(v+"T00:00:00");return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`}
function homeDate(v){if(!v)return"-";const d=new Date(v+"T00:00:00");const w=["日","月","火","水","木","金","土"];return `${d.getMonth()+1}月${d.getDate()}日（${w[d.getDay()]}）`;}
function localDateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function dt(v){return v?v.replace("T"," "):"-"}
function detail(k,v){return `<div class="detail"><span>${esc(k)}</span><b>${esc(v||"-")}</b></div>`}
function urlDetail(k,v){const raw=String(v||"").trim();if(!raw)return detail(k,"");const href=/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)?raw:`https://${raw}`;return `<div class="detail"><span>${esc(k)}</span><b><a class="detail-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(raw)}</a></b></div>`}
function title(t,back=false){
  document.getElementById("pageTitle").textContent=t;
  document.getElementById("backButton").classList.toggle("hidden",!back);

  const header=document.querySelector(".header");
  const icon=document.getElementById("headerIcon");
  const page=state.page;
  const icons={
    home:`<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
    calendar:`<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 9h18"/></svg>`,
    events:`<svg viewBox="0 0 24 24"><path d="M4 7.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5v-2Z"/><path d="M10 7.5v9M14 7.5v9"/></svg>`,
    products:`<svg viewBox="0 0 24 24"><path d="M5 8h14l1 13H4L5 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/></svg>`,
    schedules:`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>`
  };
  const key=["home","calendar","events","products","schedules"].includes(page)?page:"detail";
  header.className=`header header-${key}${back?" header-with-back":""}`;
  icon.innerHTML=icons[page]||`<svg viewBox="0 0 24 24"><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`;
  icon.classList.toggle("hidden",back);
}
function nav(){
  document.querySelectorAll(".bottom-nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===state.page));
  const add = document.getElementById("addButton");
  if(add){
    const hideAdd = ["event","eventForm","product","productForm","schedule","scheduleForm","orderForm","saleItemForm","wishlist"].includes(state.page);
    add.classList.toggle("hidden", hideAdd);
  }
}
function render(){nav();switch(state.page){case"home":home();break;case"calendar":calendar();break;case"events":eventsList();break;case"event":eventDetail();break;case"eventForm":eventForm();break;case"products":productsList();break;case"wishlist":wishlistList();break;case"product":productDetail();break;case"productForm":productForm();break;case"schedules":scheduleList();break;case"schedule":scheduleDetail();break;case"scheduleForm":scheduleForm();break;case"orderForm":orderForm();break;case"saleItemForm":saleItemForm();break;case"settings":settingsPage();break;case"settingsDisplay":settingsDisplayPage();break;case"settingsNotifications":settingsNotificationPage();break;case"settingsData":settingsDataPage();break;case"settingsAccount":settingsAccountPage();break}}
function go(p){
  // フッターから画面を切り替えたときは、各画面を毎回初期表示状態に戻す
  state.page=p;
  state.returnPage=p;
  state.scheduleReturnPage=null;
  state.eventId=null;
  state.productId=null;
  state.scheduleId=null;
  state.orderId=null;
  state.saleItemIndex=null;

  // 一覧画面の絞り込み・開閉状態をリセット
  if(p==="events"){
    state.filters.events={type:"",keyword:""};
    state.eventSections={current:true,future:false,past:false};
  }else if(p==="products"){
    state.filters.products={type:"",keyword:""};
    state.productSections={soon:true,comfortable:false,expired:false,general:false,purchased:false};
  }else if(p==="schedules"){
    state.filters.schedules={type:"",keyword:""};
    state.scheduleSections={current:true,future:false,past:false};
  }

  // カレンダーは今日を起点に初期状態へ戻す
  if(p==="calendar"){
    const today=new Date();
    today.setHours(0,0,0,0);
    state.calendarDate=new Date(today.getFullYear(),today.getMonth(),1);
    state.selectedDate=new Date(today);
  }

  // 開いているモーダルを閉じる
  document.getElementById("addModal")?.classList.add("hidden");
  document.getElementById("filterModal")?.remove();

  render();
  // 画面切り替え時にスクロール位置も先頭へ戻す
  const screen=document.getElementById("screen");
  if(screen) screen.scrollTop=0;
}
document.querySelectorAll(".bottom-nav button").forEach(b=>b.onclick=()=>go(b.dataset.page));
document.getElementById("backButton").onclick=goBack;
// フォーム入力中のEnterキーで意図せず登録・保存されないようにする
document.addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  const t=e.target;
  if(t && t.tagName!=="TEXTAREA" && t.closest("form")){
    e.preventDefault();
  }
});
function goBack(){
  const p=state.page;
  let target=state.returnPage||"home";
  if(p==="eventForm") target=state.eventId?"event":target;
  else if(p==="orderForm") target="event";
  else if(p==="productForm") target=state.productId?"product":target;
  else if(p==="scheduleForm") target=state.scheduleId?"schedule":target;
  else if(p==="saleItemForm") target="product";
  else if(p==="event"){
    target=state.returnPage||"events";
    // 予定詳細 → 関連イベント → 戻る の場合は、
    // 予定詳細に戻ったあと「予定詳細の戻り先」も復元する。
    if(state.returnPage==="schedule" && state.scheduleReturnPage){
      state.returnPage=state.scheduleReturnPage;
      state.scheduleReturnPage=null;
    }
  }
  else if(p==="product") target=state.returnPage||"products";
  else if(p==="schedule") target=state.returnPage||"schedules";
  else if(p==="calendar") target="home";
  else if(p==="settingsDisplay"||p==="settingsData") target="settings";
  else if(p==="settings") target=state.returnPage||"home";
  state.page=target;
  render();
}
document.getElementById("addButton").onclick=()=>document.getElementById("addModal").classList.remove("hidden");
function closeAdd(){document.getElementById("addModal").classList.add("hidden")}
function newEvent(prefillDate=""){closeAdd();state.returnPage=state.page;state.page="eventForm";state.eventId=null;state.prefillEventDate=prefillDate||"";render()}
function newProduct(prefillDate=""){closeAdd();state.returnPage=state.page;state.page="productForm";state.productId=null;state.prefillProductDate=prefillDate||"";render()}
function newOrder(){closeAdd();state.returnPage=state.page;state.page="orderForm";state.orderId=null;state.saleItemIndex=null;render()}
function newSchedule(prefillDate=""){closeAdd();state.returnPage=state.page;state.page="scheduleForm";state.scheduleId=null;state.prefillScheduleDate=prefillDate||"";render()}
function openEvent(id){state.returnPage=state.page;state.eventId=id;state.page="event";render()}
function home(){
 const today=new Date();
 today.setHours(0,0,0,0);
 const dayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
 const days=Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(d.getDate()+i);return {date:d,key:dayKey(d),offset:i}});
 const notifications=days.map(d=>({date:d.date,key:d.key,offset:d.offset,event:[],product:[],schedule:[]}));
 const timeLabel=v=>{if(!v)return"";const str=String(v);const m=str.match(/T(\d{2}:\d{2})/);return m?` ${m[1]}`:""};
 const add=(day,group,type,name,text,detailText="",entityId=null,kind="",productType="")=>{
   if(!day)return;
   notifications[day.offset][group].push({type,name,text,detail:detailText,entityId,kind,productType});
 };
 const dayFor=v=>{const k=String(v||"").slice(0,10);return notifications.find(d=>d.key===k)};

 // イベント：受付開始日時・受付終了日時・発表日・公演日
 events.forEach(e=>{
   (e.applications||[]).forEach(a=>{
     const startDay=dayFor(a.start); if(startDay)add(startDay,"event","受付開始",e.name,`受付開始${timeLabel(a.start)}`,a.name||"",e.id,"event");
     const endDay=dayFor(a.end); if(endDay)add(endDay,"event","受付終了",e.name,`受付終了${timeLabel(a.end)}`,a.name||"",e.id,"event");
     const announcementDay=dayFor(a.announcement); if(announcementDay)add(announcementDay,"event","発表日",e.name,"発表日",a.name||"",e.id,"event");
   });
   (e.performances||[]).forEach(p=>{
     const performanceDay=dayFor(p.date); if(performanceDay){const times=[p.open?`開場 ${p.open}`:"",p.start?`開演 ${p.start}`:""].filter(Boolean).join(" "); const performanceLabel=[p.venue?String(p.venue).trim():"",times].filter(Boolean).join(times?" / ":""); add(performanceDay,"event","公演日",`${e.name}${p.dayName?`（${p.dayName}）`:""}`,performanceLabel,"",e.id,"event");}
   });
 });

 // グッズ・販売：受注販売の期間、景品の発売日
 products.forEach(p=>{
   const type=p.type||"POP UP";
   if(type==="受注販売"){
     const startDay=dayFor(p.start); if(startDay)add(startDay,"product","受注販売開始日",p.name,"受注販売開始日",p.venue||"",p.id,"product",type);
     const endDay=dayFor(p.end); if(endDay)add(endDay,"product","受注販売終了日",p.name,"受注販売終了日",p.venue||"",p.id,"product",type);
   }else if(["一番くじ","UFOキャッチャー","その他景品"].includes(type)){
     const releaseDay=dayFor(p.start); if(releaseDay)add(releaseDay,"product","景品発売日",p.name,"景品発売日",p.venue||"",p.id,"product",type);
   }
 });
 // 予定：通常予定は予定欄、商品関連の予定はグッズ・販売欄
 schedules.forEach(x=>{
   const d=x.date||String(x.start||"").slice(0,10);
   const ed=x.endDate||d;
   if(!d)return;
   const times=[x.meetingTime?`集合 ${x.meetingTime}`:"",x.startTime?`開始 ${x.startTime}`:""].filter(Boolean).join(" / ");
   const group=x.type==="商品関連"?"product":"schedule";
   const location=[x.meetingPlace?`集合場所：${x.meetingPlace}`:"",x.related||""] .filter(Boolean).join(" / ");
   notifications.forEach(day=>{
     if(day.key>=d && day.key<=ed)add(day,group,"予定",x.name,times||"予定",location,x.id,"schedule");
   });
 });

 const renderNotifications=(list)=>{
   if(!list.length)return "";
   return `<div class="notification-list">${list.map(n=>{const colorClass=n.kind==="product"?(n.productType==="受注販売"?"notification-order":(["一番くじ","UFOキャッチャー","その他景品"].includes(n.productType)?"notification-prize":"notification-popup")):n.kind==="schedule"?"notification-schedule":"notification-event";return `<div class="notification-item ${colorClass}" ${n.entityId?`onclick="openHomeNotificationDetail(\'${n.kind}\',\'${n.entityId}\')"`:""}><div class="notification-main"><span class="notification-type">${esc(n.type)}</span><strong>${esc(n.name)}</strong>${n.kind==="product"&&n.productType?`<span class="badge">${esc(n.productType)}</span>`:""}</div><div class="notification-text">${esc(n.text)}${n.detail?`　${esc(n.detail)}`:""}</div></div>`}).join("")}</div>`;
 };

 // 期間中：現在時刻が受付・販売期間内のものを一覧表示
 const now=new Date();
 const currentPeriods=[];
 const addCurrentPeriod=(kind,entityId,name,periodType,start,end,detailText="")=>{
   if(!start||!end)return;
   const startDate=new Date(start);
   const endDate=new Date(end);
   if(Number.isNaN(startDate.getTime())||Number.isNaN(endDate.getTime()))return;
   if(now>=startDate && now<=endDate) currentPeriods.push({kind,entityId,name,periodType,start,end,detail:detailText});
 };
 events.forEach(e=>(e.applications||[]).forEach(a=>{
   if(a.start&&a.end)addCurrentPeriod("event",e.id,e.name,a.method||"受付",a.start,a.end,a.name||"");
 }));
 products.forEach(p=>{
   const type=p.type||"POP UP";
   if(["一番くじ","UFOキャッチャー","その他景品"].includes(type)){
     if(p.start){
       const days=Math.max(1,Number(appSettings.prizePeriods[type]||30));
       const startDate=new Date(`${p.start}T00:00:00`);
       const endDate=new Date(startDate);
       endDate.setDate(endDate.getDate()+days-1);
       const endKey=localDateKey(endDate);
       addCurrentPeriod("product",p.id,p.name,`${type}期間`,`${p.start}T00:00:00`,`${endKey}T23:59:59`,p.venue||"");
     }
   }else if(p.start&&p.end)addCurrentPeriod("product",p.id,p.name,`${type}期間`,`${p.start}T00:00:00`,`${p.end}T23:59:59`,p.venue||"");
 });
 currentPeriods.sort((a,b)=>{
   const aPrize=a.kind==="product"&&["一番くじ","UFOキャッチャー","その他景品"].includes((a.periodType||"").replace("期間",""));
   const bPrize=b.kind==="product"&&["一番くじ","UFOキャッチャー","その他景品"].includes((b.periodType||"").replace("期間",""));
   if(aPrize!==bPrize)return aPrize?1:-1;
   return new Date(a.end)-new Date(b.end);
 });
 const periodText=x=>{
   const s=new Date(x.start),e=new Date(x.end);
   const sameDay=s.toDateString()===e.toDateString();
   return sameDay?`${homeDate(x.start.slice(0,10))} ${x.start.includes("T")?x.start.slice(11,16):""} ～ ${x.end.includes("T")?x.end.slice(11,16):""}`:`${homeDate(x.start.slice(0,10))} ～ ${homeDate(x.end.slice(0,10))}`;
 };
 const daysUntilEnd=x=>{
   const endKey=x.end.slice(0,10);
   const todayKey=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0");
   const endDay=new Date(endKey+"T00:00:00");
   const todayDay=new Date(todayKey+"T00:00:00");
   return Math.max(0,Math.round((endDay-todayDay)/86400000));
 };
 const renderCurrentPeriods=()=>{
   if(!currentPeriods.length)return `<div class="period-empty">現在、期間中の受付・販売はありません。</div>`;
   return `<div class="period-list">${currentPeriods.map(x=>{const remaining=daysUntilEnd(x);const isPrizePeriod=x.kind==="product"&&["一番くじ","UFOキャッチャー","その他景品"].some(t=>x.periodType.startsWith(t));const remainingText=isPrizePeriod?"発売中":(remaining===0?"本日終了":"あと"+remaining+"日");const typeClass=x.kind==="product"?(x.periodType.includes("受注")?"order":x.periodType.includes("期間")?"sale":"product"):((x.periodType.includes("抽選")||x.periodType.includes("受付"))?"lottery":x.periodType.includes("先着")?"firstcome":"event");return `<div class="period-item period-${typeClass}" onclick="openHomeNotificationDetail('${x.kind}','${x.entityId}')"><div class="period-main"><span class="period-type">${esc(x.periodType)}</span><strong>${esc(x.name)}</strong><span class="period-remaining ${!isPrizePeriod&&remaining<=1?"urgent":""}">${remainingText}</span></div>${x.detail?`<div class="period-detail">${esc(x.detail)}</div>`:""}<div class="period-date">${esc(periodText(x))}</div></div>`}).join("")}</div>`;
 };
 const dayLabel=offset=>offset===0?"今日":`あと${offset}日`;
 title("ホーム");
 document.getElementById("screen").innerHTML=`
   <div class="home-hero"><div><div class="home-kicker">TODAY</div><h2>ホーム</h2><div class="sub">期間中の受付・販売と、これから7日間の予定を確認</div></div><div class="home-summary"><span>${currentPeriods.length}<small>期間中</small></span><span>${notifications.reduce((n,d)=>n+d.event.length+d.product.length+d.schedule.length,0)}<small>7日間</small></span></div></div>
   <div class="section home-period-title"><h2>期間中</h2><div class="home-period-sub">現在受付・販売中</div></div>
   ${renderCurrentPeriods()}
   <div class="section home-notification-title"><h2>直近7日</h2><div class="home-period-sub">${homeDate(days[0].key)} ～ ${homeDate(days[6].key)}</div></div>
   <div class="home-notification-list">
     ${(()=>{
       const d=notifications[0];
       const total=d.event.length+d.product.length+d.schedule.length;
       return `<div class="notification-today">
         <div class="notification-today-title"><span class="notification-today-badge">本日</span><strong>${homeDate(d.key)}</strong><span class="notification-today-count">${total}件</span></div>
         ${total?`${d.event.length?`<div class="notification-section"><h3>イベント</h3>${renderNotifications(d.event)}</div>`:""}${d.product.length?`<div class="notification-section"><h3>グッズ・販売</h3>${renderNotifications(d.product)}</div>`:""}${d.schedule.length?`<div class="notification-section"><h3>予定</h3>${renderNotifications(d.schedule)}</div>`:""}`:`<div class="notification-today-empty">本日の予定はありません。</div>`}
       </div>`;
     })()}
     ${notifications.slice(1).map(d=>{
       const total=d.event.length+d.product.length+d.schedule.length;
       if(!total)return "";
       return `<div class="notification-day"><div class="notification-day-title"><strong>${homeDate(d.key)}</strong><span>${dayLabel(d.offset)} ・ ${total}件</span></div>${d.event.length?`<div class="notification-section"><h3>イベント</h3>${renderNotifications(d.event)}</div>`:""}${d.product.length?`<div class="notification-section"><h3>グッズ・販売</h3>${renderNotifications(d.product)}</div>`:""}${d.schedule.length?`<div class="notification-section"><h3>予定</h3>${renderNotifications(d.schedule)}</div>`:""}</div>`;
     }).join("")}
   </div>
   ${notifications.every(d=>!(d.event.length+d.product.length+d.schedule.length))?`<div class="notification-empty">今後7日間に登録されている予定はありません。</div>`:""}`;
}
function applicationStatusSummary(e){
 const apps=e.applications||[];
 if(!apps.length)return `<span class="status status-none">申込なし</span>`;
 if(apps.length===1)return `<span class="status status-${statusClass(apps[0].status)}">${esc(apps[0].status||"未応募")}</span>`;
 const priority={"受付中":100,"応募予定":90,"受付前":80,"当落発表待ち":70,"応募済み":60,"当選":65,"落選":55,"受付終了":20,"未応募":10};
 const sorted=[...apps].sort((a,b)=>(priority[b.status]??0)-(priority[a.status]??0));
 const main=sorted[0], others=sorted.slice(1);
 const mainName=main.name?`（${esc(main.name)}）`:``;
 const applied=others.filter(a=>a.status==="応募済み");
 const appliedText=applied.length?`<span class="status status-applied">✓ ${applied.length}件対応済み</span>`:"";
 return `<span class="status status-${statusClass(main.status)}">${esc(main.status||"未応募")}${mainName}</span><span class="status-count">＋${apps.length-1}件</span>${appliedText}`;
}
function statusClass(status){return ({"受付中":"open","応募予定":"planned","受付前":"before","当落発表待ち":"waiting","応募済み":"applied","当選":"applied","落選":"closed","受付終了":"closed","未応募":"none"}[status]||"none")}
function applicationRows(e){
 const apps=e.applications||[];
 if(!apps.length)return `<div class="application-empty">申込はありません</div>`;
 return `<div class="application-cards">${apps.map(a=>{
   const selected=(a.performanceIds||[]).map(pid=>e.performances.find(x=>x.id===pid)).filter(Boolean);
   const rows=selected.length?selected:[null];
   return `<div class="application-card"><div class="application-card-title">${esc(a.name||"申込")}</div><div class="application-table"><div class="application-row application-head"><span>対象公演</span><span>期間</span><span>発表日</span><span>ステータス</span></div>${rows.map((p,i)=>{
     const pid=p?.id;
     const status=pid?(a.performanceStatuses||{})[pid]||a.status||"未応募":a.status||"未応募";
     const pname=p?(p.dayName||e.name):"未設定";
     return `<div class="application-row"><span>${esc(pname)}</span><span class="application-period">${a.start||a.end?`<span>${dt(a.start)}</span><span>～ ${dt(a.end)}</span>`:"―"}</span><span>${a.announcement?dt(a.announcement):"―"}</span><span class="status status-${statusClass(status)}">${esc(status)}</span></div>`;
   }).join("")}</div></div>`;
 }).join("")}</div>`;
}
function eventCard(e){return `<div class="item list-calendar-event" onclick="openEvent('${e.id}')"><div class="row"><h3>${esc(e.name)}</h3><span class="badge">${esc(e.type)}</span></div><p>公演 ${e.performances?.length||0}件　<span class="event-application-label">申込</span> ${(e.applications||[]).length}件</p><div class="application-summary application-summary-full">${applicationRows(e)}</div></div>`}
function eventsList(){
 const f=state.filters.events;
 const filtered=events.filter(e=>(!f.type||e.type===f.type)&&(!f.keyword||[e.name,e.performers,...(e.performances||[]).map(p=>p.performers||"")].join(" ").toLowerCase().includes(f.keyword.toLowerCase())));
 const today=new Date(); today.setHours(0,0,0,0);
 const nextMonthStart=new Date(today.getFullYear(),today.getMonth()+1,1);
 const getPerformanceDates=e=>(e.performances||[]).map(p=>p.date).filter(Boolean).map(d=>{const x=new Date(d+"T00:00:00");x.setHours(0,0,0,0);return x;});
 const current=[],future=[],past=[];
 filtered.forEach(e=>{const dates=getPerformanceDates(e);const hasCurrent=dates.some(d=>d>=today&&d<nextMonthStart);const hasFuture=dates.some(d=>d>=nextMonthStart);if(hasCurrent)current.push(e);else if(hasFuture)future.push(e);else past.push(e)});
 const nearestDate=e=>{const dates=getPerformanceDates(e);return dates.length?Math.min(...dates.map(d=>Math.abs(d-today))):Infinity};
 current.sort((a,b)=>nearestDate(a)-nearestDate(b));future.sort((a,b)=>nearestDate(a)-nearestDate(b));past.sort((a,b)=>nearestDate(a)-nearestDate(b));
 const pastMonthKey=e=>{const dates=getPerformanceDates(e).sort((a,b)=>a-b);const d=dates[dates.length-1];return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`:"unknown"};
 const pastGroups={};past.forEach(e=>{const k=pastMonthKey(e);(pastGroups[k]||(pastGroups[k]=[])).push(e)});
 const monthLabel=k=>{if(k==="unknown")return "日付未設定";const [yy,mm]=k.split("-");return `${yy}年${Number(mm)}月`};
 title("イベント一覧");
 const eventPastMonths=state.eventPastMonths||{};
 const toggleEventPastMonth=k=>{state.eventPastMonths=state.eventPastMonths||{};state.eventPastMonths[k]=state.eventPastMonths[k]!==true;render()};
 window.toggleEventPastMonth=toggleEventPastMonth;
 const visibility=state.eventSections||{current:true,future:false,past:false};
 const toggleSection=key=>{state.eventSections=state.eventSections||{current:true,future:false,past:false};state.eventSections[key]=!state.eventSections[key];render()};
 const block=(key,label,list,cls)=>{if(!list.length)return "";const open=visibility[key]!==false;let content="";if(open){if(key==="past")content=Object.keys(pastGroups).sort((a,b)=>b.localeCompare(a)).map(k=>{const monthOpen=eventPastMonths[k]===true;return `<div class="past-month-group"><button type="button" class="past-month-heading ${monthOpen?"open":""}" onclick="toggleEventPastMonth('${k}')" aria-expanded="${monthOpen}"><strong>${monthLabel(k)}</strong><span class="count">${pastGroups[k].length}件</span><span class="past-month-toggle">${monthOpen?"−":"＋"}</span></button>${monthOpen?`<div class="list">${pastGroups[k].map(eventCard).join("")}</div>`:""}</div>`}).join("");else content=`<div class="list">${list.map(eventCard).join("")}</div>`}return `<div class="event-list-block ${cls}"><div class="section event-list-heading"><h2>${label}</h2><div class="section-actions"><span class="count">${list.length}件</span><button class="section-toggle ${open?"open":""}" onclick="toggleEventSection('${key}')" aria-label="${open?"一覧を閉じる":"一覧を表示"}">${open?"−":"＋"}</button></div></div>${content}</div>`};
 window.toggleEventSection=toggleSection;
 document.getElementById("screen").innerHTML=`<div class="section list-section list-section-events"><h2>イベント</h2><div class="section-actions"><span class="count">${filtered.length}件</span><button class="filter-button ${f.type||f.keyword?"active":""}" onclick="openFilter('events')">☰ 絞り込み</button></div></div>${block("current","今月の予定",current,"current-events")}${block("future","来月以降の予定",future,"future-events")}${block("past","過去の予定",past,"past-events")}${!filtered.length?`<div class="empty">${events.length?"条件に一致するイベントがありません。":"イベントがありません。"}</div>`:""}`;
}

function eventDetail(){
 const e=events.find(x=>x.id==state.eventId);
 if(!e){go("events");return}
 title("イベント詳細",true);
 const apps=e.applications||[];
 document.getElementById("screen").innerHTML=`
 <div class="hero">
   <div class="row"><span class="badge">${esc(e.type)}</span></div>
   <h2>${esc(e.name)}</h2>
 </div>
 <div class="card">${detail("イベント名",e.name)}${detail("イベント種別",e.type)}${urlDetail("イベントURL",e.url)}${detail("メモ",e.memo)}</div>
 <div class="section"><h2>公演日</h2><span class="count">${e.performances.length}件</span></div>
 ${e.performances.map((p,i)=>`<div class="card" style="margin-bottom:8px">
   <div class="row"><b class="performance-heading">公演 ${i+1}${p.dayName?`：${esc(p.dayName)}`:""}</b><span class="badge">${date(p.date)}</span></div>
   ${detail("出演者",p.performers)}${detail("開場",p.open)}${detail("開演",p.start)}${detail("会場",p.venue)}${detail("メモ",p.memo)}
 </div>`).join("")}
 <div class="section"><h2>申込</h2><span class="count">${apps.length}件</span></div>
 ${apps.length?`<div class="list">${apps.map(a=>`<div class="item">
   <div class="row"><h3>${esc(a.name||"申込")}</h3><span class="badge">${esc(a.method)}</span></div>
   <p>${dt(a.start)} ～ ${dt(a.end)}</p>
   ${applicationPerformanceText(e,a)}
   ${a.ticketSiteName?`<div style="margin-top:8px">${detail("チケットサイト",a.ticketSiteName)}</div>`:""}
   <div class="actions">
     <button class="secondary" onclick="editApplication('${e.id}','${a.id}')">編集</button>
     <button class="danger" onclick="deleteApplication('${e.id}','${a.id}')">削除</button>
   </div>
 </div>`).join("")}</div>`:`<div class="empty">このイベントの申込はありません。</div>`}
 <button class="primary" style="margin-top:10px" onclick="addApplication('${e.id}')">＋ このイベントに申込を追加</button>
 <div class="actions"><button class="secondary" onclick="editEvent('${e.id}')">編集</button><button class="danger" onclick="deleteEvent('${e.id}')">イベントを削除</button></div>`;
}

function editEvent(id){state.eventId=id;state.page="eventForm";render()}
function eventForm(){const e=events.find(x=>x.id==state.eventId)||{name:"",type:"ライブ",performers:"",url:"",memo:"",performances:[{date:state.prefillEventDate||""}]};title(state.eventId?"イベント編集":"イベント登録",true);document.getElementById("screen").innerHTML=`<form class="form" id="eventForm"><div class="group"><label>イベント名 <b class="req">必須</b></label><input class="input" name="name" required value="${esc(e.name)}"></div><div class="group"><label>イベント種別</label><select class="input" name="type">${["ライブ","舞台","イベント","その他"].map(x=>`<option ${x==e.type?"selected":""}>${x}</option>`).join("")}</select></div><div class="group"><label>イベントURL</label><input class="input" name="url" type="url" value="${esc(e.url)}"></div><div class="group"><label>メモ</label><textarea class="input textarea" name="memo">${esc(e.memo)}</textarea></div><div class="section"><h2>公演日</h2><span class="count">1件以上必須</span></div><div id="performanceList">${e.performances.length?e.performances.map(perf).join(""):perf({})}</div><button type="button" class="secondary" onclick="addPerformance()">＋ 公演日を追加</button><button class="primary" style="margin-top:10px">${state.eventId?"変更を保存":"イベントを登録"}</button></form>`;document.getElementById("eventForm").onsubmit=saveEvent}
function perf(p={}){return `<div class="performance"><div class="performance-title"><b>公演日</b><button type="button" class="remove" onclick="this.closest('.performance').remove()">削除</button></div><div class="group"><label>日付 <b class="req">必須</b></label><input class="input" data-p="date" type="date" required value="${esc(p.date||"")}"></div><div class="group"><label>名前（例：DAY1、DAY2）</label><input class="input" data-p="dayName" value="${esc(p.dayName||"")}"></div><div class="group"><label>出演者</label><input class="input" data-p="performers" value="${esc(p.performers||"")}"></div><div class="time-grid"><div class="group"><label>開場時間</label><input class="input" data-p="open" type="time" value="${esc(p.open||"")}"></div><div class="group"><label>開演時間</label><input class="input" data-p="start" type="time" value="${esc(p.start||"")}"></div></div><div class="group"><label>会場</label><input class="input" data-p="venue" value="${esc(p.venue||"")}"></div><div class="group"><label>メモ</label><textarea class="input textarea" data-p="memo">${esc(p.memo||"")}</textarea></div></div>`}
function addPerformance(){document.getElementById("performanceList").insertAdjacentHTML("beforeend",perf({}))}
function saveEvent(ev){ev.preventDefault();const f=new FormData(ev.target),rows=[...document.querySelectorAll(".performance")];if(!rows.length){alert("公演日は1件以上必要です");return}const oldEvent=state.eventId?events.find(x=>x.id==state.eventId):null;const performances=rows.map((r,i)=>{const p={};r.querySelectorAll("[data-p]").forEach(x=>p[x.dataset.p]=x.value);p.id=oldEvent?.performances?.[i]?.id||id();return p});if(performances.some(x=>!x.date)){alert("公演日の日付は必須です");return}const d={name:String(f.get("name")).trim(),type:f.get("type"),performers:"",url:String(f.get("url")||""),memo:String(f.get("memo")||""),performances};if(state.eventId){Object.assign(events.find(x=>x.id==state.eventId),d)}else{const e={id:id(),...d,applications:[]};events.unshift(e);state.eventId=e.id}save(KEY.events,events);state.page="event";render()}
function deleteEvent(i){if(!confirm("イベントを削除しますか？"))return;events=events.filter(e=>e.id!=i);save(KEY.events,events);go("events")}
function addApplication(eventId){state.eventId=eventId;state.orderId=null;state.page="orderForm";render()}
function editApplication(eventId,appId){state.eventId=eventId;state.orderId=appId;state.page="orderForm";render()}
function applicationPerformanceText(e,a){
 const ids=Array.isArray(a.performanceIds)?a.performanceIds:[];
 if(!ids.length)return `<div class="application-performance"><small>対象公演：未設定</small></div>`;
 return `<div class="application-performance"><small>対象公演ごとの結果</small><div class="performance-result-list">${ids.map(pid=>{const p=e.performances.find(x=>x.id===pid);if(!p)return "";const status=(a.performanceStatuses||{})[pid]||a.status||"未応募";return `<div class="performance-result-item"><span>${esc(p.dayName||e.name)}</span><span class="status status-${statusClass(status)}">${esc(status)}</span></div>`}).join("")}</div></div>`;
}
function orderForm(){
 const e=events.find(x=>x.id==state.eventId);
 if(!e){go("events");return}
 const a=(e.applications||[]).find(x=>x.id==state.orderId)||{name:"",method:"抽選",ticketSiteName:"",start:"",end:"",announcement:"",status:"未応募",quantity:1,payment:"",memo:"",performanceIds:e.performances.map(p=>p.id),performanceStatuses:{}};
 const selectedIds=Array.isArray(a.performanceIds)?a.performanceIds:[];
 const statuses=a.performanceStatuses&&typeof a.performanceStatuses==="object"?a.performanceStatuses:{};
 title(state.orderId?"申込編集":"申込登録",true);
 document.getElementById("screen").innerHTML=`<form class="form" id="orderForm"><div class="card" style="margin-bottom:12px">${detail("対象イベント",e.name)}</div><div class="group"><label>名称 <b class="req">必須</b></label><input class="input" name="name" required placeholder="例：1次応募、2次応募、一般販売" value="${esc(a.name)}"></div><div class="group"><label>対象公演 <b class="req">1件以上</b></label><div class="performance-select-list">${e.performances.map((p,i)=>`<label class="event-check"><input type="checkbox" name="performanceIds" value="${esc(p.id)}" ${selectedIds.includes(p.id)?"checked":""}><span><b>${esc(p.dayName||e.name)}</b><small>${date(p.date)}${p.venue?`　${esc(p.venue)}`:""}</small></span></label>`).join("")}</div></div><div class="group"><label>公演ごとの結果・ステータス</label><div id="performanceStatusList" class="performance-status-editor"></div></div><div class="group"><label>申込方式</label><select class="input" name="method">${["抽選","先着"].map(x=>`<option ${x==a.method?"selected":""}>${x}</option>`).join("")}</select></div><div class="group"><label>チケットサイト名</label><input class="input" name="ticketSiteName" placeholder="例：イープラス、チケットぴあ" value="${esc(a.ticketSiteName||"")}"></div><div class="time-grid"><div class="group"><label>受付開始日時</label><input class="input compact-order-date" name="start" type="datetime-local" value="${esc(a.start)}"></div><div class="group"><label>受付終了日時</label><input class="input compact-order-date" name="end" type="datetime-local" value="${esc(a.end)}"></div></div><div class="group announcement-group ${a.method==="抽選"?"":"hidden"}"><label>発表日</label><input class="input compact-order-date" name="announcement" type="date" value="${esc(a.announcement||"")}"></div><div class="group"><label>全体ステータス</label><select class="input" name="status">${["未応募","応募予定","受付前","受付中","受付終了","応募済み","当選","落選"].map(x=>`<option ${x==a.status?"selected":""}>${x}</option>`).join("")}</select><small class="form-note">公演ごとの結果を設定すると、こちらは全体の目安として扱われます。</small></div><div class="group"><label>数量</label><input class="input" name="quantity" type="number" min="1" value="${a.quantity||1}"></div><div class="group"><label>支払情報</label><select class="input" name="payment"><option value="">未選択</option>${["クレジットカード","コンビニ決済","スマホ決済","その他"].map(x=>`<option value="${x}" ${x==a.payment?"selected":""}>${x}</option>`).join("")}</select></div><div class="group"><label>メモ</label><textarea class="input textarea" name="memo">${esc(a.memo)}</textarea></div><button class="primary">保存</button></form>`;
 const form=document.getElementById("orderForm");
 const statusList=document.getElementById("performanceStatusList");
 const renderPerformanceStatuses=()=>{
   const ids=[...form.querySelectorAll('[name="performanceIds"]:checked')].map(x=>x.value);
   statusList.innerHTML=ids.map(pid=>{const p=e.performances.find(x=>x.id===pid);const current=statuses[pid]||a.status||"未応募";return `<div class="performance-status-row"><span><b>${esc(p?.dayName||e.name)}</b><small>${p?date(p.date):""}${p?.venue?`　${esc(p.venue)}`:""}</small></span><select class="input" data-performance-status="${esc(pid)}">${["未応募","応募予定","受付前","受付中","受付終了","応募済み","当選","落選"].map(x=>`<option ${x===current?"selected":""}>${x}</option>`).join("")}</select></div>`}).join("");
 };
 form.querySelectorAll('[name="performanceIds"]').forEach(x=>x.addEventListener("change",renderPerformanceStatuses));
 renderPerformanceStatuses();
 const method=form.querySelector('[name="method"]');const announcementGroup=form.querySelector(".announcement-group");method.addEventListener("change",()=>announcementGroup.classList.toggle("hidden",method.value!=="抽選"));
 form.onsubmit=saveApplication
}
function saveApplication(ev){
 ev.preventDefault();
 const e=events.find(x=>x.id==state.eventId),f=new FormData(ev.target),performanceIds=f.getAll("performanceIds");
 const performanceStatuses={};
 ev.target.querySelectorAll("[data-performance-status]").forEach(x=>performanceStatuses[x.dataset.performanceStatus]=x.value);
 const statusValues=performanceIds.map(pid=>performanceStatuses[pid]).filter(Boolean);
 const overallStatus=statusValues.length?statusValues.every(x=>x==="当選")?"当選":statusValues.every(x=>x==="落選")?"落選":(statusValues.includes("応募済み")?"応募済み":statusValues[0]):f.get("status");
 const d={name:String(f.get("name")).trim(),method:f.get("method"),ticketSiteName:String(f.get("ticketSiteName")||"").trim(),start:f.get("start"),end:f.get("end"),announcement:f.get("method")==="抽選"?f.get("announcement"):"",status:overallStatus,quantity:Number(f.get("quantity")||1),payment:String(f.get("payment")||""),memo:String(f.get("memo")||""),performanceIds,performanceStatuses};
 if(!d.name){alert("名称を入力してください");return}
 if(!performanceIds.length){alert("対象公演を1件以上選択してください");return}
 e.applications=e.applications||[];
 if(state.orderId)Object.assign(e.applications.find(a=>a.id==state.orderId),d);else e.applications.push({id:id(),...d});
 save(KEY.events,events);state.page="event";render()
}
function deleteApplication(eid,aid){if(!confirm("この申込を削除しますか？"))return;const e=events.find(x=>x.id==eid);e.applications=e.applications.filter(a=>a.id!=aid);save(KEY.events,events);render()}

function productsList(){
 const f=state.filters.products;
 const list=products.filter(p=>(!f.type||((p.type||"POP UP")===f.type))&&(!f.keyword||[p.name,p.venue].join(" ").toLowerCase().includes(f.keyword.toLowerCase())));
 const today=new Date(); today.setHours(0,0,0,0);
 const weekLater=new Date(today); weekLater.setDate(weekLater.getDate()+7);
 const soon=[],comfortable=[],expired=[],general=[],prizePlanned=[],prizeUnsecured=[],prizeUnsecuredLong=[],prizeSecured=[],purchased=[];
 list.forEach(p=>{
   const type=p.type||"POP UP";
   if(["一番くじ","UFOキャッチャー","その他景品"].includes(type)){
     if(p.purchased){prizeSecured.push(p);return}
     const release=p.start?new Date(p.start+"T00:00:00"):null;
     if(release && !isNaN(release) && release < today){
       const oneMonthLater=new Date(release);
       const releaseDate=oneMonthLater.getDate();
       oneMonthLater.setMonth(oneMonthLater.getMonth()+1);
       // 月末日（1/31など）でも、翌月の同日が存在しない場合は翌月末を基準にする
       if(oneMonthLater.getDate()!==releaseDate) oneMonthLater.setDate(0);
       if(today >= oneMonthLater) prizeUnsecuredLong.push(p);
       else prizeUnsecured.push(p);
     }else prizePlanned.push(p);
     return
   }
   if(p.purchased){purchased.push(p);return}
   if(type==="通常販売"){general.push(p);return}
   const end=p.end?new Date(p.end+"T00:00:00"):null;
   if(!end||isNaN(end)){comfortable.push(p);return}
   if(end<today) expired.push(p);
   else if(end<=weekLater) soon.push(p);
   else comfortable.push(p);
 });
 const endTime=p=>p.end?new Date(p.end+"T00:00:00").getTime():Infinity;
 [soon,comfortable,expired,general,purchased,prizePlanned,prizeUnsecured,prizeUnsecuredLong,prizeSecured].forEach(a=>a.sort((x,y)=>endTime(x)-endTime(y)));
 title("グッズ・販売");
 const displayMode=state.productDisplayMode||"goods";
 const sectionDefaults={soon:true,comfortable:false,expired:false,general:false,purchased:false,prizePlanned:true,prizeUnsecured:true,prizeUnsecuredLong:false,prizeSecured:false};
 const visibility={...sectionDefaults,...(state.productSections||{})};
 const toggleSection=key=>{state.productSections={...sectionDefaults,...(state.productSections||{})};state.productSections[key]=!state.productSections[key];render()};
 const card=p=>`<div class="item list-calendar-product ${["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?"list-calendar-prize":p.type==="受注販売"?"list-calendar-order":p.type==="POP UP"?"list-calendar-popup":"list-calendar-sale"}" onclick="openProduct('${p.id}')"><div class="row"><h3>${esc(p.name)}</h3><div style="display:flex;gap:6px;align-items:center"><span class="badge">${esc(p.type||"POP UP")}</span>${p.purchased?`<span class="status status-done">済</span>`:""}</div></div><p>${["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?`発売日 ${p.start?date(p.start):"-"}`:`${p.start?date(p.start):"-"} ～ ${p.end?date(p.end):"-"}`}</p><p>欲しい商品 ${p.items?.length||0}件</p></div>`;
 const block=(key,label,items,cls)=>{if(!items.length)return "";const open=visibility[key]!==false;return `<div class="event-list-block product-list-block ${cls}"><div class="section event-list-heading"><h2>${label}</h2><div class="section-actions"><span class="count">${items.length}件</span><button class="section-toggle ${open?"open":""}" onclick="toggleProductSection('${key}')" aria-label="${open?"一覧を閉じる":"一覧を表示"}">${open?"−":"＋"}</button></div></div>${open?`<div class="list">${items.map(card).join("")}</div>`:""}</div>`};
 window.toggleProductSection=toggleSection;
 const goodsBlocks=block("soon","期限が一週間以内",soon,"soon-products")+block("comfortable","期限に余裕がある",comfortable,"comfortable-products")+block("expired","期限が過ぎたもの",expired,"expired-products")+block("general","一般販売",general,"general-products")+block("purchased","購入済み",purchased,"purchased-products");
 const prizeBlocks=block("prizePlanned","発売予定",prizePlanned,"prize-products")+block("prizeUnsecured","発売済み・未確保",prizeUnsecured,"prize-products")+block("prizeUnsecuredLong","未確保",prizeUnsecuredLong,"prize-products")+block("prizeSecured","確保済み",prizeSecured,"prize-products");
 const activeList=displayMode==="prize"?[...prizePlanned,...prizeUnsecured,...prizeUnsecuredLong,...prizeSecured]:[...soon,...comfortable,...expired,...general,...purchased];
 const emptyText=displayMode==="prize"?(products.some(p=>["一番くじ","UFOキャッチャー","その他景品"].includes(p.type))?"条件に一致する景品がありません。":"景品がありません。"):(products.some(p=>!["一番くじ","UFOキャッチャー","その他景品"].includes(p.type||"POP UP"))?"条件に一致するグッズ・販売情報がありません。":"グッズ・販売情報がありません。");
 document.getElementById("screen").innerHTML=`<div class="section list-section list-section-products"><h2>グッズ・販売</h2><div class="section-actions"><span class="count">${activeList.length}件</span><button class="filter-button product-filter-button ${f.type||f.keyword?"active":""}" onclick="openFilter('products')">☰ 絞り込み</button></div></div><div class="product-controls-under-title"><div class="product-category-switch"><button type="button" class="product-category-button ${displayMode==="goods"?"active":""}" onclick="switchProductDisplay('goods')">グッズ・販売</button><button type="button" class="product-category-button ${displayMode==="prize"?"active":""}" onclick="switchProductDisplay('prize')">景品</button></div></div>${displayMode==="goods"?goodsBlocks:prizeBlocks}${!activeList.length?`<div class="empty">${emptyText}</div>`:""}`;
 window.switchProductDisplay=(mode)=>{state.productDisplayMode=mode;render()};
}
function wishlistList(){
 const items=[];
 products.forEach(p=>(p.items||[]).forEach((it,index)=>items.push({p,it,index})));
 title("欲しい商品");
 const card=x=>`<div class="item list-calendar-product ${["一番くじ","UFOキャッチャー","その他景品"].includes(x.p.type)?"list-calendar-prize":x.p.type==="受注販売"?"list-calendar-order":x.p.type==="POP UP"?"list-calendar-popup":"list-calendar-sale"}"><div class="row"><div><h3>${esc(x.it.name)}</h3><p style="margin-top:4px">${esc(x.p.name)} <span class="badge">${esc(x.p.type||"")}</span></p></div></div><p>${x.it.price?`¥${Number(x.it.price).toLocaleString()}`:""}${x.it.quantity?`${x.it.price?"　":""}数量：${x.it.quantity}`:""}</p>${x.p.start?`<p>${["一番くじ","UFOキャッチャー","その他景品"].includes(x.p.type)?"発売日":"開始日"}：${date(x.p.start)}</p>`:""}<div class="actions"><button class="secondary" onclick="openProduct('${x.p.id}')">詳細</button><button class="secondary" onclick="editSaleItem('${x.p.id}',${x.index})">編集</button></div></div>`;
 const block=(label,list)=>list.length?`<div class="event-list-block product-list-block"><div class="section event-list-heading"><h2>${label}</h2><span class="count">${list.length}件</span></div><div class="list">${list.map(card).join("")}</div></div>`:"";
 document.getElementById("screen").innerHTML=`<div class="section list-section"><div><h2>欲しい商品</h2><p class="sub">一番くじ・UFOキャッチャーなどの欲しい景品をまとめて管理できます。</p></div><button class="secondary" style="width:auto" onclick="go('products')">商品一覧</button></div>${block("欲しい商品",items)}${!items.length?`<div class="empty">欲しい商品がありません。販売情報の「欲しい商品」から追加できます。</div>`:""}`;
}

function openProduct(i){state.returnPage="products";state.productId=i;state.page="product";render()}
function openHomeNotificationDetail(kind,id){state.returnPage="home";if(kind==="event"){state.eventId=id;state.page="event"}else if(kind==="product"){state.productId=id;state.page="product"}else if(kind==="schedule"){state.scheduleId=id;state.page="schedule"}else{return}render()}

function toggleProductPurchased(id, checked){
 const p=products.find(x=>x.id==id);
 if(!p)return;
 p.purchased=!!checked;
 save(KEY.products,products);
 render();
}
function productDetail(){
 const p=products.find(x=>x.id==state.productId);
 if(!p){go("products");return}
 title("販売詳細",true);
 document.getElementById("screen").innerHTML=`
 <div class="hero">
   <div class="row"><span class="badge">${esc(p.type||"POP UP")}</span></div>
   <h2>${esc(p.name)}</h2>
   <div class="sub">${p.start?date(p.start):"-"} ～ ${p.end?date(p.end):"-"}</div>
 </div>
 <div class="card">${detail("販売名",p.name)}${detail("販売種別",p.type)}${detail(["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?"発売日":"開始日",p.start?date(p.start):"")}${["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?detail("価格",p.price!=null?`¥${Number(p.price).toLocaleString()}`:"-"):""}${!["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?detail("終了日",p.end?date(p.end):""):""}${detail("会場",p.venue)}${urlDetail("URL",p.url)}${detail("メモ",p.memo)}<div style="margin-top:14px;padding-top:14px;border-top:1px solid #eee"><label style="display:flex;align-items:center;gap:10px;font-weight:700;cursor:pointer"><input type="checkbox" ${p.purchased?"checked":""} onchange="toggleProductPurchased('${p.id}',this.checked)" style="width:20px;height:20px">購入済み${p.type==="通常販売"&&p.purchased?`<span class="status status-done" style="margin-left:auto">済</span>`:""}</label></div></div>
 <div class="section"><h2>欲しい商品</h2><span class="count">${p.items?.length||0}件</span></div>
 ${p.items?.length?`<div class="list">${p.items.map((it,i)=>`
   <div class="item">
     <div class="row"><h3>${esc(it.name)}</h3>${it.price?`<b style="font-size:10px">¥${Number(it.price).toLocaleString()}</b>`:""}</div>
     <p>数量：${it.quantity||1}</p>
     ${it.url?`<p><a class="detail-link" href="${esc(/^\w[\w+.-]*:\/\//.test(it.url)?it.url:`https://${it.url}`)}" target="_blank" rel="noopener noreferrer">${esc(it.url)}</a></p>`:""}
     ${it.memo?`<p>${esc(it.memo)}</p>`:""}
     <div class="actions"><button class="secondary" onclick="editSaleItem('${p.id}',${i})">編集</button><button class="danger" onclick="deleteSaleItem('${p.id}',${i})">削除</button></div>
   </div>`).join("")}</div>`:
   `<div class="empty">欲しい商品がありません。</div>`}
 <button class="primary" style="margin-top:10px" onclick="addSaleItem('${p.id}')">＋ 欲しい商品を追加</button>
 <div class="actions"><button class="secondary" onclick="editProduct('${p.id}')">編集</button><button class="danger" onclick="deleteProduct('${p.id}')">販売情報を削除</button></div>`;
}
function editProduct(i){
  state.productId=i;
  state.returnPage=state.returnPage||"products";
  state.page="productForm";
  render();
}
function productForm(){
 const p=products.find(x=>x.id==state.productId)||{name:"",type:"POP UP",start:state.prefillProductDate||"",end:"",venue:"",url:"",memo:"",price:null,items:[]};
 title(state.productId?"販売情報編集":"POP UP・販売登録",true);
 document.getElementById("screen").innerHTML=`
 <form class="form" id="productForm">
 <div class="group"><label>販売名 <b class="req">必須</b></label><input class="input" name="name" required placeholder="例：○○ POP UP STORE" value="${esc(p.name)}"></div>
 <div class="group"><label>販売種別</label><select class="input" name="type">${["POP UP","受注販売","通常販売","一番くじ","UFOキャッチャー","その他景品"].map(x=>`<option ${x==p.type?"selected":""}>${x}</option>`).join("")}</select></div>
 <div class="time-grid"><div class="group"><label id="productStartLabel">${["一番くじ","UFOキャッチャー","その他景品"].includes(p.type)?"発売日":"開始日"}</label><input class="input product-form-date" name="start" type="date" value="${esc(p.start)}"></div><div class="group" id="productEndGroup"><label>終了日</label><input class="input product-form-date" name="end" type="date" value="${esc(p.end)}"></div></div>
 <div class="group hidden" id="productPriceGroup"><label>価格</label><input class="input" name="price" type="number" min="0" placeholder="例：750" value="${p.price??""}"></div>
 <div class="group"><label>会場</label><input class="input" name="venue" placeholder="POP UP会場など" value="${esc(p.venue)}"></div>
 <div class="group"><label>販売URL</label><input class="input" name="url" type="url" value="${esc(p.url)}"></div>
 <div class="group"><label>メモ</label><textarea class="input textarea" name="memo">${esc(p.memo)}</textarea></div>
 <button class="primary">保存</button>
 </form>`;
 const productFormEl=document.getElementById("productForm");
 const productTypeEl=productFormEl.querySelector('[name="type"]');
 const updateProductDateFields=()=>{const prize=["一番くじ","UFOキャッチャー","その他景品"].includes(productTypeEl.value);document.getElementById("productStartLabel").textContent=prize?"発売日":"開始日";document.getElementById("productEndGroup").classList.toggle("hidden",prize);document.getElementById("productPriceGroup").classList.toggle("hidden",!prize);if(prize)productFormEl.querySelector('[name="end"]').value=""};
 productTypeEl.addEventListener("change",updateProductDateFields); updateProductDateFields();
 productFormEl.onsubmit=saveProduct;
}
function saveProduct(ev){
 ev.preventDefault();
 const f=new FormData(ev.target),d={
   name:String(f.get("name")).trim(),type:f.get("type"),start:f.get("start"),end:f.get("end"),
   venue:String(f.get("venue")||""),url:String(f.get("url")||""),memo:String(f.get("memo")||""),price:f.get("price")!==null&&f.get("price")!==""?Number(f.get("price")):null
 };
 if(!d.name){alert("販売名を入力してください");return}
 if(state.productId) Object.assign(products.find(p=>p.id==state.productId),d);
 else {const p={id:id(),...d,items:[]};products.unshift(p);state.productId=p.id}
 save(KEY.products,products);
state.page="product";
render();
}
function addSaleItem(pid){
  state.productId=pid;
  state.saleItemIndex=null;
  state.page="saleItemForm";
  render();
}
function editSaleItem(pid,index){
  state.productId=pid;
  state.saleItemIndex=index;
  state.page="saleItemForm";
  render();
}
function saleItemForm(){
 const p=products.find(x=>x.id==state.productId);
 if(!p){go("products");return}
 const editing=Number.isInteger(state.saleItemIndex) && state.saleItemIndex>=0 && p.items?.[state.saleItemIndex];
 const isPrize=["一番くじ","UFOキャッチャー","その他景品"].includes(p.type);
 const it=editing?p.items[state.saleItemIndex]:{name:"",price:"",quantity:1,url:"",memo:"",wishlistStatus:"欲しい",priority:3};
 title(editing?"欲しい商品を編集":"欲しい商品を追加",true);
 document.getElementById("screen").innerHTML=`
 <form class="form" id="saleItemForm">
   <div class="card" style="margin-bottom:12px">${detail("販売情報",p.name)}</div>
   <div class="group"><label>商品名 <b class="req">必須</b></label><input class="input" name="name" required placeholder="例：Tシャツ ブラック M" value="${esc(it.name||"")}"></div>
   ${!isPrize?`<div class="group"><label>価格</label><input class="input" name="price" type="number" min="0" placeholder="例：5500" value="${it.price??""}"></div>`:""}
   <div class="group"><label>数量</label><input class="input" name="quantity" type="number" min="1" value="${it.quantity||1}"></div>
   <div class="group"><label>商品URL</label><input class="input" name="url" type="url" placeholder="https://..." value="${esc(it.url||"")}"></div>
   <div class="group"><label>メモ</label><textarea class="input textarea" name="memo" placeholder="サイズ・カラーなど">${esc(it.memo||"")}</textarea></div>
   <button class="primary">${editing?"変更を保存":"商品を追加"}</button>
 </form>`;
 document.getElementById("saleItemForm").onsubmit=saveSaleItem;
}
function saveSaleItem(ev){
 ev.preventDefault();
 const p=products.find(x=>x.id==state.productId);
 if(!p)return;
 const isPrize=["一番くじ","UFOキャッチャー","その他景品"].includes(p.type);
 const f=new FormData(ev.target),name=String(f.get("name")||"").trim();
 if(!name){alert("商品名を入力してください");return}
 p.items=p.items||[];
 const item={id:id(),name,price:isPrize?0:Number(f.get("price")||0),quantity:Math.max(1,Number(f.get("quantity")||1)),memo:String(f.get("memo")||""),url:String(f.get("url")||"")};
 if(Number.isInteger(state.saleItemIndex) && state.saleItemIndex>=0 && p.items[state.saleItemIndex]){
   item.id=p.items[state.saleItemIndex].id||item.id;
   p.items[state.saleItemIndex]=item;
 }else{p.items.push(item)}
 save(KEY.products,products);
state.saleItemIndex=null;
state.page="product";
render();
}
function deleteSaleItem(pid,index){
 if(!confirm("この商品を削除しますか？"))return;
 const p=products.find(x=>x.id==pid);p.items.splice(index,1);save(KEY.products,products);render();
}
function deleteProduct(i){if(!confirm("この販売情報を削除しますか？"))return;products=products.filter(p=>p.id!=i);save(KEY.products,products);go("products")}
function scheduleList(){
 const f=state.filters.schedules;
 const list=schedules.filter(x=>(!f.type||x.type===f.type)&&(!f.keyword||[x.name,x.related,x.memo].join(" ").toLowerCase().includes(f.keyword.toLowerCase())));
 const today=new Date(); today.setHours(0,0,0,0);
 const nextMonthStart=new Date(today.getFullYear(),today.getMonth()+1,1);
 const getDate=s=>{if(s.date){const d=new Date(s.date+"T00:00:00");d.setHours(0,0,0,0);return d}if(s.start){const d=new Date(String(s.start).replace("T"," "));d.setHours(0,0,0,0);return d}return null};
 const getEndDate=s=>{const v=s.endDate||s.date||String(s.start||"").slice(0,10);if(!v)return null;const d=new Date(v+"T00:00:00");d.setHours(0,0,0,0);return d};
 const current=[],future=[],past=[];
 list.forEach(s=>{const d=getDate(s),ed=getEndDate(s);if(!d){past.push(s);return}if(ed>=today&&d<nextMonthStart)current.push(s);else if(d>=nextMonthStart)future.push(s);else past.push(s)});
 const sortByDate=(a,b)=>(getDate(a)||new Date(8640000000000000))-(getDate(b)||new Date(8640000000000000));
 current.sort(sortByDate);future.sort(sortByDate);past.sort((a,b)=>sortByDate(b,a));
 title("予定");
 const visibility=state.scheduleSections||{current:true,future:false,past:false};
 const toggleScheduleSection=key=>{state.scheduleSections=state.scheduleSections||{current:true,future:false,past:false};state.scheduleSections[key]=!state.scheduleSections[key];render()};
 window.toggleScheduleSection=toggleScheduleSection;
 const scheduleMonthLabel=k=>{if(k==="unknown")return "日付未設定";const [yy,mm]=k.split("-");return `${yy}年${Number(mm)}月`};
 const schedulePastGroups={};past.forEach(s=>{const d=getDate(s);const k=d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`:"unknown";(schedulePastGroups[k]||(schedulePastGroups[k]=[])).push(s)});
 const schedulePastMonths=state.schedulePastMonths||{};
 const toggleSchedulePastMonth=k=>{state.schedulePastMonths=state.schedulePastMonths||{};state.schedulePastMonths[k]=state.schedulePastMonths[k]!==true;render()};
 window.toggleSchedulePastMonth=toggleSchedulePastMonth;
 const card=s=>{const cls="schedule-calendar-color";const time=[s.meetingTime?`集合 ${s.meetingTime}`:"",s.startTime?`開始 ${s.startTime}`:""].filter(Boolean).join(" / ");const d=s.date||String(s.start||"").slice(0,10),ed=s.endDate||d;const linked=(s.eventIds||[]).map(id=>events.find(e=>e.id==id)).filter(Boolean);return `<div class="item schedule-item ${cls}" onclick="openSchedule('${s.id}')"><div class="row"><h3>${esc(s.name)}</h3><span class="badge">${esc(s.type)}</span></div><p>${date(d)}${ed!==d?` ～ ${date(ed)}`:""}${time?`　${esc(time)}`:""}</p>${linked.length?`<p class="linked-label">イベント：${linked.map(e=>esc(e.name)).join("、")}</p>`:""}</div>`};
 const block=(key,label,items)=>{if(!items.length)return "";const open=visibility[key]!==false;let content="";if(open){if(key==="past")content=Object.keys(schedulePastGroups).sort((a,b)=>b.localeCompare(a)).map(k=>{const monthOpen=schedulePastMonths[k]===true;const monthItems=schedulePastGroups[k].slice().sort(sortByDate);return `<div class="past-month-group schedule-past-month-group"><button type="button" class="past-month-heading ${monthOpen?"open":""}" onclick="toggleSchedulePastMonth('${k}')" aria-expanded="${monthOpen}"><strong>${scheduleMonthLabel(k)}</strong><span class="count">${monthItems.length}件</span><span class="past-month-toggle">${monthOpen?"−":"＋"}</span></button>${monthOpen?`<div class="list">${monthItems.map(card).join("")}</div>`:""}</div>`}).join("");else content=`<div class="list">${items.map(card).join("")}</div>`}return `<div class="event-list-block schedule-list-block ${key}"><div class="section event-list-heading"><h2>${label}</h2><div class="section-actions"><span class="count">${items.length}件</span><button class="section-toggle ${open?"open":""}" onclick="toggleScheduleSection('${key}')" aria-label="${open?"一覧を閉じる":"一覧を表示"}">${open?"−":"＋"}</button></div></div>${content}</div>`};
 document.getElementById("screen").innerHTML=`<div class="section list-section list-section-schedules"><h2>予定</h2><div class="section-actions"><span class="count">${list.length}件</span><button class="filter-button ${f.type||f.keyword?"active":""}" onclick="openFilter('schedules')">☰ 絞り込み</button></div></div>${block("current","今月の予定",current)}${block("future","来月以降の予定",future)}${block("past","過去の予定",past)}${!list.length?`<div class="empty">${schedules.length?"条件に一致する予定がありません。":"予定がありません。"}</div>`:""}`;
}
function openFilter(kind){const f=state.filters[kind];const configs={events:{title:"イベントの絞り込み",label:"イベント種別",options:["ライブ","舞台","イベント","その他"],placeholder:"イベント名・出演者を検索"},products:{title:"販売情報の絞り込み",label:"販売種別",options:["POP UP","受注販売","通常販売","一番くじ","UFOキャッチャー","その他景品"],placeholder:"販売名・会場を検索"},schedules:{title:"予定の絞り込み",label:"予定種別",options:["一般予定","仕事","旅行","イベント","ライブ","舞台","映画","スポーツ","食事","買い物","記念日","その他"],placeholder:"予定名・関連情報を検索"}}[kind];const old=document.getElementById("filterModal");if(old)old.remove();const div=document.createElement("div");div.id="filterModal";div.className="overlay";div.innerHTML=`<div class="sheet filter-sheet"><button class="close" onclick="closeFilter()">×</button><h2>${configs.title}</h2><div class="group"><label>${configs.label}</label><select class="input" id="filterType"><option value="">すべて</option>${configs.options.map(x=>`<option ${f.type===x?"selected":""}>${x}</option>`).join("")}</select></div><div class="group"><label>キーワード</label><input class="input" id="filterKeyword" placeholder="${configs.placeholder}" value="${esc(f.keyword)}"></div><div class="filter-actions"><button class="secondary" onclick="clearFilter('${kind}')">クリア</button><button class="primary" onclick="applyFilter('${kind}')">この条件で絞り込む</button></div></div>`;document.body.appendChild(div)}
function closeFilter(){document.getElementById("filterModal")?.remove()}
function clearFilter(kind){state.filters[kind]={type:"",keyword:""};closeFilter();render()}
function applyFilter(kind){state.filters[kind]={type:document.getElementById("filterType").value,keyword:document.getElementById("filterKeyword").value.trim()};closeFilter();render()}
function openSchedule(i){state.returnPage="schedules";state.scheduleId=i;state.page="schedule";render()} function openScheduleFromCalendar(i){state.returnPage="calendar";state.scheduleId=i;state.page="schedule";render()} window.openScheduleFromCalendar=openScheduleFromCalendar;
function scheduleDetail(){
 const s=schedules.find(x=>x.id==state.scheduleId);
 if(!s){go("schedules");return}
 const d=s.date||String(s.start||"").slice(0,10);
 const endDate=s.endDate||d;
 const meeting=s.meetingTime||(s.start?String(s.start).split("T")[1]:"");
 const startTime=s.startTime||(s.start?String(s.start).split("T")[1]:"");
 const linkedEvents=(s.eventIds||[]).map(eid=>events.find(e=>e.id==eid)).filter(Boolean);
 const dailyPlans=Array.isArray(s.dailyPlans)?s.dailyPlans:[];
 const days=[]; let dayCur=new Date(d+"T00:00:00"), dayLast=new Date(endDate+"T00:00:00");
 while(dayCur<=dayLast){const key=localDateKey(dayCur);const found=dailyPlans.find(x=>x.date===key);days.push({date:key,text:found?.text||""});dayCur.setDate(dayCur.getDate()+1);}
 const dailyDetailHtml=days.length?days.map(day=>`<div class="daily-plan-detail-row"><div class="daily-plan-date">${date(day.date)}（${["日","月","火","水","木","金","土"][new Date(day.date+"T00:00:00").getDay()]}）</div><div class="daily-plan-detail-text">${day.text?esc(day.text).replace(/\n/g,"<br>"):"予定なし"}</div></div>`).join(""):"<div class=\"empty\">日ごとの予定はありません。</div>";
 title("予定詳細",true);
 const eventHtml=linkedEvents.length
   ? `<div class="linked-events">${linkedEvents.map(e=>`<button type="button" class="linked-event" onclick="openLinkedEvent('${e.id}')"><span>${esc(e.name)}</span><small>${(e.performances||[]).length?esc(date((e.performances||[])[0].date)):"イベント詳細を見る"}　›</small></button>`).join("")}</div>`
   : `<div class="empty linked-empty">関連イベントはありません。</div>`;
 document.getElementById("screen").innerHTML=`<div class="hero"><span class="badge">${esc(s.type)}</span><h2>${esc(s.name)}</h2></div>
 <div class="card">${detail("開始日",date(d))}${endDate!==d?detail("終了日",date(endDate)):""}${detail("集合時間",meeting)}${detail("集合場所",s.meetingPlace||"")}${detail("予定開始時刻",startTime)}${detail("予定種別",s.type)}${detail("関連情報",s.related)}${urlDetail("URL",s.url)}${detail("メモ",s.memo)}</div>
 <div class="section"><h2>日ごとの予定</h2></div><div class="daily-plan-detail">${dailyDetailHtml}</div>
 <div class="section"><h2>関連イベント</h2><span class="count">${linkedEvents.length}件</span></div>${eventHtml}
 <div class="actions"><button class="secondary" onclick="editSchedule('${s.id}')">編集</button><button class="danger" onclick="deleteSchedule('${s.id}')">削除</button></div>`;
}
function openLinkedEvent(id){
 // 予定詳細へ戻ったあと、さらに「戻る」で元の画面へ戻れるように
 // 予定詳細自身の戻り先を一時保存する。
 state.scheduleReturnPage=state.returnPage||"schedules";
 state.returnPage="schedule";
 state.eventId=id;
 state.page="event";
 render();
}
window.openLinkedEvent=openLinkedEvent;

function editSchedule(i){state.scheduleId=i;state.page="scheduleForm";render()}

function scheduleForm(){
 const old=schedules.find(x=>x.id==state.scheduleId)||{};
 const s=normalizeSchedule({name:"",date:state.prefillScheduleDate||"",endDate:state.prefillScheduleDate||"",meetingTime:"",startTime:"",meetingPlace:"",type:"一般予定",related:"",url:"",memo:"",eventIds:[],...old});
 s.eventIds=Array.isArray(s.eventIds)?s.eventIds:[];
 s.dailyPlans=Array.isArray(s.dailyPlans)?s.dailyPlans:[];
 // 編集時は、保存済みの日ごとの予定からも終了日を復元する。
 // 旧データで endDate が欠落していても、複数日分の入力欄を失わない。
 const dailyPlanDates=s.dailyPlans.map(x=>String(x?.date||"").slice(0,10)).filter(Boolean);
 const maxDailyPlanDate=dailyPlanDates.reduce((max,v)=>v>max?v:max,"");
 if(maxDailyPlanDate && (!s.endDate || maxDailyPlanDate>s.endDate)){
   s.endDate=maxDailyPlanDate;
 }
 if(s.date && (!s.endDate || s.endDate<s.date)) s.endDate=s.date;
 title(state.scheduleId?"予定編集":"予定登録",true);
 const eventMatches=(e,start,end)=>{
   const from=start||"";
   const to=end||start||"";
   if(!from)return true;
   return (e.performances||[]).some(p=>{
     const pd=String(p.date||"").slice(0,10);
     return pd && pd>=from && (!to || pd<=to);
   });
 };
 const eventOptionsFor=(start,end)=>{
   const matched=events.filter(e=>eventMatches(e,start,end));
   return matched.length
     ? matched.map(e=>`<label class="event-check"><input type="checkbox" name="eventIds" value="${esc(e.id)}" ${s.eventIds.includes(e.id)?"checked":""}><span><b>${esc(e.name)}</b><small>${(e.performances||[]).filter(p=>{const pd=String(p.date||"").slice(0,10);return pd>=start&&(!end||pd<=end)}).map(p=>date(p.date)).join(" / ")}</small></span></label>`).join("")
     : `<div class="empty linked-empty">${events.length?"開始日～終了日の期間に公演があるイベントはありません。":"登録済みのイベントがありません。"}</div>`;
 };
 const hasSelectedDate=Boolean(s.date);
 const eventOptions=hasSelectedDate?eventOptionsFor(s.date,s.endDate):`<div class="empty linked-empty">開始日を選択すると、該当するイベントが表示されます。</div>`;
 const dailyPlanRows=()=>{
   const start=document.querySelector('#scheduleForm input[name="date"]')?.value||s.date||"";
   const end=document.querySelector('#scheduleForm input[name="endDate"]')?.value||s.endDate||start;
   if(!start)return `<div class="empty daily-plan-empty">開始日を選択すると、日ごとの予定欄が表示されます。</div>`;
   const rows=[]; let cur=new Date(start+"T00:00:00"), last=new Date(end+"T00:00:00");
   while(cur<=last){
     const key=localDateKey(cur), found=s.dailyPlans.find(x=>x.date===key);
     const week=["日","月","火","水","木","金","土"][cur.getDay()];
     rows.push(`<div class="daily-plan-row"><div class="daily-plan-date">${date(key)}（${week}）</div><textarea class="input daily-plan-input" data-date="${key}" rows="3" placeholder="この日の予定を入力">${esc(found?.text||"")}</textarea></div>`);
     cur.setDate(cur.getDate()+1);
   }
   return rows.join("");
 };
 document.getElementById("screen").innerHTML=`<form class="form" id="scheduleForm">
 <div class="group"><label>予定名 <b class="req">必須</b></label><input class="input" name="name" required value="${esc(s.name)}"></div>
 <div class="time-grid"><div class="group"><label>開始日 <b class="req">必須</b></label><input class="input" name="date" type="date" required value="${esc(s.date)}"></div><div class="group"><label>終了日</label><input class="input" name="endDate" type="date" value="${esc(s.endDate)}"></div></div>
 <div class="group daily-plans-group"><label>日ごとの予定</label><div id="dailyPlans">${dailyPlanRows()}</div></div>
 <div class="time-grid"><div class="group"><label>集合時間</label><input class="input" name="meetingTime" type="time" value="${esc(s.meetingTime)}"></div><div class="group"><label>予定開始時刻</label><input class="input" name="startTime" type="time" value="${esc(s.startTime)}"></div></div>
 <div class="group"><label>集合場所</label><input class="input" name="meetingPlace" value="${esc(s.meetingPlace||"")}"></div>
 <div class="group"><label>予定種別</label><select class="input" name="type">${["一般予定","仕事","旅行","イベント","ライブ","舞台","映画","スポーツ","食事","買い物","記念日","その他"].map(x=>`<option ${x==s.type?"selected":""}>${x}</option>`).join("")}</select></div>
 <div class="group"><label>関連イベント</label><div class="event-picker">${eventOptions}</div></div>
 <div class="group"><label>関連情報</label><input class="input" name="related" value="${esc(s.related)}"></div>
 <div class="group"><label>URL</label><input class="input" name="url" type="url" placeholder="https://example.com" value="${esc(s.url||"")}"></div>
 <div class="group"><label>メモ</label><textarea class="input textarea" name="memo">${esc(s.memo)}</textarea></div>
 <button class="primary">保存</button></form>`;
 document.getElementById("scheduleForm").onsubmit=saveSchedule;
 const dateInput=document.querySelector('#scheduleForm input[name="date"]');
 const endInput=document.querySelector('#scheduleForm input[name="endDate"]');
 const picker=document.querySelector('#scheduleForm .event-picker');
 const dailyPlansBox=document.getElementById('dailyPlans');
 // 日付を変更して再描画するときも、すでに入力した各日の内容を保持する
 const captureDailyPlans=()=>{
   if(!dailyPlansBox)return;
   const current=[...dailyPlansBox.querySelectorAll('.daily-plan-input')].map(x=>({date:x.dataset.date,text:x.value}));
   if(current.length){
     const byDate=new Map((s.dailyPlans||[]).map(x=>[x.date,x]));
     current.forEach(x=>byDate.set(x.date,x));
     s.dailyPlans=[...byDate.values()];
   }
 };
 const refreshDailyPlans=()=>{
   captureDailyPlans();
   if(dailyPlansBox) dailyPlansBox.innerHTML=dailyPlanRows();
 };
 const refreshEventPicker=()=>{
   if(!picker)return;
   const start=dateInput?.value||"";
   const end=endInput?.value||start||"";
   if(!start){
     s.eventIds=[];
     picker.innerHTML=`<div class="empty linked-empty">開始日を選択すると、該当するイベントが表示されます。</div>`;
     return;
   }
   const selected=[...picker.querySelectorAll('input[name="eventIds"]:checked')].map(x=>x.value);
   s.eventIds=selected;
   picker.innerHTML=eventOptionsFor(start,end);
 };
 dateInput?.addEventListener("change",()=>{if(!endInput.value||endInput.value<dateInput.value)endInput.value=dateInput.value;refreshDailyPlans();refreshEventPicker()});
 endInput?.addEventListener("change",()=>{if(dateInput.value&&endInput.value<dateInput.value)endInput.value=dateInput.value;refreshDailyPlans();refreshEventPicker()});
}
function saveSchedule(ev){
 ev.preventDefault();
 const form=ev.target;
 const f=new FormData(form);
 const startDate=String(f.get("date")||"");
 const endDateRaw=String(f.get("endDate")||"");
 const endDate=endDateRaw||startDate;

 // 画面に存在する全日付の入力を保存。空欄の日も日付レコードとして保持する。
 const enteredDailyPlans=[...form.querySelectorAll('.daily-plan-input')].map(x=>({
   date:String(x.dataset.date||""),
   text:String(x.value||"").trim()
 })).filter(x=>x.date);

 const target=state.scheduleId ? schedules.find(x=>x.id==state.scheduleId) : null;
 const oldDaily=target && Array.isArray(target.dailyPlans) ? target.dailyPlans : [];
 const dailyMap=new Map(oldDaily.filter(x=>x&&x.date).map(x=>[x.date,{date:x.date,text:String(x.text||"")} ]));
 enteredDailyPlans.forEach(x=>dailyMap.set(x.date,x));

 // 現在の開始日～終了日に含まれない古い日付は削除するが、期間内の内容は絶対に消さない。
 // 開始日～終了日の全日付を必ず保持する。入力が空の日も削除しない。
 if(startDate && endDate){
   let cur=new Date(startDate+"T00:00:00"), last=new Date(endDate+"T00:00:00");
   while(cur<=last){
     const key=localDateKey(cur);
     if(!dailyMap.has(key)) dailyMap.set(key,{date:key,text:""});
     cur.setDate(cur.getDate()+1);
   }
 }
 const dailyPlans=[...dailyMap.values()]
   .filter(x=>!startDate || (x.date>=startDate && x.date<=endDate))
   .sort((a,b)=>a.date.localeCompare(b.date));

 const d={
   name:String(f.get("name")||"").trim(),
   date:startDate,
   endDate:endDate,
   meetingTime:String(f.get("meetingTime")||""),
   meetingPlace:String(f.get("meetingPlace")||"").trim(),
   startTime:String(f.get("startTime")||""),
   type:String(f.get("type")||"一般予定"),
   eventIds:f.getAll("eventIds"),
   dailyPlans,
   related:String(f.get("related")||""),
   url:String(f.get("url")||"").trim(),
   memo:String(f.get("memo")||"")
 };
 if(!d.name){alert("予定名を入力してください");return}
 if(!d.date){alert("開始日を入力してください");return}
 if(d.endDate<d.date){alert("終了日は開始日以降を指定してください");return}
 if(state.scheduleId){
   const index=schedules.findIndex(x=>x.id==state.scheduleId);
   if(index>=0) schedules[index]={...schedules[index],...d,id:schedules[index].id};
 }
 else{
   const item={id:id(),...d};
   schedules.unshift(item);
   state.scheduleId=item.id;
 }
 save(KEY.schedules,schedules);
 state.page="schedule";
 render();
}
function deleteSchedule(i){if(!confirm("予定を削除しますか？"))return;schedules=schedules.filter(s=>s.id!=i);save(KEY.schedules,schedules);go("schedules")}

function openCalendarDetail(item){
 if(!item || !item.entityId) return;
 if(item.kind==="event"){state.returnPage="calendar";state.eventId=item.entityId;state.page="event";render();}
 else if(item.kind==="product"){state.returnPage="calendar";state.productId=item.entityId;state.page="product";render();}
 else if(item.kind==="schedule"){openScheduleFromCalendar(item.entityId);}
}
window.openCalendarDetail=openCalendarDetail;

function getJapaneseHolidays(year){
 const h=new Map();
 const add=(month,day,name)=>h.set(`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`,name);
 const nthMonday=(month,n)=>{const d=new Date(year,month-1,1); return 1+((8-d.getDay())%7)+(n-1)*7};
 add(1,1,"元日");
 if(year>=2000) add(1,nthMonday(1,2),"成人の日"); else if(year>=1949) add(1,15,"成人の日");
 add(2,11,"建国記念の日");
 if(year>=2020) add(2,23,"天皇誕生日");
 if(year>=2019){
   const vernal=Math.floor(20.8431+0.242194*(year-1980)-Math.floor((year-1980)/4));
   add(3,vernal,"春分の日");
 }
 add(4,29,"昭和の日");
 add(5,3,"憲法記念日"); add(5,4,"みどりの日"); add(5,5,"こどもの日");
 if(year>=2003) add(7,nthMonday(7,3),"海の日"); else if(year>=1996) add(7,20,"海の日");
 if(year>=2016) add(8,11,"山の日");
 if(year>=2003) add(9,nthMonday(9,3),"敬老の日"); else if(year>=1966) add(9,15,"敬老の日");
 if(year>=2019){
   const autumn=Math.floor(23.2488+0.242194*(year-1980)-Math.floor((year-1980)/4));
   add(9,autumn,"秋分の日");
 }
 if(year>=2000) add(10,nthMonday(10,2),"スポーツの日"); else if(year>=1966) add(10,10,"体育の日");
 add(11,3,"文化の日"); add(11,23,"勤労感謝の日");
 // 振替休日・国民の休日（簡易計算）
 const base=[...h.entries()];
 base.forEach(([k,name])=>{const d=new Date(k+"T00:00:00"); if(d.getDay()===0){let x=new Date(d); do{x.setDate(x.getDate()+1)}while(h.has(`${year}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`)); h.set(`${year}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`,"振替休日")}});
 for(let month=1;month<=12;month++){for(let day=2;day<=31;day++){const d=new Date(year,month-1,day);if(d.getMonth()!==month-1)break;const k=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;const prev=new Date(d);prev.setDate(day-1);const next=new Date(d);next.setDate(day+1);const pk=`${year}-${String(prev.getMonth()+1).padStart(2,"0")}-${String(prev.getDate()).padStart(2,"0")}`,nk=`${year}-${String(next.getMonth()+1).padStart(2,"0")}-${String(next.getDate()).padStart(2,"0")}`;if(!h.has(k)&&h.has(pk)&&h.has(nk))h.set(k,"国民の休日")}}
 return h;
}

function scheduleTypeIcon(type){
 const icons={
  "一般予定":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 9h17"/></svg>`,
  "仕事":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7" width="17" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12h17M10 12v2h4v-2"/></svg>`,
  "旅行":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 13 7-2 3-7 2 .5-1 7.5 6 1.5c1.3.3 1.9 1.1 1.7 2-.2.8-1 1.2-2.2 1l-5.9-1.2-1.8 4.1-1.7-.4.6-4.4-6.3-1.3Z"/></svg>`,
  "イベント":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5v-2Z"/><path d="M10 7.5v9M14 7.5v9"/></svg>`,
  "ライブ":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3.5" width="10" height="13" rx="5"/><path d="M12 16.5V21M8 21h8M4 9.5v2a8 8 0 0 0 16 0v-2"/></svg>`,
  "舞台":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h7v7H4zM13 5h7v7h-7z"/><path d="M5 17c2-2 4-2 7 0 3-2 5-2 7 0M4 20h16"/></svg>`,
  "映画":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v12M17 6v12M3 9h4M17 9h4M3 15h4M17 15h4"/></svg>`,
  "スポーツ":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m7 7 3 3 4-1 3 3-2 4-4 1-3-3 1-4Z"/></svg>`,
  "食事":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v7M4 3v7M8 3v7M4 10c0 2 1 3 3 3v8M17 3v18M17 3c2 2 3 4 3 7v2h-3"/></svg>`,
  "買い物":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/></svg>`,
  "記念日":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/></svg>`,
  "その他":`<svg class="schedule-type-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`
 };
 return icons[type]||icons["その他"];
}

function settingsPage(){
  title("設定",true);
  document.getElementById("screen").innerHTML=`
    <div class="section settings-page settings-menu-page">
      <button class="settings-menu-card" type="button" onclick="openSettingsSection('display')">
        <span class="settings-menu-icon"><svg viewBox="0 0 40 40" aria-hidden="true"><path class="settings-gear" fill-rule="evenodd" d="M 15.03,7.99 L 15.34,2.61 L 24.66,2.61 L 24.97,7.99 L 29.00,4.41 L 35.59,11.00 L 32.01,15.03 L 37.39,15.34 L 37.39,24.66 L 32.01,24.97 L 35.59,29.00 L 29.00,35.59 L 24.97,32.01 L 24.66,37.39 L 15.34,37.39 L 15.03,32.01 L 11.00,35.59 L 4.41,29.00 L 7.99,24.97 L 2.61,24.66 L 2.61,15.34 L 7.99,15.03 L 4.41,11.00 L 11.00,4.41 L 15.03,7.99 Z M 20,13.5 A 6.5,6.5 0 1 0 20,26.5 A 6.5,6.5 0 1 0 20,13.5 Z"/></svg></span>
        <span class="settings-menu-text"><b>表示設定</b><small>景品のホーム表示期間などを設定</small></span>
        <span class="settings-menu-arrow">›</span>
      </button>
      <button class="settings-menu-card" type="button" onclick="openSettingsAccount()">
        <span class="settings-menu-icon"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="14" r="6"/><path d="M9 34c1-7 5-10 11-10s10 3 11 10"/></svg></span>
        <span class="settings-menu-text"><b>アカウント</b><small>${typeof window.raffleDb?.user?.email === "string" ? esc(window.raffleDb.user.email) : "Supabaseアカウント"}</small></span>
        <span class="settings-menu-arrow">›</span>
      </button>
      <button class="settings-menu-card" type="button" onclick="openSettingsSection('notifications')">
        <span class="settings-menu-icon"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M11 17a9 9 0 0 1 18 0v5l3 5H8l3-5v-5Z"/><path d="M17 31h6"/></svg></span>
        <span class="settings-menu-text"><b>通知設定</b><small>申込締切のプッシュ通知を設定</small></span>
        <span class="settings-menu-arrow">›</span>
      </button>
      <button class="settings-menu-card" type="button" onclick="openSettingsSection('data')">
        <span class="settings-menu-icon data-menu-icon"><svg viewBox="0 0 40 40" aria-hidden="true">
          <path class="data-db" d="M8 9.5C8 7.57 13.37 6 20 6s12 1.57 12 3.5S26.63 13 20 13 8 11.43 8 9.5Z"/>
          <path class="data-db" d="M8 9.5v9C8 20.43 13.37 22 20 22s12-1.57 12-3.5v-9"/>
          <path class="data-db" d="M8 18.5v9C8 29.43 13.37 31 20 31s12-1.57 12-3.5v-9"/>
          <path class="data-db-line" d="M13 17.5h14M13 26.5h14"/>
        </svg></span>
        <span class="settings-menu-text"><b>データ管理</b><small>バックアップ・復元・データ削除</small></span>
        <span class="settings-menu-arrow">›</span>
      </button>
    </div>`;
}
function settingsDisplayPage(){
  title("表示設定",true);
  const prize=appSettings.prizePeriods||{};
  document.getElementById("screen").innerHTML=`
    <div class="section settings-page">
      <div class="settings-card">
        <h2>景品の表示期間</h2>
        <p class="sub">終了日のない景品をホームの「期間中」に表示する期間を設定します。カレンダーには発売日のみ表示されます。</p>
        ${["一番くじ","UFOキャッチャー","その他景品"].map(t=>`<div class="settings-row"><label>${t}<small>発売日から表示</small></label><div class="settings-input"><input class="input" type="number" min="1" max="365" id="setting-${t}" value="${esc(prize[t]||30)}"><span>日間</span></div></div>`).join("")}
        <button class="primary" type="button" onclick="saveSettings()">設定を保存</button>
      </div>
    </div>`;
}
function settingsNotificationPage(){
  title("通知設定",true);
  const n=appSettings.notifications||{};
  document.getElementById("screen").innerHTML=`
    <div class="section settings-page">
      <div class="settings-card">
        <h2>プッシュ通知</h2>
        <p class="sub">アプリを閉じていても、申込締切が近づいたときに端末へ通知します。</p>
        <div class="settings-actions settings-actions-column">
          <button class="primary" type="button" onclick="enablePushNotifications()">この端末で通知を有効にする</button>
          <button class="secondary" type="button" onclick="disablePushNotifications()">この端末の通知を解除</button>
        </div>
        <div id="pushStatus" class="form-note" style="margin-top:10px">通知状態を確認中…</div>
      </div>
      <div class="settings-card">
        <h2>締切通知</h2>
        <p class="sub">申込済み・当選・落選の申込は通知しません。</p>
        <label class="settings-toggle-row"><span><b>1日前</b><small>締切の約24時間前</small></span><input id="notifyDeadline1day" type="checkbox" ${n.deadline1day!==false?"checked":""}></label>
        <label class="settings-toggle-row"><span><b>1時間前</b><small>締切の約1時間前</small></span><input id="notifyDeadline1hour" type="checkbox" ${n.deadline1hour!==false?"checked":""}></label>
        <button class="primary" type="button" onclick="saveNotificationSettings()">設定を保存</button>
      </div>
    </div>`;
  updatePushStatus();
}
async function updatePushStatus(){
  const el=document.getElementById("pushStatus");if(!el)return;
  try{const s=await window.getRafflePushStatus();el.textContent=s.subscribed?"この端末の通知：有効":"この端末の通知：未設定（ボタンから有効化してください）";}catch(e){el.textContent="このブラウザでは通知状態を確認できません。";}
}
async function enablePushNotifications(){
  try{await window.enableRafflePush();alert("この端末の通知を有効にしました。");updatePushStatus();}catch(e){alert(e.message||"通知の有効化に失敗しました。");}
}
async function disablePushNotifications(){
  try{await window.disableRafflePush();alert("この端末の通知を解除しました。");updatePushStatus();}catch(e){alert(e.message||"通知の解除に失敗しました。");}
}
function saveNotificationSettings(){
  appSettings.notifications={deadline1day:document.getElementById("notifyDeadline1day")?.checked!==false,deadline1hour:document.getElementById("notifyDeadline1hour")?.checked!==false};
  save(KEY.settings,appSettings);alert("通知設定を保存しました。");
}

function settingsDataPage(){
  title("データ管理",true);
  document.getElementById("screen").innerHTML=`
    <div class="section settings-page">
      <div class="settings-card settings-data-card">
        <h2>データ管理</h2>
        <p class="sub">登録したデータのバックアップ・復元・削除を行います。</p>
        <div class="settings-actions settings-actions-column">
          <button class="secondary" type="button" onclick="backupData()">データをバックアップ</button>
          <button class="secondary" type="button" onclick="document.getElementById('restoreFile').click()">データを復元</button>
          <input id="restoreFile" type="file" accept="application/json,.json" class="hidden" onchange="restoreData(this)">
          <button class="danger-button" type="button" onclick="deleteAllData()">すべてのデータを削除</button>
        </div>
      </div>
    </div>`;
}
function openSettingsAccount(){
  state.page="settingsAccount"; render();
}
function settingsAccountPage(){
  title("アカウント",true);
  const email=window.raffleDb?.user?.email||"-";
  document.getElementById("screen").innerHTML=`<div class="section settings-page"><div class="settings-card"><h2>Supabaseアカウント</h2>${detail("メールアドレス",email)}<button class="danger-button" type="button" onclick="raffleLogout()">ログアウト</button></div></div>`;
}
function openSettingsSection(section){
  state.settingsSection=section;
  // 設定トップへ戻ったあと、さらに元の画面へ戻れるように元のreturnPageは維持
  state.page=section==='display'?"settingsDisplay":section==='notifications'?"settingsNotifications":"settingsData";
  render();
}
function saveSettings(){
  const vals={};
  ["一番くじ","UFOキャッチャー","その他景品"].forEach(t=>{const n=Math.max(1,Math.min(365,Number(document.getElementById(`setting-${t}`).value)||30));vals[t]=n;});
  appSettings.prizePeriods=vals;save(KEY.settings,appSettings);alert("設定を保存しました。");
}
function backupData(){
  const data={version:1,exportedAt:new Date().toISOString(),events,products,schedules,settings:appSettings};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`raffle-manager-backup-${localDateKey(new Date())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function restoreData(input){
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const d = JSON.parse(reader.result);

      if (
        !Array.isArray(d.events) ||
        !Array.isArray(d.products) ||
        !Array.isArray(d.schedules)
      ) {
        throw new Error("バックアップ形式が正しくありません。");
      }

      if (
        !confirm(
          "バックアップデータを復元します。\n\n" +
          "Databaseにも追加保存されます。よろしいですか？"
        )
      ) {
        return;
      }

      // ----------------------------------------
      // Supabaseへ先に保存
      // ----------------------------------------

      if (
        window.raffleDb &&
        window.raffleDb.user &&
        typeof window.raffleDb.importBackup === "function"
      ) {

        const imported = await window.raffleDb.importBackup(d);

        if (!imported) {
          throw new Error("Databaseへのインポート結果を取得できませんでした。");
        }

        // importBackup内でIDが新UUIDへ変換された
        events = imported.events.map(normalizeEvent);
        products = imported.products;
        schedules = imported.schedules.map(normalizeSchedule);

        appSettings = Object.assign(
          {
            prizePeriods: {
              "一番くじ": 30,
              "UFOキャッチャー": 14,
              "その他景品": 30
            }
          },
          imported.settings || {}
        );

        // 重要：
        // save() は使わない。
        // save() → queueRaffleSync() が走ると、
        // importBackup直後のDBと競合する可能性があるため。
        localStorage.setItem(
          KEY.events,
          JSON.stringify(events)
        );

        localStorage.setItem(
          KEY.products,
          JSON.stringify(products)
        );

        localStorage.setItem(
          KEY.schedules,
          JSON.stringify(schedules)
        );

        localStorage.setItem(
          KEY.settings,
          JSON.stringify(appSettings)
        );

        render();

        alert(
          "バックアップを復元しました。\n\n" +
          "Databaseへの保存も完了しています。"
        );

      } else {

        // ----------------------------------------
        // Supabase未接続時
        // ----------------------------------------

        events = d.events.map(normalizeEvent);
        products = d.products;
        schedules = d.schedules.map(normalizeSchedule);

        appSettings = Object.assign(
          {
            prizePeriods: {
              "一番くじ": 30,
              "UFOキャッチャー": 14,
              "その他景品": 30
            }
          },
          d.settings || {}
        );

        localStorage.setItem(
          KEY.events,
          JSON.stringify(events)
        );

        localStorage.setItem(
          KEY.products,
          JSON.stringify(products)
        );

        localStorage.setItem(
          KEY.schedules,
          JSON.stringify(schedules)
        );

        localStorage.setItem(
          KEY.settings,
          JSON.stringify(appSettings)
        );

        render();

        alert("データを復元しました。");
      }

    } catch(e) {

      console.error("バックアップ復元エラー:", e);

      alert(
        "バックアップデータの復元に失敗しました。\n\n" +
        (e.message || e)
      );

    } finally {
      input.value = "";
    }
  };

  reader.readAsText(file);
}
function deleteAllData(){
  if(!confirm("すべての登録データを削除します。よろしいですか？"))return;
  if(!confirm("この操作は元に戻せません。本当に削除しますか？"))return;
  events=[];products=[];schedules=[];save(KEY.events,events);save(KEY.products,products);save(KEY.schedules,schedules);alert("すべてのデータを削除しました。");go("home");
}
function openSettings(){state.returnPage=state.page;state.settingsSection=null;state.page="settings";render()}
window.openSettings=openSettings;window.saveSettings=saveSettings;window.saveNotificationSettings=saveNotificationSettings;window.enablePushNotifications=enablePushNotifications;window.disablePushNotifications=disablePushNotifications;window.backupData=backupData;window.restoreData=restoreData;window.deleteAllData=deleteAllData;
function calendar(){
 title("カレンダー");
 const y=state.calendarDate.getFullYear(),m=state.calendarDate.getMonth();
 const key=x=>x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0");
 const today=key(new Date()),sk=key(state.selectedDate);
 const holidayMap=new Map();
 [y-1,y,y+1].forEach(yy=>getJapaneseHolidays(yy).forEach((name,k)=>holidayMap.set(k,name)));

 function addCalendarItem(list,item){ if(item&&item.name) list.push(item); }
 function getItems(k){
   const items=[];
   const cf=state.calendarFilters||{};
   events.forEach(e=>(e.performances||[]).forEach(p=>{if(cf.event!==false&&p.date===k)addCalendarItem(items,{name:e.name,text:"公演 "+(p.venue||"")+" "+(p.start||""),type:"イベント",cls:"cal-event",entityId:e.id,kind:"event"})}));
   events.forEach(e=>(e.applications||[]).forEach(a=>{
     if(cf.applicationStart!==false&&a.start&&a.start.slice(0,10)===k)addCalendarItem(items,{name:e.name,text:(a.name||"申込")+" 受付開始",type:"申込開始",cls:"cal-application-start",status:a.status,entityId:e.id,kind:"event"});
     if(cf.applicationEnd!==false&&a.end&&a.end.slice(0,10)===k)addCalendarItem(items,{name:e.name,text:(a.name||"申込")+" 受付終了",type:"申込終了",cls:"cal-application-end",status:a.status,entityId:e.id,kind:"event"});
     if(cf.announcement!==false&&a.method==="抽選"&&a.announcement===k)addCalendarItem(items,{name:e.name,text:(a.name||"申込")+" 発表日",type:"発表日",cls:"cal-announcement",status:a.status,entityId:e.id,kind:"event"});
   }));
   products.forEach(p=>{const type=p.type||"POP UP",isOrder=type==="受注販売",isPrize=["一番くじ","UFOキャッチャー","その他景品"].includes(type);if(isPrize){if(cf.prize!==false&&p.start===k)addCalendarItem(items,{name:p.name,text:"景品発売日",type:"景品発売",cls:"cal-prize",entityId:p.id,kind:"product"});return}if(type!=="通常販売"&&cf.popup!==false&&!isOrder){if(p.start===k)addCalendarItem(items,{name:p.name,text:type+" 開始",type:type+"開始",cls:"cal-popup",entityId:p.id,kind:"product"});if(p.end===k)addCalendarItem(items,{name:p.name,text:type+" 終了",type:type+"終了",cls:"cal-popup",entityId:p.id,kind:"product"})}if(isOrder&&cf.order!==false){if(p.start===k)addCalendarItem(items,{name:p.name,text:type+" 開始",type:type+"開始",cls:"cal-order",entityId:p.id,kind:"product"});if(p.end===k)addCalendarItem(items,{name:p.name,text:type+" 終了",type:type+"終了",cls:"cal-order",entityId:p.id,kind:"product"})}});
   schedules.forEach(x=>{const sd=x.date||String(x.start||"").slice(0,10),ed=x.endDate||sd;if(cf.schedule!==false&&sd&&k>=sd&&k<=ed){const times=[x.meetingTime?`集合 ${x.meetingTime}`:"",x.startTime?`開始 ${x.startTime}`:""].filter(Boolean).join(" / ");addCalendarItem(items,{name:x.name,text:times||"予定",type:x.type||"一般予定",cls:"cal-schedule",entityId:x.id,kind:"schedule"})}});
   return items;
 }

 const base=new Date(state.calendarDate);
 let days=[];
 if(state.calendarView==="week"){
   const start=new Date(state.selectedDate); start.setHours(0,0,0,0); start.setDate(start.getDate()-start.getDay());
   for(let i=0;i<7;i++){const d=new Date(start);d.setDate(start.getDate()+i);days.push(d)}
 }else{
   const first=new Date(y,m,1),startDate=new Date(y,m,1-first.getDay());
   for(let i=0;i<42;i++){const d=new Date(startDate);d.setDate(startDate.getDate()+i);days.push(d)}
 }

 let cells="";
 days.forEach(d=>{
   const k=key(d),items=getItems(k),holidayName=holidayMap.get(k)||"",weekendClass=d.getDay()===0?"sunday ":d.getDay()===6?"saturday ":"";
   cells+=`<div class="day ${state.calendarView==="week"?"week-day ":""}${weekendClass}${holidayName?"holiday ":""}${state.calendarView==="month"&&d.getMonth()!=m?"other ":""}${k===today?"today ":""}${k===sk?"selected-day-cell":""}" title="${holidayName?esc(holidayName):""}" onclick="selectCalendar('${k}')"><b>${d.getDate()}</b>`;
   const maxVisible=state.calendarView==="week"?items.length:1;
   items.slice(0,maxVisible).forEach(x=>cells+=`<span class="dot ${x.cls}" title="${esc(x.text)}">● ${esc(x.name)}</span>`);
   if(items.length>maxVisible)cells+=`<span class="more-dot">＋${items.length-maxVisible}件</span>`;
   cells+='</div>';
 });

 const selectedItems=getItems(sk);
 const details=selectedItems.map(x=>`<div class="card event-group ${x.cls}"><div class="calendar-detail-head"><strong>${esc(x.name)}</strong><span class="calendar-type">${x.kind==="schedule"?scheduleTypeIcon(x.type)+" ":""}${esc(x.type)}</span></div><div>${esc(x.text)}${x.status?`　<span class="calendar-status">${esc(x.status)}</span>`:""}</div>${x.entityId?`<div class="calendar-detail-actions"><button type="button" class="primary calendar-detail-button" onclick="event.stopPropagation(); openCalendarDetail(${JSON.stringify(x).replace(/"/g,'&quot;')})">${x.kind==="event"?"イベント詳細を見る":x.kind==="product"?"販売詳細を見る":"予定詳細を見る"}</button></div>`:""}</div>`).join("");
 const displayDate=state.calendarView==="week"?`${date(key(days[0]))} ～ ${date(key(days[6]))}`:`${y}年 ${m+1}月`;
 const headerYear=state.calendarView==="week"?state.selectedDate.getFullYear():y;
 const headerMonth=state.calendarView==="week"?state.selectedDate.getMonth():m;

 document.getElementById("screen").innerHTML=`
   <div class="calendar-page">
   <div class="calendar-head">
     <button type="button" class="calendar-nav-button" aria-label="前の期間" onclick="changeCalendarPeriod(-1)">‹</button>
     <div class="calendar-selects">
       <label class="calendar-select-wrap"><select class="calendar-select" aria-label="年" onchange="changeCalendarYear(this.value)">${Array.from({length:21},(_,i)=>headerYear-10+i).map(yy=>`<option value="${yy}" ${yy===headerYear?"selected":""}>${yy}年</option>`).join("")}</select><span class="calendar-select-arrow">⌄</span></label>
       <label class="calendar-select-wrap month-select-wrap"><select class="calendar-select" aria-label="月" onchange="changeCalendarMonth(this.value)">${Array.from({length:12},(_,i)=>i).map(mm=>`<option value="${mm}" ${mm===headerMonth?"selected":""}>${mm+1}月</option>`).join("")}</select><span class="calendar-select-arrow">⌄</span></label>
     </div>
     <button type="button" class="calendar-nav-button" aria-label="次の期間" onclick="changeCalendarPeriod(1)">›</button>
   </div>
   <div class="calendar-head-actions">
     <button type="button" class="calendar-today-button" onclick="goToToday()">今日</button>
     <button type="button" class="calendar-view-toggle" onclick="toggleCalendarView()">${state.calendarView==="month"?"週表示":"月表示"}</button>
     <div class="calendar-filter-control"><button type="button" class="calendar-display-button ${state.calendarFilterOpen?"open":""}" onclick="toggleCalendarFilterMenu()">表示 <span>${state.calendarFilterOpen?"⌃":"⌄"}</span></button>${state.calendarFilterOpen?`<div class="calendar-filter-menu"><div class="calendar-filter-menu-title">表示する項目</div><div class="calendar-filter-menu-list"><button type="button" class="calendar-filter-chip ${state.calendarFilters.event!==false?"active":""}" onclick="toggleCalendarFilter('event')">公演</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.applicationStart!==false?"active":""}" onclick="toggleCalendarFilter('applicationStart')">受付開始</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.applicationEnd!==false?"active":""}" onclick="toggleCalendarFilter('applicationEnd')">受付終了</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.announcement!==false?"active":""}" onclick="toggleCalendarFilter('announcement')">発表日</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.popup!==false?"active":""}" onclick="toggleCalendarFilter('popup')">POP UP</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.order!==false?"active":""}" onclick="toggleCalendarFilter('order')">受注販売</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.prize!==false?"active":""}" onclick="toggleCalendarFilter('prize')">景品発売</button><button type="button" class="calendar-filter-chip ${state.calendarFilters.schedule!==false?"active":""}" onclick="toggleCalendarFilter('schedule')">予定</button></div><div class="calendar-filter-menu-actions"><button type="button" class="calendar-filter-all" onclick="resetCalendarFilters()">すべて表示</button><button type="button" class="calendar-filter-all calendar-filter-none" onclick="hideAllCalendarFilters()">すべて非表示</button></div></div>`:""}</div>
   </div>
   <div class="calendar-legend"><span><i class="legend-dot cal-event"></i>公演</span><span><i class="legend-dot cal-application-start"></i>受付開始</span><span><i class="legend-dot cal-application-end"></i>受付終了</span><span><i class="legend-dot cal-announcement"></i>発表日</span><span><i class="legend-dot cal-popup"></i>POP UP</span><span><i class="legend-dot cal-order"></i>受注販売</span><span><i class="legend-dot cal-prize"></i>景品発売</span><span><i class="legend-dot cal-schedule"></i>予定</span></div>
   <div class="week"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div>
   <div class="cal-grid ${state.calendarView==="week"?"cal-grid-week":""}">${cells}</div>
   <div class="selected-day"><div class="section selected-day-heading"><h2>${date(sk)}</h2><div class="selected-day-actions"><span class="count">${selectedItems.length}件</span><button type="button" class="calendar-add-button" onclick="newEvent('${sk}')">＋イベント</button><button type="button" class="calendar-add-button" onclick="newProduct('${sk}')">＋商品</button><button type="button" class="calendar-add-button" onclick="newSchedule('${sk}')">＋予定</button></div></div>${details||'<div class="empty">この日の予定はありません。</div>'}</div></div>`;
}

function toggleCalendarFilterMenu(){state.calendarFilterOpen=!state.calendarFilterOpen;render()}
function toggleCalendarFilter(kind){state.calendarFilters=state.calendarFilters||{event:true,applicationStart:true,applicationEnd:true,announcement:true,popup:true,order:true,schedule:true};state.calendarFilters[kind]=state.calendarFilters[kind]===false;state.calendarFilterOpen=true;render()}
function resetCalendarFilters(){state.calendarFilters={event:true,applicationStart:true,applicationEnd:true,announcement:true,popup:true,order:true,prize:true,schedule:true};state.calendarFilterOpen=true;render()}
function hideAllCalendarFilters(){state.calendarFilters={event:false,applicationStart:false,applicationEnd:false,announcement:false,popup:false,order:false,prize:false,schedule:false};state.calendarFilterOpen=true;render()}
function toggleCalendarView(){state.calendarView=state.calendarView==="month"?"week":"month";render()}
function changeCalendarPeriod(n){
 if(state.calendarView==="week"){
   const d=new Date(state.selectedDate);d.setDate(d.getDate()+n*7);state.selectedDate=d;state.calendarDate=new Date(d.getFullYear(),d.getMonth(),1);
 }else{
   const d=new Date(state.calendarDate);d.setMonth(d.getMonth()+n);state.calendarDate=d;
 }
 render();
}
function changeMonth(n){changeCalendarPeriod(n)}
function changeCalendarYear(year){
  const d=new Date(state.calendarDate);
  d.setFullYear(Number(year));
  state.calendarDate=d;
  const selected=new Date(state.selectedDate);
  selected.setFullYear(Number(year));
  state.selectedDate=selected;
  render();
}
function changeCalendarMonth(month){
  const d=new Date(state.calendarDate);
  d.setMonth(Number(month));
  state.calendarDate=d;
  const selected=new Date(state.selectedDate);
  selected.setFullYear(d.getFullYear(), Number(month), 1);
  state.selectedDate=selected;
  render();
}
function goToToday(){
  const today=new Date();
  today.setHours(0,0,0,0);
  state.calendarDate=new Date(today.getFullYear(),today.getMonth(),1);
  state.selectedDate=new Date(today);
  render();
}
function selectCalendar(k){state.selectedDate=new Date(k+"T00:00:00");render()}
// Supabase版は認証・Databaseの読み込み完了後に初回描画する。
if(typeof window.bootRaffleApp === "function") window.bootRaffleApp();
else { updateApplicationStatuses(); render(); }
// アプリを開いたままでも受付開始・終了時刻を自動反映（1分ごと）
setInterval(()=>{if(updateApplicationStatuses())render();},60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&updateApplicationStatuses())render();});

/* スクロール端での余計な跳ね返りを防止 */
(function setupScrollBoundaryLock(){
  let startY = 0;
  function bind(el){
    if(!el || el.dataset.scrollBoundaryLock) return;
    el.dataset.scrollBoundaryLock = '1';
    el.addEventListener('touchstart', function(e){
      if(e.touches.length === 1) startY = e.touches[0].clientY;
    }, {passive:true});
    el.addEventListener('touchmove', function(e){
      if(e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if(max <= 0) return;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop >= max - 1;
      if((atTop && dy > 0) || (atBottom && dy < 0)) e.preventDefault();
    }, {passive:false});
  }
  function bindAll(){
    bind(document.getElementById('screen'));
    document.querySelectorAll('.sheet').forEach(bind);
  }
  bindAll();
  new MutationObserver(bindAll).observe(document.body, {childList:true, subtree:true});
})();
