/* =========================================================
 * 抽選管理 - Supabase integration
 * ========================================================= */
(function () {
  const CONFIG_KEY = "raffle_supabase_config_v1";
  const cached = (() => {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
  })();

  function getConfig() {
    const base = window.RAFFLE_SUPABASE_CONFIG || {};
    return {
      url: cached.url || base.url || "",
      publishableKey: cached.publishableKey || base.publishableKey || ""
    };
  }

  function saveConfig(url, publishableKey) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: String(url || "").trim(), publishableKey: String(publishableKey || "").trim() }));
  }

  window.raffleDb = {
    client: null,
    user: null,
    getConfig,
    saveConfig,
    isConfigured() {
      const c = getConfig();
      return !!(c.url && c.publishableKey);
    },
    async init() {
      if (!this.isConfigured()) return null;
      const c = getConfig();
      this.client = window.supabase.createClient(c.url, c.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      this.user = data?.session?.user || null;
      return this.user;
    },
    async signUp(email, password) {
      const { data, error } = await this.client.auth.signUp({ email, password });
      if (error) throw error;
      return data;
    },
    async signIn(email, password) {
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw error;

      // signInWithPassword直後は、認証セッションの保存・反映が
      // ブラウザ側で完了する前に次のDatabase問い合わせへ進む場合がある。
      // そのため、返却されたsessionを確認しつつgetSessionでも確定させる。
      this.user = data?.user || data?.session?.user || null;
      if (!this.user) {
        const sessionResult = await this.client.auth.getSession();
        if (sessionResult.error) throw sessionResult.error;
        this.user = sessionResult.data?.session?.user || null;
      }
      if (!this.user) throw new Error("ログインセッションを確認できませんでした。");

      // AuthセッションがStorage/APIクライアントへ反映されるまで少し待つ。
      await new Promise(resolve => setTimeout(resolve, 150));
      return data;
    },
    async signOut() {
      if (!this.client) return;
      const { error } = await this.client.auth.signOut();
      if (error) throw error;
      this.user = null;
    },
    async table(name, op, payload) {
      if (!this.client || !this.user) throw new Error("Supabaseにログインしていません。");
      let q = this.client.from(name);
      if (op === "select") q = q.select(payload || "*");
      if (op === "upsert") q = q.upsert(payload, { onConflict: "id" });
      if (op === "insert") q = q.insert(payload);
      if (op === "delete") q = q.delete();
      const result = await q;
      if (result.error) throw result.error;
      return result.data;
    },
    async loadAll() {
      if (!this.client || !this.user) throw new Error("Supabaseにログインしていません。");
      const names = [
        "events", "performances", "applications", "application_rounds", "application_performances",
        "products", "product_items", "schedules", "schedule_days", "user_settings", "notifications"
      ];
      const out = {};
      for (const name of names) {
        let query = this.client.from(name).select("*");
        if (["events", "products", "schedules", "notifications"].includes(name)) query = query.eq("user_id", this.user.id);
        const { data, error } = await query;
        if (error) throw error;
        out[name] = data || [];
      }
      return out;
    },
    async syncAll(data) {
      if (!this.client || !this.user) return;
      const uid = this.user.id;
      const rows = {
        events: (data.events || []).map(e => ({
          id: e.id, user_id: uid, name: e.name || "", type: e.type || null,
          performers: e.performers || null, url: e.url || null, memo: e.memo || null
        })),
        performances: [], applications: [], application_performances: [],
        products: (data.products || []).map(p => ({
          id: p.id, user_id: uid, name: p.name || "", type: p.type || null,
          start_at: p.start || null, end_at: p.end || null, venue: p.venue || null,
          url: p.url || null, image_url: p.image_url || null, price: p.price ?? null,
          purchased: !!p.purchased, memo: p.memo || null
        })),
        product_items: [],
        schedules: (data.schedules || []).map(s => ({
          id: s.id, user_id: uid, name: s.name || "", start_date: s.date,
          end_date: s.endDate || s.date || null, meeting_time: s.meetingTime || null,
          meeting_place: s.meetingPlace || null, start_time: s.startTime || null,
          type: s.type || null, related_type: null, related_id: null,
          related_event_ids: Array.isArray(s.eventIds) ? s.eventIds : [],
          url: s.url || null, memo: s.memo || null
        })),
        schedule_days: [],
        user_settings: [{
          user_id: uid,
          ichiban_period: Number(data.settings?.prizePeriods?.["一番くじ"] || 30),
          ufo_period: Number(data.settings?.prizePeriods?.["UFOキャッチャー"] || 14),
          other_period: Number(data.settings?.prizePeriods?.["その他景品"] || 30),
          notify_deadline_1day: true, notify_deadline_1hour: true
        }]
      };

      (data.events || []).forEach(e => {
        (e.performances || []).forEach(p => rows.performances.push({
          id: p.id, event_id: e.id, name: p.dayName || null, date: p.date,
          doors_time: p.open || null, start_time: p.start || null,
          venue: p.venue || null, performers: p.performers || null, memo: p.memo || null
        }));
        (e.applications || []).forEach(a => {
          rows.applications.push({
            id: a.id, event_id: e.id, name: a.name || null, method: a.method || null,
            ticket_site_name: a.ticketSiteName || null, start_at: a.start || null,
            end_at: a.end || null, announcement_at: a.announcement || null,
            status: a.status || null, quantity: Number(a.quantity || 1),
            payment: a.payment || null, memo: a.memo || null
          });
          (a.performanceIds || []).forEach(pid => {
            if (!pid) return;
            rows.application_performances.push({
              id: (window.crypto?.randomUUID ? window.crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==="x"?r:(r&3|8);return v.toString(16);})), application_id: a.id, performance_id: pid,
              status: (a.performanceStatuses || {})[pid] || a.status || "未応募"
            });
          });
        });
      });
      (data.products || []).forEach(p => (p.items || []).forEach(it => rows.product_items.push({
        id: it.id, product_id: p.id, name: it.name || "", price: Number(it.price || 0),
        quantity: Math.max(1, Number(it.quantity || 1)), secured: !!it.secured,
        purchased: !!it.purchased, url: it.url || null, memo: it.memo || null
      })));
      (data.schedules || []).forEach(s => (s.dailyPlans || []).forEach(d => rows.schedule_days.push({
        id: d.id || uuidFallback(), schedule_id: s.id, date: d.date,
        start_time: null, end_time: null, memo: d.text || null
      })));

      // Delete first so removed records disappear. Parent deletes cascade to children.
      const del = async (table, column = "user_id") => {
        let q = this.client.from(table).delete();
        if (column === "user_id") q = q.eq(column, uid);
        else q = q.in(column, column === "event_id" ? (data.events || []).map(x => x.id) : []);
        const { error } = await q;
        if (error) throw error;
      };
      await del("notifications");
      await del("schedules");
      await del("products");
      await del("events");

      const insertIfAny = async (table, arr) => {
        if (!arr.length) return;
        const { error } = await this.client.from(table).insert(arr);
        if (error) throw error;
      };
      await insertIfAny("events", rows.events);
      await insertIfAny("performances", rows.performances);
      await insertIfAny("applications", rows.applications);
      await insertIfAny("application_performances", rows.application_performances.filter(x => rows.performances.some(p => p.id === x.performance_id)));
      await insertIfAny("products", rows.products);
      await insertIfAny("product_items", rows.product_items);
      await insertIfAny("schedules", rows.schedules);
      await insertIfAny("schedule_days", rows.schedule_days);
      const { error: settingsError } = await this.client.from("user_settings").upsert(rows.user_settings, { onConflict: "user_id" });
      if (settingsError) throw settingsError;
    }
  };

  window.showDatabaseSetup = function () {
    const c = getConfig();
    document.body.innerHTML = `
      <div class="setup-shell"><div class="setup-card">
        <div class="setup-icon">☁</div>
        <h1>Supabase接続設定</h1>
        <p>このアプリをDatabase版として使うため、SupabaseのProject URLとPublishable keyを設定してください。</p>
        <div class="group"><label>Project URL</label><input id="sbUrl" class="input" value="${escSafe(c.url)}" placeholder="https://xxxx.supabase.co"></div>
        <div class="group"><label>Publishable key</label><input id="sbKey" class="input" type="password" value="${escSafe(c.publishableKey)}" placeholder="sb_publishable_..."></div>
        <p class="setup-note">Publishable keyを使用してください。Secret / service_role keyは入力しないでください。</p>
        <button class="primary" type="button" onclick="saveSupabaseSetup()">接続して開始</button>
      </div></div>`;
  };

  window.showAuthScreen = function (message = "") {
    document.body.innerHTML = `
      <div class="setup-shell"><div class="setup-card auth-card">
        <div class="setup-icon">🎟</div>
        <h1>抽選管理</h1>
        <p>Supabaseアカウントでログインすると、登録データをDatabaseに保存できます。</p>
        <div id="authMessage" class="setup-message ${message ? "show" : ""}">${escSafe(message)}</div>
        <form id="authForm">
          <div class="group"><label>メールアドレス</label><input id="authEmail" class="input" type="email" required autocomplete="email"></div>
          <div class="group"><label>パスワード</label><input id="authPassword" class="input" type="password" minlength="6" required autocomplete="current-password"></div>
          <button class="primary" type="submit">ログイン</button>
        </form>
        <button class="secondary" type="button" onclick="supabaseSignUp()">新規アカウントを作成</button>
        <button class="link-button" type="button" onclick="showDatabaseSetup()">Supabase接続設定を変更</button>
      </div></div>`;
      document.getElementById("authForm").onsubmit = async e => {
        e.preventDefault();
        const email = document.getElementById("authEmail").value.trim();
        const password = document.getElementById("authPassword").value;
        try {
          await window.raffleDb.signIn(email, password);
          // ログイン画面は body 全体を差し替えて表示しているため、
          // ログイン成功後はページを再読み込みして通常のアプリDOMを復元する。
          // Supabaseはセッションを保持するので、再読み込み後に自動ログインされる。
          location.reload();
        } catch (err) { setAuthMessage(err.message || "ログインに失敗しました。"); }
      };
  };

  function setAuthMessage(msg) {
    const el = document.getElementById("authMessage");
    if (el) { el.textContent = msg; el.classList.add("show"); }
  }
  window.supabaseSignUp = async function () {
    const email = document.getElementById("authEmail")?.value.trim();
    const password = document.getElementById("authPassword")?.value;
    if (!email || !password) { setAuthMessage("メールアドレスとパスワードを入力してください。"); return; }
    try {
      const data = await window.raffleDb.signUp(email, password);
      if (data?.session) location.reload();
      else setAuthMessage("アカウントを作成しました。確認メールが届いた場合は、メール確認後にログインしてください。");
    } catch (err) { setAuthMessage(err.message || "アカウント作成に失敗しました。"); }
  };
  window.saveSupabaseSetup = async function () {
    const url = document.getElementById("sbUrl")?.value.trim();
    const key = document.getElementById("sbKey")?.value.trim();
    if (!url || !key) { alert("Project URLとPublishable keyを入力してください。"); return; }
    if (/service_role|secret/i.test(key)) { alert("Secret / service_role keyは使用しないでください。Publishable keyを入力してください。"); return; }
    saveConfig(url, key);
    location.reload();
  };
  function escSafe(v) { return String(v || "").replace(/[&<>\"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m])); }

  window.bootRaffleApp = async function () {
    if (!window.raffleDb.isConfigured()) { showDatabaseSetup(); return; }
    try {
      await window.raffleDb.init();
      if (!window.raffleDb.user) { showAuthScreen(); return; }
      await window.bootAfterAuth();
    } catch (err) {
      console.error(err);
      showDatabaseSetup();
      alert("Supabaseへの接続に失敗しました。Project URLとPublishable keyを確認してください。\n\n" + (err.message || err));
    }
  };

  async function migrateLegacyIds() {
    const eventMap = new Map(), perfMap = new Map(), appMap = new Map(), productMap = new Map(), itemMap = new Map(), scheduleMap = new Map();
    const uuid = () => { try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch(e) {} return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==="x"?r:(r&3|8);return v.toString(16);}); };
    (events || []).forEach(e => { const n=uuid(); eventMap.set(String(e.id),n); e.id=n; });
    (events || []).forEach(e => (e.performances || []).forEach(p => { const n=uuid(); perfMap.set(String(p.id),n); p.id=n; }));
    (events || []).forEach(e => (e.applications || []).forEach(a => { const n=uuid(); appMap.set(String(a.id),n); a.id=n; a.performanceIds=(a.performanceIds||[]).map(x=>perfMap.get(String(x))||x); const st={}; Object.entries(a.performanceStatuses||{}).forEach(([k,v])=>st[perfMap.get(String(k))||k]=v); a.performanceStatuses=st; }));
    (products || []).forEach(p => { const n=uuid(); productMap.set(String(p.id),n); p.id=n; (p.items||[]).forEach(it=>{const ni=uuid();itemMap.set(String(it.id||ni),ni);it.id=ni;}); });
    (schedules || []).forEach(s => { const n=uuid(); scheduleMap.set(String(s.id),n); s.id=n; s.eventIds=(s.eventIds||[]).map(x=>eventMap.get(String(x))||x); (s.dailyPlans||[]).forEach(d=>{if(!d.id)d.id=uuid();}); });
  }

  function uuidFallback(){ try{if(window.crypto?.randomUUID)return window.crypto.randomUUID();}catch(e){} return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0,v=c==="x"?r:(r&3|8);return v.toString(16);}); }

  function localHasData() {
    return (events||[]).length || (products||[]).length || (schedules||[]).length;
  }

  function applyRemote(remote) {
    const perfsByEvent = new Map();
    (remote.performances||[]).forEach(r => {
      const p={id:r.id,dayName:r.name||"",date:r.date||"",open:r.doors_time?String(r.doors_time).slice(0,5):"",start:r.start_time?String(r.start_time).slice(0,5):"",venue:r.venue||"",performers:r.performers||"",memo:r.memo||""};
      if(!perfsByEvent.has(r.event_id)) perfsByEvent.set(r.event_id,[]); perfsByEvent.get(r.event_id).push(p);
    });
    const appsByEvent = new Map();
    (remote.applications||[]).forEach(r=>{
      const a={id:r.id,name:r.name||"",method:r.method||"抽選",ticketSiteName:r.ticket_site_name||"",start:r.start_at||"",end:r.end_at||"",announcement:r.announcement_at||"",status:r.status||"未応募",quantity:r.quantity||1,payment:r.payment||"",memo:r.memo||"",performanceIds:[],performanceStatuses:{}};
      if(!appsByEvent.has(r.event_id))appsByEvent.set(r.event_id,[]);appsByEvent.get(r.event_id).push(a);
    });
    (remote.application_performances||[]).forEach(r=>{
      const a=(remote.applications||[]).find(x=>x.id===r.application_id);
      if(!a)return; const target=(appsByEvent.get(a.event_id)||[]).find(x=>x.id===a.id); if(!target)return;
      target.performanceIds.push(r.performance_id);target.performanceStatuses[r.performance_id]=r.status||"未応募";
    });
    events=(remote.events||[]).map(r=>({id:r.id,name:r.name||"",type:r.type||"ライブ",performers:"",url:r.url||"",memo:r.memo||"",performances:(perfsByEvent.get(r.id)||[]).sort((a,b)=>String(a.date).localeCompare(String(b.date))),applications:appsByEvent.get(r.id)||[]})).map(normalizeEvent);

    const itemsByProduct=new Map();
    (remote.product_items||[]).forEach(r=>{if(!itemsByProduct.has(r.product_id))itemsByProduct.set(r.product_id,[]);itemsByProduct.get(r.product_id).push({id:r.id,name:r.name||"",price:r.price??0,quantity:r.quantity||1,secured:!!r.secured,purchased:!!r.purchased,url:r.url||"",memo:r.memo||""});});
    products=(remote.products||[]).map(r=>({id:r.id,name:r.name||"",type:r.type||"POP UP",start:r.start_at?String(r.start_at).slice(0,10):"",end:r.end_at?String(r.end_at).slice(0,10):"",venue:r.venue||"",url:r.url||"",image_url:r.image_url||"",memo:r.memo||"",price:r.price??null,purchased:!!r.purchased,items:itemsByProduct.get(r.id)||[]}));

    const daysBySchedule=new Map();
    (remote.schedule_days||[]).forEach(r=>{if(!daysBySchedule.has(r.schedule_id))daysBySchedule.set(r.schedule_id,[]);daysBySchedule.get(r.schedule_id).push({id:r.id,date:r.date,text:r.memo||""});});
    schedules=(remote.schedules||[]).map(r=>normalizeSchedule({id:r.id,name:r.name||"",date:r.start_date||"",endDate:r.end_date||r.start_date||"",meetingTime:r.meeting_time?String(r.meeting_time).slice(0,5):"",meetingPlace:r.meeting_place||"",startTime:r.start_time?String(r.start_time).slice(0,5):"",type:r.type||"一般予定",eventIds:Array.isArray(r.related_event_ids)?r.related_event_ids:[],related:"",url:r.url||"",memo:r.memo||"",dailyPlans:daysBySchedule.get(r.id)||[]}));
    const us=(remote.user_settings||[])[0];
    if(us)appSettings={...appSettings,prizePeriods:{"一番くじ":us.ichiban_period||30,"UFOキャッチャー":us.ufo_period||14,"その他景品":us.other_period||30}};
    localStorage.setItem(KEY.events,JSON.stringify(events));localStorage.setItem(KEY.products,JSON.stringify(products));localStorage.setItem(KEY.schedules,JSON.stringify(schedules));localStorage.setItem(KEY.settings,JSON.stringify(appSettings));
  }

  async function loadAllWithRetry() {
    let lastError = null;
    for (let i = 0; i < 3; i++) {
      try {
        return await window.raffleDb.loadAll();
      } catch (err) {
        lastError = err;
        // ログイン直後のJWT反映待ち。初回だけ失敗するケースを吸収する。
        if (i < 2) await new Promise(resolve => setTimeout(resolve, 300 * (i + 1)));
      }
    }
    throw lastError;
  }

  window.bootAfterAuth = async function () {
    try {
      const remote = await loadAllWithRetry();
      const remoteHasData = (remote.events||[]).length || (remote.products||[]).length || (remote.schedules||[]).length;
      if (remoteHasData) {
        applyRemote(remote);
      } else if (localHasData()) {
        await migrateLegacyIds();
        await window.raffleDb.syncAll({events,products,schedules,settings:appSettings});
      }
      window.raffleDb.client.auth.onAuthStateChange((event, session) => {
        window.raffleDb.user=session?.user||null;
        if(event === "SIGNED_OUT") location.reload();
      });
      updateApplicationStatuses();
      render();
      if (typeof window.showDbStatus === "function") window.showDbStatus();
    } catch (err) {
      console.error(err);
      alert("Databaseの読み込みに失敗しました。\n" + (err.message || err) + "\n\nログイン状態は維持しています。画面を更新せず、もう一度お試しください。");
      // Databaseの一時的な読み込み失敗でログイン画面へ戻さない。
      // セッション自体は有効なため、再試行できる状態を維持する。
    }
  };

  let syncTimer=null, syncPromise=Promise.resolve();
  window.queueRaffleSync=function(){
    if(!window.raffleDb?.user)return;
    clearTimeout(syncTimer);
    syncTimer=setTimeout(()=>{
      const snapshot={events:JSON.parse(JSON.stringify(events||[])),products:JSON.parse(JSON.stringify(products||[])),schedules:JSON.parse(JSON.stringify(schedules||[])),settings:JSON.parse(JSON.stringify(appSettings||{}))};
      syncPromise=syncPromise.then(()=>window.raffleDb.syncAll(snapshot)).catch(err=>{console.error(err); if(!document.hidden) alert("Databaseへの保存に失敗しました。\n"+(err.message||err));});
    },250);
  };

  window.raffleLogout=async function(){
    if(!confirm("ログアウトしますか？"))return;
    try{await window.raffleDb.signOut();location.reload();}catch(err){alert(err.message||"ログアウトに失敗しました。");}
  };

})();
