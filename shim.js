/* TRADECOM orders board — Supabase adapter.
   The board's own code talks to window.claude.use("db" | "assets" | "user" | "downloads");
   this file provides the same calls on top of Supabase, plus the sign-in gate (email + password, Google when enabled). */
(function(){
  const CFG = window.TC_CONFIG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.anonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  window.__sb = sb;
  const BUCKET = "files";
  // "#import" is lost when the sign-in link brings the browser back, so remember it for this tab
  let wantImport = false;
  try{ if(location.hash === "#import") sessionStorage.setItem("tcImport", "1"); wantImport = sessionStorage.getItem("tcImport") === "1"; }catch(e){ wantImport = location.hash === "#import"; }
  let readyResolve; const ready = new Promise(r => readyResolve = r);

  /* ---------- sign-in gate ---------- */
  const gate = document.createElement("div");
  gate.id = "tcGate";
  gate.innerHTML = `<div class="gbox"><h1>Заказы и отгрузки TRADECOM</h1><p id="gMsg">Проверяю вход…</p>
    <form id="gPw" hidden>
      <input type="email" id="gEmail" name="username" autocomplete="username" required placeholder="Почта" aria-label="Почта">
      <input type="password" id="gPass" name="password" autocomplete="current-password" required minlength="6" placeholder="Пароль" aria-label="Пароль">
      <button type="submit" class="btn primary">Войти</button>
      <button type="button" class="glnk" id="gSet">Первый вход или забыли пароль? Задать пароль</button>
    </form>
    <form id="gNew" hidden>
      <input type="email" id="gNewUser" name="username" autocomplete="username" readonly aria-label="Почта">
      <input type="password" id="gNewPass" name="new-password" autocomplete="new-password" required minlength="6" placeholder="Новый пароль, не короче 6 знаков" aria-label="Новый пароль">
      <button type="submit" class="btn primary">Сохранить пароль и войти</button>
    </form>
    <span class="gor" id="gOr" hidden>или</span>
    <button type="button" id="gGoogle" class="btn" hidden>Войти через Google</button>
    <button type="button" id="gOut" class="btn ghost" hidden>Выйти и войти другим аккаунтом</button></div>`;
  const css = document.createElement("style");
  css.textContent = `#tcGate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--bg,#f3f4f6);padding:16px}
#tcGate .gbox{max-width:380px;width:100%;background:var(--panel,#fff);border:1px solid var(--line,#dde1e6);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:12px;text-align:center}
#tcGate form{display:flex;flex-direction:column;gap:8px;margin:0}#tcGate .gor{font-size:12px;color:var(--muted,#5b6573)}
#tcGate .glnk{background:none;border:0;padding:4px;font:inherit;font-size:13px;color:var(--accent,#1d5a7a);text-decoration:underline;cursor:pointer}
#tcGate input[readonly]{opacity:.75}
#tcGate h1{font-size:20px;margin:0}#tcGate p{margin:0;color:var(--muted,#5b6573);font-size:14px}
#tcUser{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted,#5b6573)}
#tcImp{position:fixed;right:16px;bottom:16px;z-index:50;background:var(--panel,#fff);border:1px solid var(--line,#dde1e6);border-radius:12px;padding:12px;max-width:340px;font-size:13px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 18px rgba(0,0,0,.12)}`;
  document.head.appendChild(css);
  const mountGate = () => { if(!gate.isConnected) document.body.appendChild(gate); };
  if(document.body) mountGate(); else document.addEventListener("DOMContentLoaded", mountGate);
  const $g = id => gate.querySelector("#"+id);
  const say = t => { $g("gMsg").textContent = t; };

  async function signIn(){
    const back = location.origin + location.pathname;
    const { error } = await sb.auth.signInWithOAuth({ provider:"google", options:{ redirectTo: back, queryParams:{ prompt:"select_account" } } });
    if(error) say("Не получилось открыть вход Google: " + error.message);
  }
  const BACK = () => location.origin + location.pathname;
  const PWKEY = "tcSetPw";
  const mem = { get(){ try{ return localStorage.getItem(PWKEY) || ""; }catch(e){ return ""; } }, set(v){ try{ v ? localStorage.setItem(PWKEY, v) : localStorage.removeItem(PWKEY); }catch(e){} } };
  const mailErr = m => /rate|limit|seconds/i.test(m) ? "Слишком много писем подряд. Подождите минуту и попробуйте снова." : m;
  async function allowedEmail(email){
    const ok = await sb.rpc("can_sign_in", { e: email });
    if(ok.error){ say("Нет связи с базой: " + ok.error.message); return false; }
    if(!ok.data){ say("У " + email + " нет доступа к доске. Попросите владельца добавить эту почту."); return false; }
    return true;
  }
  // email + password; the browser offers to remember both
  async function pwSignIn(e){
    e.preventDefault();
    const email = $g("gEmail").value.trim().toLowerCase(), password = $g("gPass").value;
    say("Вхожу…");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if(error) say(/invalid/i.test(error.message) ? "Неверная почта или пароль. Если входите впервые или забыли пароль — нажмите «Задать пароль»." : /confirm/i.test(error.message) ? "Почта ещё не подтверждена — откройте письмо от Supabase." : "Не получилось войти: " + error.message);
  }
  // first time or forgotten: one email with a link, then the new password is typed here
  async function pwRequest(){
    const email = $g("gEmail").value.trim().toLowerCase();
    if(!email || !$g("gEmail").checkValidity()){ say("Сначала впишите свою почту."); $g("gEmail").focus(); return; }
    say("Проверяю почту…");
    if(!(await allowedEmail(email))) return;
    mem.set(email);
    const tmp = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("") + "Aa1!";
    let { data, error } = await sb.auth.signUp({ email, password: tmp, options: { emailRedirectTo: BACK() } });
    const exists = (error && /already|registered|exists/i.test(error.message)) || (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);
    if(exists) ({ error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: BACK() }));
    if(error){ mem.set(""); say("Не получилось отправить письмо: " + mailErr(error.message)); return; }
    if(data && data.session && !exists){ askNewPassword(email); return; }
    say("Письмо отправлено на " + email + ". Откройте его в этом браузере и нажмите ссылку — потом здесь же придумаете пароль.");
  }
  function askNewPassword(email){
    say("Придумайте пароль для " + email + ". Браузер предложит его запомнить.");
    $g("gPw").hidden = true; $g("gOr").hidden = true; $g("gGoogle").hidden = true; $g("gOut").hidden = true;
    $g("gNew").hidden = false; $g("gNewUser").value = email; $g("gNewPass").focus();
  }
  async function pwSave(e){
    e.preventDefault();
    say("Сохраняю пароль…");
    const { data, error } = await sb.auth.updateUser({ password: $g("gNewPass").value });
    if(error){ say(/same|different/i.test(error.message) ? "Этот пароль уже стоит. Придумайте другой или просто войдите." : "Не получилось сохранить пароль: " + error.message); return; }
    mem.set(""); recovering = false; $g("gNew").hidden = true;
    const s2 = (await sb.auth.getSession()).data.session; check(s2);
  }
  async function signOut(){ await sb.auth.signOut(); location.reload(); }
  gate.addEventListener("submit", e => { if(e.target.id === "gPw") pwSignIn(e); if(e.target.id === "gNew") pwSave(e); });
  gate.addEventListener("click", e => { if(e.target.id==="gGoogle") signIn(); if(e.target.id==="gOut") signOut(); if(e.target.id==="gSet") pwRequest(); });
  let recovering = false;

  // the Google button shows only once Google sign-in is switched on in Supabase
  let googleOn = true;
  const settings = fetch(CFG.url + "/auth/v1/settings", { headers: { apikey: CFG.anonKey } }).then(r => r.ok ? r.json() : null)
    .then(j => { if(j && j.external) googleOn = !!j.external.google; }).catch(() => {});
  let started = false;
  // getSession and onAuthStateChange both report the same session; only the first may run the check
  let checking = false;
  async function check(session){
    if(started || (session && checking)) return;
    if(session) checking = true;
    try { await check1(session); } finally { checking = false; }
  }
  async function check1(session){
    if(!session){ say("Войдите, чтобы открыть доску."); $g("gPw").hidden=false; $g("gGoogle").hidden=!googleOn; $g("gOr").hidden=!googleOn; $g("gOut").hidden=true; return; }
    const email = session.user && session.user.email || "";
    // back from the password email: set the password before opening the board
    if(recovering || (mem.get() && mem.get() === email.toLowerCase())){ askNewPassword(email); return; }
    say("Проверяю доступ для " + email + "…");
    const { data, error } = await sb.rpc("is_allowed");
    if(error){ say("Нет связи с базой: " + error.message); $g("gOut").hidden=false; return; }
    if(!data){ say("У " + email + " нет доступа к доске. Попросите владельца добавить эту почту."); $g("gGoogle").hidden=true; $g("gOr").hidden=true; $g("gPw").hidden=true; $g("gOut").hidden=false; return; }
    started = true;
    gate.remove();
    showUser(email);
    readyResolve(true);
    if(wantImport) importPanel();
  }
  function showUser(email){
    const top = document.querySelector("header.top > div:last-child");
    if(!top) return;
    if(document.getElementById("tcUser")) return;
    const box = document.createElement("span"); box.id = "tcUser";
    box.innerHTML = `<span></span><button type="button" class="btn ghost">Выйти</button>`;
    box.firstChild.textContent = email;
    box.querySelector("button").onclick = signOut;
    top.prepend(box);
  }
  // the gate and the user badge need the page's markup, so sign-in is checked once the document is parsed
  const domReady = new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
  domReady.then(() => {
    Promise.race([settings, new Promise(r => setTimeout(r, 2500))]).then(() => sb.auth.getSession()).then(({data}) => check(data.session));
    sb.auth.onAuthStateChange((ev, session) => { if(ev === "PASSWORD_RECOVERY") recovering = true; if(session) setTimeout(() => check(session), 0); });
  });

  /* ---------- db: collections of JSON documents ---------- */
  const err = (e, code) => Object.assign(new Error(e && e.message || String(e)), { code: code || (e && e.code) || "unavailable" });
  function snapOf(rows){ return { docs: rows.map(r => ({ id: r.id, exists: true, data: () => JSON.parse(JSON.stringify(r.data || {})) })) }; }
  function collection(coll){
    return {
      doc(id){
        return {
          async set(v){ const { error } = await sb.from("docs").upsert({ coll, id, data: v, updated_at: new Date().toISOString() }); if(error) throw err(error); },
          async update(v){ const { error } = await sb.rpc("doc_merge", { c: coll, i: id, patch: v }); if(error) throw err(error); },
          async delete(){ const { error } = await sb.from("docs").delete().eq("coll", coll).eq("id", id); if(error) throw err(error); },
          async get(){ const { data, error } = await sb.from("docs").select("id,data").eq("coll", coll).eq("id", id).maybeSingle(); if(error) throw err(error);
            return data ? { id, exists: true, data: () => data.data } : { id, exists: false, data: () => undefined }; }
        };
      },
      onSnapshot(cb, onErr){
        let alive = true, t = null;
        const load = async () => {
          const { data, error } = await sb.from("docs").select("id,data").eq("coll", coll).limit(10000);
          if(!alive) return;
          if(error){ onErr && onErr(err(error)); return; }
          cb(snapOf(data || []));
        };
        const soon = () => { clearTimeout(t); t = setTimeout(load, 150); };
        const ch = sb.channel("docs-" + coll + "-" + Math.random().toString(36).slice(2))
          .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "coll=eq." + coll }, soon)
          .subscribe();
        const onFocus = () => soon();
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", () => { if(!document.hidden) soon(); });
        load();
        return () => { alive = false; window.removeEventListener("focus", onFocus); sb.removeChannel(ch); };
      }
    };
  }
  const db = { collection };

  /* ---------- assets: private file storage, served to the page as "/_blob/<id>" ---------- */
  const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  const assets = {
    async upload(blob, opt){
      const id = hex(), type = (opt && opt.type) || blob.type || "application/octet-stream";
      const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType: type, upsert: false });
      if(error){ const m = String(error.message || ""); throw err(error, /exceed|too large|size/i.test(m) ? "too_large" : /quota/i.test(m) ? "quota_exceeded" : "store_unavailable"); }
      return { id, url: "/_blob/" + id, sizeBytes: blob.size, contentType: type };
    },
    async delete(id){ const { error } = await sb.storage.from(BUCKET).remove([id]); if(error) throw err(error); return { deleted: true }; },
    async list(){
      let all = [], off = 0;
      for(;;){ const { data, error } = await sb.storage.from(BUCKET).list("", { limit: 1000, offset: off }); if(error) throw err(error);
        all = all.concat(data || []); if(!data || data.length < 1000) break; off += 1000; }
      const files = all.filter(f => f.id);
      const bytes = files.reduce((s, f) => s + (f.metadata && f.metadata.size || 0), 0);
      return { assets: files.map(f => ({ id: f.name, url: "/_blob/" + f.name, contentType: f.metadata && f.metadata.mimetype, sizeBytes: f.metadata && f.metadata.size || 0, createdAt: f.created_at })),
               usage: { files: files.length, bytes, maxFiles: 100000, maxBytes: (CFG.storageGB || 1) * 1073741824 } };
    }
  };
  // the board reads stored files with fetch("/_blob/<id>") and <img src="/_blob/<id>">
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(u, o){
    const s = typeof u === "string" ? u : (u && u.url) || "";
    const m = s.match(/(?:^|\/)_blob\/([0-9a-f]{32})/);
    if(m) return sb.storage.from(BUCKET).download(m[1]).then(({ data, error }) => error ? new Response(null, { status: 404 }) : new Response(data, { status: 200, headers: { "Content-Type": data.type || "application/octet-stream" } }));
    return nativeFetch(u, o);
  };
  const fixImg = img => { const m = (img.getAttribute("src") || "").match(/^\/_blob\/([0-9a-f]{32})/); if(!m) return;
    img.removeAttribute("src");
    sb.storage.from(BUCKET).createSignedUrl(m[1], 3600).then(({ data }) => { if(data) img.src = data.signedUrl; }); };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if(n.nodeType !== 1) return;
    if(n.tagName === "IMG") fixImg(n); n.querySelectorAll && n.querySelectorAll('img[src^="/_blob/"]').forEach(fixImg); })))
    .observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- downloads: a normal browser download ---------- */
  const downloads = { async save({ filename, data }){
    const b = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  } };

  const user = { can: async () => true, isOwner: () => true, canEdit: () => true };

  window.claude = { use: async name => { await ready; return { db, assets, downloads, user }[name] || null; } };

  /* ---------- one-time import of the export from the Claude board (open the site with #import) ---------- */
  function importPanel(){
    const p = document.createElement("div"); p.id = "tcImp";
    p.innerHTML = `<button type="button" class="btn ghost" id="impX" aria-label="Закрыть" style="position:absolute;top:6px;right:6px;padding:2px 8px">✕</button><b>Перенос данных из Claude</b><span>Выберите файл экспорта (.zip), который подготовил Claude.</span><input type="file" accept=".zip"><span class="note" id="impNote"></span>`;
    document.body.appendChild(p);
    p.style.position = "fixed";
    p.querySelector("#impX").onclick = () => { try{ sessionStorage.removeItem("tcImport"); }catch(e){} if(location.hash === "#import") history.replaceState(null, "", location.pathname); p.remove(); };
    const note = t => { p.querySelector("#impNote").textContent = t; };
    p.querySelector("input").onchange = async e => {
      const f = e.target.files[0]; if(!f) return;
      try{
        const z = await JSZip.loadAsync(f);
        const meta = JSON.parse(await z.file("data.json").async("string"));
        const ids = Object.keys(meta.files || {});
        let n = 0;
        for(const id of ids){
          const zf = z.file("files/" + id); if(!zf) continue;
          const blob = new Blob([await zf.async("uint8array")], { type: meta.files[id] });
          const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType: meta.files[id], upsert: true });
          if(error) throw error;
          note(`Файлы: ${++n} из ${ids.length}…`);
        }
        const rows = [];
        for(const coll of ["orders", "buyers", "events"]) (meta[coll] || []).forEach(d => rows.push({ coll, id: d.id, data: d.data, updated_at: new Date().toISOString() }));
        if(rows.length){ const { error } = await sb.from("docs").upsert(rows); if(error) throw error; }
        note(`Готово: ${rows.length} записей и ${n} файлов перенесено. Обновите страницу.`);
        try{ sessionStorage.removeItem("tcImport"); }catch(e){}
      }catch(x){ note("Ошибка переноса: " + (x && x.message || x)); }
    };
  }
})();
