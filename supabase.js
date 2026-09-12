/* =========================================================
 * 抽選管理 - Supabase integration
 * ========================================================= */
(function () {
  function localDateTimeToISO(value) {
    if (!value) return null;

    const s = String(value).trim();

    // datetime-local形式
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
      const d = new Date(`${s}:00+09:00`);

      if (Number.isNaN(d.getTime())) {
        console.error("Invalid local datetime:", value);
        return null;
      }

      return d.toISOString();
    }

    // 秒まで含む形式
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
      const d = new Date(`${s}+09:00`);

      if (Number.isNaN(d.getTime())) {
        console.error("Invalid local datetime:", value);
        return null;
      }

      return d.toISOString();
    }

    console.error("Unsupported datetime format:", value);
    return null;
  }

  function isoToLocalDateTime(value) {
    if (!value) return "";

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
    console.error("Invalid date:", value);
    return "";
  }

    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
      .format(d)
      .replace(" ", "T");
  }

  const CONFIG_KEY = "raffle_supabase_config_v1";
  const cached = (() => {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
  })();

  function getConfig() {
    const base = window.RAFFLE_SUPABASE_CONFIG || {};
    return {
      url: cached.url || base.url || "",
      publishableKey: cached.publishableKey || base.publishableKey || "",
      vapidPublicKey: cached.vapidPublicKey || base.vapidPublicKey || ""
    };
  }

  function saveConfig(url, publishableKey) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: String(url || "").trim(), publishableKey: String(publishableKey || "").trim() }));
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(ch => ch.charCodeAt(0)));
  }

  async function getPushRegistration() {
    if (!('serviceWorker' in navigator)) throw new Error('このブラウザはService Workerに対応していません。');
    return navigator.serviceWorker.register('./sw.js', { scope: './' });
  }

  window.enableRafflePush = async function () {
    if (!window.raffleDb?.user) throw new Error('ログインしてください。');
    if (!('Notification' in window) || !('PushManager' in window)) throw new Error('このブラウザはプッシュ通知に対応していません。');
    const config = getConfig();
    if (!config.vapidPublicKey) throw new Error('VAPID公開鍵が設定されていません。supabase-config.js の vapidPublicKey を設定してください。');

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知の許可が必要です。ブラウザの通知設定も確認してください。');

    const registration = await getPushRegistration();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
      });
    }
    const json = subscription.toJSON();
    const payload = {
      user_id: window.raffleDb.user.id,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh || '',
      auth: json.keys?.auth || '',
      user_agent: navigator.userAgent,
      last_seen_at: new Date().toISOString()
    };
    if (!payload.endpoint || !payload.p256dh || !payload.auth) throw new Error('通知購読情報を取得できませんでした。');
    const { error } = await window.raffleDb.client.from('push_subscriptions').upsert(payload, { onConflict: 'endpoint' });
    if (error) throw error;
    return true;
  };

  window.disableRafflePush = async function () {
    if (!window.raffleDb?.user) return;
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration('./') || await getPushRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    const { error } = await window.raffleDb.client.from('push_subscriptions').delete().eq('user_id', window.raffleDb.user.id).eq('endpoint', endpoint);
    if (error) throw error;
    await subscription.unsubscribe();
  };

  window.getRafflePushStatus = async function () {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    let subscribed = false;
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      subscribed = !!(await reg?.pushManager?.getSubscription());
    } catch (_) {}
    return { permission, subscribed };
  };

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

      // 現在のDB状態を取得し、変更・追加・削除があった行だけ書き換える。
      // これまでの「親テーブルを全削除→全件INSERT」方式と違い、
      // 既存データを無駄に作り直さないため、データ量が増えても負荷を抑えられる。
      const remote = await this.loadAll();
      const uuid = () => uuidFallback();
      const same = (a, b, keys) => keys.every(k => (a?.[k] ?? null) === (b?.[k] ?? null));

      const desired = {
        events: (data.events || []).map(e => ({
          id: e.id, user_id: uid, name: e.name || "", type: e.type || null,
          performers: e.performers || null, url: e.url || null, memo: e.memo || null
        })),
        performances: [],
        applications: [],
        application_performances: [],
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
        schedule_days: []
      };

      // 既存の関連行IDを再利用するためのマップ。
      const remotePerfByPair = new Map((remote.application_performances || []).map(r => [`${r.application_id}:${r.performance_id}`, r]));
      const remoteDayByPair = new Map((remote.schedule_days || []).map(r => [`${r.schedule_id}:${r.date}`, r]));

      (data.events || []).forEach(e => {
        (e.performances || []).forEach(p => desired.performances.push({
          id: p.id, event_id: e.id, name: p.dayName || null, date: p.date,
          doors_time: p.open || null, start_time: p.start || null,
          venue: p.venue || null, performers: p.performers || null, memo: p.memo || null
        }));
        (e.applications || []).forEach(a => {
          desired.applications.push({
              id: a.id,
              event_id: e.id,
              name: a.name || null,
              method: a.method || null,
              ticket_site_name: a.ticketSiteName || null,
              start_at: localDateTimeToISO(a.start),
              end_at: localDateTimeToISO(a.end),
              announcement_at: localDateTimeToISO(a.announcement),
              status: a.status || null,
              quantity: Number(a.quantity || 1),
              payment: a.payment || null,
              memo: a.memo || null
          });
          (a.performanceIds || []).forEach(pid => {
            if (!pid) return;
            const old = remotePerfByPair.get(`${a.id}:${pid}`);
            desired.application_performances.push({
              id: old?.id || uuid(), application_id: a.id, performance_id: pid,
              status: (a.performanceStatuses || {})[pid] || a.status || "未応募"
            });
          });
        });
      });

      (data.products || []).forEach(p => (p.items || []).forEach(it => desired.product_items.push({
        id: it.id, product_id: p.id, name: it.name || "", price: Number(it.price || 0),
        quantity: Math.max(1, Number(it.quantity || 1)), secured: !!it.secured,
        purchased: !!it.purchased, url: it.url || null, memo: it.memo || null
      })));

      (data.schedules || []).forEach(s => (s.dailyPlans || []).forEach(d => {
        const old = remoteDayByPair.get(`${s.id}:${d.date}`);
        desired.schedule_days.push({
          id: d.id || old?.id || uuid(), schedule_id: s.id, date: d.date,
          start_time: null, end_time: null, memo: d.text || null
        });
      }));

      const configs = {
        events: {
          keys: ["id", "user_id", "name", "type", "performers", "url", "memo"],
          remote: remote.events || []
        },
        performances: {
          keys: ["id", "event_id", "name", "date", "doors_time", "start_time", "venue", "performers", "memo"],
          remote: remote.performances || []
        },
        applications: {
          keys: ["id", "event_id", "name", "method", "ticket_site_name", "start_at", "end_at", "announcement_at", "status", "quantity", "payment", "memo"],
          remote: remote.applications || []
        },
        application_performances: {
          keys: ["id", "application_id", "performance_id", "status"],
          remote: remote.application_performances || []
        },
        products: {
          keys: ["id", "user_id", "name", "type", "start_at", "end_at", "venue", "url", "image_url", "price", "purchased", "memo"],
          remote: remote.products || []
        },
        product_items: {
          keys: ["id", "product_id", "name", "price", "quantity", "secured", "purchased", "url", "memo"],
          remote: remote.product_items || []
        },
        schedules: {
          keys: ["id", "user_id", "name", "start_date", "end_date", "meeting_time", "meeting_place", "start_time", "type", "related_type", "related_id", "related_event_ids", "url", "memo"],
          remote: remote.schedules || []
        },
        schedule_days: {
          keys: ["id", "schedule_id", "date", "start_time", "end_time", "memo"],
          remote: remote.schedule_days || []
        }
      };

      const mapById = rows => new Map(rows.map(r => [r.id, r]));
      const deleteIds = (table, ids) => {
        if (!ids.length) return Promise.resolve();
        return this.client.from(table).delete().in("id", ids).then(({ error }) => {
          if (error) throw error;
        });
      };
      const upsertRows = (table, rows) => {
        if (!rows.length) return Promise.resolve();
        return this.client.from(table).upsert(rows, { onConflict: "id" }).then(({ error }) => {
          if (error) throw error;
        });
      };

      // 削除は子→親、追加・更新は親→子の順で実行。
      const order = [
        "application_performances", "schedule_days", "product_items",
        "applications", "performances", "events", "products", "schedules"
      ];
      const reverseOrder = [
        "events", "performances", "applications", "application_performances",
        "products", "product_items", "schedules", "schedule_days"
      ];

      for (const table of order) {
        const cfg = configs[table];
        const wanted = mapById(desired[table] || []);
        const remoteMap = mapById(cfg.remote);
        const removed = cfg.remote.filter(r => !wanted.has(r.id)).map(r => r.id);
        await deleteIds(table, removed);
      }

      for (const table of reverseOrder) {
        const cfg = configs[table];
        const wantedRows = desired[table] || [];
        const remoteMap = mapById(cfg.remote);
        const changed = wantedRows.filter(row => {
          const old = remoteMap.get(row.id);
          return !old || !same(row, old, cfg.keys);
        });
        await upsertRows(table, changed);
      }

      // 設定は1ユーザー1行なので、値が変わった場合だけ更新。
      const settings = {
        user_id: uid,
        ichiban_period: Number(data.settings?.prizePeriods?.["一番くじ"] || 30),
        ufo_period: Number(data.settings?.prizePeriods?.["UFOキャッチャー"] || 14),
        other_period: Number(data.settings?.prizePeriods?.["その他景品"] || 30),
        notify_deadline_1day: appSettings.notifications?.deadline1day !== false,
        notify_deadline_1hour: appSettings.notifications?.deadline1hour !== false
      };
      const oldSettings = (remote.user_settings || [])[0];
      const settingsKeys = ["user_id", "ichiban_period", "ufo_period", "other_period", "notify_deadline_1day", "notify_deadline_1hour"];
      if (!oldSettings || !same(settings, oldSettings, settingsKeys)) {
        const { error } = await this.client.from("user_settings").upsert(settings, { onConflict: "user_id" });
        if (error) throw error;
      }
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
      const a={  id:r.id,
                name:r.name||"",
                method:r.method||"抽選",
                ticketSiteName:r.ticket_site_name||"",
                start:isoToLocalDateTime(r.start_at),
                end:isoToLocalDateTime(r.end_at),
                announcement:isoToLocalDateTime(r.announcement_at),
                status:r.status||"未応募",
                quantity:r.quantity||1,
                payment:r.payment||"",
                memo:r.memo||"",
                performanceIds:[],
                performanceStatuses:{}};
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
    if(us)appSettings={...appSettings,prizePeriods:{"一番くじ":us.ichiban_period||30,"UFOキャッチャー":us.ufo_period||14,"その他景品":us.other_period||30},notifications:{deadline1day:us.notify_deadline_1day!==false,deadline1hour:us.notify_deadline_1hour!==false}};
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
