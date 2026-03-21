<script type="module">
  import { 
    signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut 
  } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
  import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, serverTimestamp, writeBatch, query, where
  } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

  const { auth, db } = window.firebaseRefs;
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));

  // DOM refs
  const authSection = $("#authSection");
  const judgeSection = $("#judgeSection");
  const adminSection = $("#adminSection");
  const userInfo = $("#userInfo");
  const btnSignOut = $("#btnSignOut");
  const emailEl = $("#email");
  const passwordEl = $("#password");
  const btnSignIn = $("#btnSignIn");
  const btnRegister = $("#btnRegister");
  const authMsg = $("#authMsg");
  const eventTitleEl = $("#eventTitle");
  const yearEl = $("#year");
  const judgeAssignmentsEl = $("#judgeAssignments");
  const judgeProgressEl = $("#judgeProgress");
  const panelTitleEl = $("#panelTitle");
  const metricsFormEl = $("#metricsForm");
  const saveStatusEl = $("#saveStatus");

  // Admin DOM
  const itemsPerJudgeEl = $("#itemsPerJudge");
  const ratingsPerItemBaseEl = $("#ratingsPerItemBase");
  const useAnchorsEl = $("#useAnchors");
  const anchorFractionEl = $("#anchorFraction");
  const anchorExtraRoundsEl = $("#anchorExtraRounds");
  const assignmentStrategyEl = $("#assignmentStrategy");
  const aggregatorEl = $("#aggregator");
  const shrinkageEl = $("#shrinkage");
  const btnSaveSettings = $("#btnSaveSettings");
  const btnGenerateAssignments = $("#btnGenerateAssignments");
  const kpiPosters = $("#kpiPosters");
  const kpiJudges = $("#kpiJudges");
  const kpiEdges = $("#kpiEdges");
  const kpiComplete = $("#kpiComplete");
  const scoresTableBody = $("#scoresTable tbody");
  const usersTableBody = $("#usersTable tbody");
  const btnExportScores = $("#btnExportScores");

  const btnSuggest = $("#btnSuggest");
  const algoSelect = $("#algoSelect");
  const hybridAlphaEl = $("#hybridAlpha");
  const btnComputeRanking = $("#btnComputeRanking");
  const btnExportRanking = $("#btnExportRanking");
  const algoMsg = $("#algoMsg");
  const rankingTableBody = $("#rankingTable tbody");

  yearEl.textContent = new Date().getFullYear();

  // Globals
  let CONFIG = null;     // from config.json
  let SETTINGS = null;   // from Firestore settings/current
  let METRICS = [];      // metrics from SETTINGS/CONFIG
  let POSTERS = [];      // posters from Firestore
  let USER = null;       // auth user
  let USERDOC = null;    // user profile (role)
  let ASSIGNED = [];     // poster ids assigned to this judge
  let SCORES_CACHE = new Map(); // key `${uid}_${posterId}` -> score doc
  let ASSIGNMENTS_MAP = new Map(); // uid -> [posterIds]

  // ---- helpers ----
  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error("Failed to load "+path);
    return res.json();
  }
  function toast(el, text, cls="small") {
    el.textContent = text; el.className = "small "+cls;
    setTimeout(()=>{ el.textContent=""; el.className="small"; }, 2000);
  }
  function nowIso(dt){ return dt ? new Date(dt.seconds*1000).toLocaleString() : ""; }

  // ---- Firestore model helpers ----
  async function ensureSettingsFromConfig(cfg) {
    const ref = doc(db, "settings", "current");
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...cfg.defaults,
        eventTitle: cfg.eventTitle,
        metrics: cfg.metrics,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
  }
  async function seedPostersIfMissing(cfg) {
    const postersRef = collection(db, "posters");
    const postersSnap = await getDocs(postersRef);
    if (postersSnap.empty) {
      const batch = writeBatch(db);
      cfg.posters.forEach(p => batch.set(doc(db, "posters", p.id), { title: p.title }));
      await batch.commit();
    }
  }
  async function getSettings() {
    const s = await getDoc(doc(db, "settings", "current"));
    return s.exists() ? s.data() : null;
  }
  async function setUserRole(uid, role) {
    await setDoc(doc(db, "users", uid), { role }, { merge: true });
  }
  function listenUsers(cb) {
    return onSnapshot(collection(db, "users"), snap => {
      const users = [];
      snap.forEach(d => users.push({ id: d.id, ...d.data() }));
      cb(users);
    });
  }
  function listenPosters(cb) {
    return onSnapshot(collection(db, "posters"), snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      POSTERS = arr;
      kpiPosters.textContent = arr.length;
      cb(arr);
    });
  }
  function listenAssignments(cb) {
    return onSnapshot(collection(db, "assignments"), snap => {
      const map = new Map();
      snap.forEach(d => map.set(d.id, d.data().posterIds || []));
      ASSIGNMENTS_MAP = map;
      cb(map);
    });
  }
  function listenScores(cb) {
    return onSnapshot(collection(db, "scores"), snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      cb(arr);
    });
  }
  async function getUserDoc(uid) {
    const s = await getDoc(doc(db, "users", uid));
    return s.exists() ? s.data() : null;
  }

  // ---- Auth ----
  btnSignIn.addEventListener("click", async () => {
    authMsg.textContent = "";
    try {
      await signInWithEmailAndPassword(auth, emailEl.value.trim(), passwordEl.value);
    } catch (e) {
      authMsg.textContent = e.message;
    }
  });
  btnRegister.addEventListener("click", async () => {
    authMsg.textContent = "";
    try {
      const cred = await createUserWithEmailAndPassword(auth, emailEl.value.trim(), passwordEl.value);
      // Default role = judge
      await setDoc(doc(db, "users", cred.user.uid), {
        email: cred.user.email || "",
        name: cred.user.email?.split("@")[0] || "Judge",
        role: "judge",
        createdAt: serverTimestamp()
      });
    } catch (e) {
      authMsg.textContent = e.message;
    }
  });
  btnSignOut.addEventListener("click", async () => {
    await signOut(auth);
  });

  onAuthStateChanged(auth, async (u) => {
    USER = u;
    if (!u) {
      userInfo.textContent = "Not signed in";
      btnSignOut.style.display = "none";
      authSection.style.display = "";
      judgeSection.style.display = "none";
      adminSection.style.display = "none";
      return;
    }
    userInfo.textContent = u.email || u.uid;
    btnSignOut.style.display = "";
    authSection.style.display = "none";

    // Profile
    USERDOC = await getUserDoc(USER.uid);
    if (!USERDOC) {
      await setDoc(doc(db, "users", USER.uid), { email: USER.email || "", role: "judge" }, { merge: true });
      USERDOC = { role: "judge" };
    }

    // init config + settings + posters
    CONFIG = await loadJSON("config.json");
    await ensureSettingsFromConfig(CONFIG);
    await seedPostersIfMissing(CONFIG);
    SETTINGS = await getSettings();
    METRICS = SETTINGS.metrics || CONFIG.metrics;
    eventTitleEl.textContent = SETTINGS.eventTitle || CONFIG.eventTitle;
    // preload admin controls
    itemsPerJudgeEl.value = SETTINGS.itemsPerJudge ?? CONFIG.defaults.itemsPerJudge;
    ratingsPerItemBaseEl.value = SETTINGS.ratingsPerItemBase ?? CONFIG.defaults.ratingsPerItemBase;
    useAnchorsEl.value = String(SETTINGS.useAnchors ?? CONFIG.defaults.useAnchors);
    anchorFractionEl.value = SETTINGS.anchorFraction ?? CONFIG.defaults.anchorFraction;
    anchorExtraRoundsEl.value = SETTINGS.anchorExtraRounds ?? CONFIG.defaults.anchorExtraRounds;
    assignmentStrategyEl.value = SETTINGS.assignmentStrategy ?? CONFIG.defaults.assignmentStrategy;
    aggregatorEl.value = SETTINGS.aggregator ?? CONFIG.defaults.aggregator;
    shrinkageEl.value = SETTINGS.shrinkage ?? CONFIG.defaults.shrinkage;

    // views
    if (USERDOC.role === "admin") {
      adminSection.style.display = "";
      judgeSection.style.display = "none";
      initAdmin();
    } else {
      judgeSection.style.display = "";
      adminSection.style.display = "none";
      initJudge();
    }
  });

  // ---- Judge view ----
  function initJudge() {
    // My assignments
    onSnapshot(doc(db, "assignments", USER.uid), snap => {
      const ids = (snap.exists() ? snap.data().posterIds : []) || [];
      ASSIGNED = ids;
      renderJudgeAssignments(ids);
      updateJudgeProgress();
    });
  }

  function renderJudgeAssignments(ids) {
    judgeAssignmentsEl.innerHTML = "";
    ids.forEach(pid => {
      const poster = POSTERS.find(p => p.id === pid) || { id: pid, title: pid };
      const div = document.createElement("div");
      div.className = "poster-card";
      div.innerHTML = \`
        <h4>\${poster.title}</h4>
        <span class="small mono">\${poster.id}</span>
        <div class="progress" style="margin-top:8px;"><div id="prog_\${pid}"></div></div>
        <div class="small" id="stat_\${pid}"></div>
        <button class="ghost" data-open="\${pid}" style="margin-top:8px;">Open</button>
      \`;
      judgeAssignmentsEl.appendChild(div);
    });

    judgeAssignmentsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-open]");
      if (!btn) return;
      openScorePanel(btn.getAttribute("data-open"));
    }, { once: true });
  }

  function computeCompletionForScoreDoc(sd){
    const m = sd.metrics || {};
    let filled = 0; for(const def of METRICS){ if (m[def.id] !== undefined && m[def.id] !== null) filled++; }
    return Math.round((filled / METRICS.length) * 100);
  }

  function updateJudgeProgress() {
    // find score docs for this judge
    const unsub = onSnapshot(collection(db, "scores"), snap => {
      let completed = 0;
      let total = ASSIGNED.length;
      const perPoster = new Map();
      snap.forEach(d => {
        const sd = { id: d.id, ...d.data() };
        if (sd.uid !== USER.uid) return;
        perPoster.set(sd.posterId, sd);
      });
      ASSIGNED.forEach(pid => {
        const sd = perPoster.get(pid);
        const pct = sd ? computeCompletionForScoreDoc(sd) : 0;
        const prog = document.getElementById("prog_"+pid);
        if (prog) prog.style.width = pct + "%";
        const st = document.getElementById("stat_"+pid);
        if (st) st.textContent = sd ? ("Updated: "+ nowIso(sd.updatedAt)) : "Not started";
        if (pct === 100) completed++;
      });
      judgeProgressEl.textContent = completed + " / " + total + " complete";
    });
  }

  function openScorePanel(posterId) {
    const poster = POSTERS.find(p => p.id === posterId) || { id: posterId, title: posterId };
    panelTitleEl.textContent = poster.title + " (" + poster.id + ")";
    metricsFormEl.innerHTML = "";
    METRICS.forEach(def => {
      const row = document.createElement("div");
      row.className = "metric";
      row.innerHTML = \`
        <label>\${def.label}</label>
        <input class="slider" type="range" id="m_\${def.id}" min="\${def.min}" max="\${def.max}" step="\${def.step}" />
        <input type="number" id="n_\${def.id}" min="\${def.min}" max="\${def.max}" step="\${def.step}" style="width:64px;" />
      \`;
      metricsFormEl.appendChild(row);
    });

    // Load existing
    const scoreId = USER.uid + "_" + posterId;
    const sref = doc(db, "scores", scoreId);
    onSnapshot(sref, snap => {
      const sd = snap.exists() ? snap.data() : { metrics: {} };
      for (const def of METRICS) {
        const val = sd.metrics?.[def.id];
        const slider = $("#m_"+def.id); const num = $("#n_"+def.id);
        if (val !== undefined) { slider.value = val; num.value = val; }
        else { slider.value = ""; num.value = ""; }
      }
    });

    function autosave() {
      saveStatusEl.textContent = "Saving..."; saveStatusEl.className = "small save-pending";
      const metrics = {};
      for (const def of METRICS) {
        const slider = $("#m_"+def.id); const num = $("#n_"+def.id);
        const val = Number(num.value || slider.value);
        if (!Number.isFinite(val)) continue;
        metrics[def.id] = val;
      }
      setDoc(sref, {
        uid: USER.uid,
        posterId,
        metrics,
        updatedAt: serverTimestamp()
      }, { merge: true }).then(()=>{
        saveStatusEl.textContent = "Saved"; saveStatusEl.className = "small save-ok";
        setTimeout(()=>{ saveStatusEl.textContent=""; saveStatusEl.className="small"; }, 1000);
      }).catch(err=>{
        saveStatusEl.textContent = "Error: "+err.message; saveStatusEl.className = "small save-error";
      });
    }

    // slider + number inputs sync & autosave
    METRICS.forEach(def => {
      const slider = $("#m_"+def.id); const num = $("#n_"+def.id);
      slider.addEventListener("input", () => { num.value = slider.value; autosave(); });
      num.addEventListener("input", () => { slider.value = num.value; autosave(); });
    });
  }

  // ---- Admin view ----
  function initAdmin() {
    // Users
    listenUsers(users => {
      kpiJudges.textContent = users.filter(u => u.role === "judge").length;
      usersTableBody.innerHTML = "";
      users.forEach(u => {
        const tr = document.createElement("tr");
        tr.innerHTML = \`
          <td>\${u.name||""}</td>
          <td>\${u.email||u.id}</td>
          <td>\${u.role||"judge"}</td>
          <td>
            <button class="ghost" data-role="\${u.role==='admin'?'judge':'admin'}" data-uid="\${u.id}">
              Make \${u.role==='admin'?'judge':'admin'}
            </button>
          </td>\`;
        usersTableBody.appendChild(tr);
      });
    });
    usersTableBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-role]"); if (!btn) return;
      const uid = btn.getAttribute("data-uid"); const role = btn.getAttribute("data-role");
      if (!confirm("Change role of "+uid+" to "+role+"?")) return;
      await setUserRole(uid, role);
    });

    // Posters live
    listenPosters(posters => {
      renderScoresTable(); // refresh with poster titles
    });
    // Assignments live
    listenAssignments(map => {
      renderKPIs();
    });
    // Scores live
    listenScores(scores => {
      SCORES_CACHE.clear();
      scores.forEach(s => SCORES_CACHE.set(s.id, s));
      renderScoresTable();
      renderKPIs();
    });

    // Save settings
    btnSaveSettings.addEventListener("click", async () => {
      const ref = doc(db, "settings", "current");
      await updateDoc(ref, {
        itemsPerJudge: Number(itemsPerJudgeEl.value),
        ratingsPerItemBase: Number(ratingsPerItemBaseEl.value),
        useAnchors: useAnchorsEl.value === "true",
        anchorFraction: Number(anchorFractionEl.value),
        anchorExtraRounds: Number(anchorExtraRoundsEl.value),
        assignmentStrategy: assignmentStrategyEl.value,
        aggregator: aggregatorEl.value,
        shrinkage: Number(shrinkageEl.value),
        updatedAt: serverTimestamp()
      });
      algoMsg.textContent = "Settings saved.";
      setTimeout(()=>algoMsg.textContent="", 1500);
    });

    // Generate assignments
    btnGenerateAssignments.addEventListener("click", async () => {
      const judges = await getJudgeUids();
      const posterIds = POSTERS.map(p => p.id);
      const k = Number(itemsPerJudgeEl.value);
      const r = Number(ratingsPerItemBaseEl.value);
      const useAnchors = (useAnchorsEl.value === "true");
      const anchorFraction = Number(anchorFractionEl.value);
      const anchorExtraRounds = Number(anchorExtraRoundsEl.value);
      const strategy = assignmentStrategyEl.value;
      const blocks = generateBlocks(posterIds, k, r, strategy, useAnchors, anchorFraction, anchorExtraRounds);
      const map = distributeBlocksToJudges(blocks, judges);
      await writeAssignments(map);
      algoMsg.textContent = "Assignments generated.";
      setTimeout(()=>algoMsg.textContent="", 1500);
    });

    btnExportScores.addEventListener("click", () => exportScoresCSV());

    btnSuggest.addEventListener("click", () => {
      const suggestion = suggestAlgorithm();
      algoSelect.value = suggestion.algo;
      algoMsg.textContent = suggestion.reason;
    });

    btnComputeRanking.addEventListener("click", () => {
      const algo = algoSelect.value;
      const alpha = Number(hybridAlphaEl.value);
      const shrink = Number(shrinkageEl.value);
      const ranking = computeRanking(algo, alpha, shrink);
      renderRanking(ranking);
    });

    btnExportRanking.addEventListener("click", () => exportRankingCSV());
  }

  async function getJudgeUids() {
    const qs = await getDocs(collection(db, "users"));
    const arr = [];
    qs.forEach(d => { const u=d.data(); if (u.role==='judge') arr.push(d.id); });
    return arr;
  }

  function renderKPIs() {
    // expected edges from assignments
    let expected = 0;
    ASSIGNMENTS_MAP.forEach(ids => expected += ids.length);
    const complete = Array.from(SCORES_CACHE.values())
      .filter(s => {
        const m = s.metrics || {}; let filled=0; for(const def of METRICS){ if (m[def.id]!==undefined) filled++; }
        return filled === METRICS.length;
      }).length;
    kpiEdges.textContent = complete.toString();
    const ratio = expected ? Math.round(100 * complete / expected) : 0;
    kpiComplete.textContent = ratio + "%";
  }

  function renderScoresTable() {
    // group by poster
    const perPoster = new Map();
    Array.from(SCORES_CACHE.values()).forEach(s => {
      if (!perPoster.has(s.posterId)) perPoster.set(s.posterId, []);
      perPoster.get(s.posterId).push(s);
    });
    scoresTableBody.innerHTML = "";
    POSTERS.forEach(p => {
      const arr = perPoster.get(p.id) || [];
      const last = arr.reduce((acc, s) => (!acc || (s.updatedAt?.seconds||0) > (acc.updatedAt?.seconds||0)) ? s : acc, null);
      const tr = document.createElement("tr");
      tr.innerHTML = \`<td class="mono">\${p.id}</td><td>\${p.title}</td><td>\${arr.length}</td><td>\${nowIso(last?.updatedAt) || ""}</td>\`;
      scoresTableBody.appendChild(tr);
    });
  }

  async function writeAssignments(map) {
    const batch = writeBatch(db);
    map.forEach((ids, uid) => {
      batch.set(doc(db, "assignments", uid), { posterIds: ids, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }

  // ---- Assignment generation ----
  function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }
  function partitions(items, k){ const out=[]; const a=shuffle(items); for(let i=0;i<a.length;i+=k){ out.push(a.slice(i,i+k)); } return out; }
  function addPair(map,a,b){ const key=a<b? a+"|"+b : b+"|"+a; map.set(key,(map.get(key)||0)+1); }

  function assignRandomBalanced(posterIds, k, r){
    const blocks=[];
    for(let round=0; round<r; round++){ blocks.push(...partitions(posterIds,k)); }
    return blocks;
  }
  function assignNearBIBD(posterIds, k, r){
    const blocks=[]; const pairCount = new Map();
    const rnd = partitions(posterIds,k); blocks.push(...rnd);
    rnd.forEach(b=>{ for(let i=0;i<b.length;i++) for(let j=i+1;j<b.length;j++) addPair(pairCount,b[i],b[j]); });
    for(let rr=1; rr<r; rr++){
      const remaining = new Set(posterIds);
      while(remaining.size){
        const block=[]; const seed = remaining.values().next().value; remaining.delete(seed); block.push(seed);
        while(block.length<k && remaining.size){
          let best=null,score=Infinity;
          for(const cand of remaining){
            let sc=0; for(const x of block){ const key = x<cand? x+"|"+cand : cand+"|"+x; sc += (pairCount.get(key)||0); }
            if(sc<score){ score=sc; best=cand; }
          }
          remaining.delete(best); block.push(best);
        }
        blocks.push(block);
        for(let i=0;i<block.length;i++) for(let j=i+1;j<block.length;j++) addPair(pairCount,block[i],block[j]);
      }
    }
    return blocks;
  }
  function addAnchorRounds(blocks, posterIds, k, anchorIds, extraRounds){
    for(let rr=0; rr<extraRounds; rr++){
      const items = shuffle(posterIds);
      const anchors = shuffle(anchorIds);
      const used = new Set();
      while(used.size < posterIds.length){
        const block=[];
        for(const a of anchors){ if(!used.has(a) && block.length<k){ block.push(a); used.add(a); } }
        for(const it of items){ if(!used.has(it) && block.length<k){ block.push(it); used.add(it); } }
        blocks.push(block);
      }
    }
    return blocks;
  }

  function generateBlocks(posterIds, k, r, strategy, useAnchors, anchorFraction, anchorExtraRounds){
    let blocks = (strategy === "random") ? assignRandomBalanced(posterIds,k,r) : assignNearBIBD(posterIds,k,r);
    if (useAnchors){
      const num = Math.max(1, Math.round(posterIds.length * anchorFraction));
      const anchors = shuffle(posterIds).slice(0, num);
      blocks = addAnchorRounds(blocks, posterIds, k, anchors, anchorExtraRounds);
    }
    return blocks;
  }
  function distributeBlocksToJudges(blocks, judgeUids){
    const map = new Map(judgeUids.map(uid => [uid, []]));
    let idx = 0;
    for(const block of blocks){
      const uid = judgeUids[idx % judgeUids.length];
      map.get(uid).push(...block);
      idx++;
    }
    for(const [uid,list] of map){ map.set(uid, Array.from(new Set(list))); }
    return map;
  }

  // ---- Algorithm suggestion ----
  function suggestAlgorithm(){
    const k = Number(itemsPerJudgeEl.value);
    const r = Number(ratingsPerItemBaseEl.value);
    const strategy = assignmentStrategyEl.value;
    // crude connectivity proxy = avg unique pairs observed / max within blocks
    let pairSet = new Set();
    ASSIGNMENTS_MAP.forEach(ids => {
      const arr = ids.slice();
      for(let i=0;i<arr.length;i++) for(let j=i+1;j<arr.length;j++){
        const a=arr[i], b=arr[j]; const key = a<b? a+"|"+b : b+"|"+a; pairSet.add(key);
      }
    });
    const N = POSTERS.length;
    const maxPairs = N*(N-1)/2;
    const ratio = maxPairs ? pairSet.size / maxPairs : 0;

    if (r <= 2) {
      return { algo: "zscore_weighted", reason: "r ≤ 2 → prefer zscore_weighted for robust bias correction." };
    }
    if (r >= 3 && k >= 5 && ratio > 0.15 && strategy === "near_bibd") {
      return { algo: "hybrid", reason: "Good connectivity with r ≥ 3 → hybrid (zscore_weighted + rank centrality) tends to perform best." };
    }
    if (ratio > 0.25) {
      return { algo: "rankcentrality", reason: "Strong connectivity → rankcentrality can work well with relative comparisons." };
    }
    return { algo: "zscore_weighted", reason: "Defaulting to zscore_weighted as a stable choice under general conditions." };
  }

  // ---- Ranking algorithms ----
  function computeRanking(algo, alpha=0.7, shrink=10.0){
    // Build edges from complete score docs
    const metricIds = METRICS.map(m=>m.id);
    const itemIndex = new Map(POSTERS.map((p,i)=>[p.id, i]));
    const judgeIndex = new Map();
    let edgesItem=[], edgesJudge=[], edgesScores=[];
    Array.from(SCORES_CACHE.values()).forEach(sd => {
      const m = sd.metrics||{}; if (!metricIds.every(id => m[id]!==undefined)) return;
      const i = itemIndex.get(sd.posterId);
      if (!judgeIndex.has(sd.uid)) judgeIndex.set(sd.uid, judgeIndex.size);
      const j = judgeIndex.get(sd.uid);
      edgesItem.push(i); edgesJudge.push(j);
      edgesScores.push(metricIds.map(id => Number(m[id])));
    });
    const N = POSTERS.length, M = metricIds.length, E = edgesItem.length;
    if (E === 0) { algoMsg.textContent = "No complete scores yet."; return []; }

    function mean(arr){ return arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length); }
    function std(arr){ if(arr.length<2) return 0; const m=mean(arr); const v=arr.reduce((s,x)=>s+(x-m)*(x-m),0)/(arr.length-1); return Math.sqrt(v); }

    // global mean/std per metric
    const globalMean = Array(M).fill(0).map((_,m) => mean(edgesScores.map(r => r[m])));
    const globalStd = Array(M).fill(0).map((_,m) => std(edgesScores.map(r => r[m])) || 1e-8);

    // group by judge
    const byJudge = new Map();
    for(let e=0;e<E;e++){
      const j = edgesJudge[e];
      if(!byJudge.has(j)) byJudge.set(j, []);
      byJudge.get(j).push(e);
    }

    // z-score (with shrinkage)
    const Z = Array(E).fill(0).map(()=>Array(M).fill(0));
    const jWeight = new Map();
    byJudge.forEach((idxs, j) => {
      const n = idxs.length;
      const mean_j = Array(M).fill(0).map((_,m)=> mean(idxs.map(e=>edgesScores[e][m])) );
      const sd_j   = Array(M).fill(0).map((_,m)=> std(idxs.map(e=>edgesScores[e][m])) );
      const mean_sh = mean_j.map((mj,m)=> (n*mj + shrink*globalMean[m])/(n+shrink) );
      const var_sh  = sd_j.map((sj,m)=> (n*(sj*sj) + shrink*(globalStd[m]*globalStd[m]))/(n+shrink) );
      const sd_sh   = var_sh.map(v=> Math.sqrt(v)+1e-8 );
      idxs.forEach(e => {
        for(let m=0;m<M;m++){ Z[e][m] = (edgesScores[e][m] - mean_sh[m]) / sd_sh[m]; }
      });
      // residual dispersion for weight
      const comps = idxs.map(e => mean(Z[e]));
      const mC = mean(comps);
      const res = comps.map(c => c-mC);
      const s2 = mean(res.map(x=>x*x));
      const s2_sh = 0.5*s2 + 0.5*1.0;
      jWeight.set(j, 1/Math.max(1e-6, s2_sh));
    });

    function rank_from_scores_per_item(est){
      const arr = POSTERS.map((p,i)=>({ id:p.id, title:p.title, score: est[i]||0 }));
      arr.sort((a,b)=> (b.score - a.score));
      return arr;
    }

    if (algo === "naive") {
      // average raw metric means per edge -> item
      const comp = edgesScores.map(r => mean(r));
      const s=Array(N).fill(0), c=Array(N).fill(0);
      for(let e=0;e<E;e++){ s[edgesItem[e]] += comp[e]; c[edgesItem[e]] += 1; }
      const est = s.map((v,i)=> v/Math.max(1,c[i]));
      return rank_from_scores_per_item(est);
    }

    if (algo === "zscore" || algo === "zscore_weighted" || algo === "hybrid") {
      // z-score composites
      const compZ = Z.map(r => mean(r));
      const s=Array(N).fill(0), w=Array(N).fill(0);
      for(let e=0;e<E;e++){
        const i = edgesItem[e], j = edgesJudge[e];
        const ww = (algo==="zscore_weighted" || algo==="hybrid") ? (jWeight.get(j)||1.0) : 1.0;
        s[i] += ww * compZ[e]; w[i] += ww;
      }
      const estZ = s.map((v,i)=> v/Math.max(1e-8,w[i]));
      if (algo !== "hybrid") return rank_from_scores_per_item(estZ);

      // hybrid: blend with rank centrality
      const estRC = rankCentralityFromZ(Z, edgesItem, edgesJudge, N);
      // normalize
      const zMean = mean(estZ), zStd = std(estZ)||1e-8;
      const rcMean = mean(estRC), rcStd = std(estRC)||1e-8;
      const blended = estZ.map((z,i)=> alpha*((z - zMean)/zStd) + (1-alpha)*((estRC[i]-rcMean)/rcStd));
      return rank_from_scores_per_item(blended);
    }

    if (algo === "rankcentrality") {
      const est = rankCentralityFromZ(Z, edgesItem, edgesJudge, N);
      return rank_from_scores_per_item(est);
    }

    // fallback
    const comp = edgesScores.map(r => mean(r));
    const s=Array(N).fill(0), c=Array(N).fill(0);
    for(let e=0;e<E;e++){ s[edgesItem[e]] += comp[e]; c[edgesItem[e]] += 1; }
    const est = s.map((v,i)=> v/Math.max(1,c[i]));
    return rank_from_scores_per_item(est);

    // ------- helpers -------
    function rankCentralityFromZ(Z, edgesItem, edgesJudge, N){
      // build per-judge mean composite
      const byJ = new Map();
      for(let e=0;e<E;e++){
        const j=edgesJudge[e]; if(!byJ.has(j)) byJ.set(j, []);
        byJ.get(j).push(e);
      }
      const wins = Array(N).fill(0).map(()=>Array(N).fill(0));
      byJ.forEach((idxs,j) => {
        // average Z composite per item for this judge
        const map = new Map();
        idxs.forEach(e => {
          const i = edgesItem[e];
          if(!map.has(i)) map.set(i, []);
          map.get(i).push(mean(Z[e]));
        });
        const items = Array.from(map.entries()).map(([i,arr]) => [i, mean(arr)]);
        for(let a=0;a<items.length;a++){
          for(let b=0;b<items.length;b++){
            if(a===b) continue;
            if(items[a][1] > items[b][1]) wins[items[a][0]][items[b][0]] += 1;
          }
        }
      });
      // transition matrix
      const P = Array(N).fill(0).map(()=>Array(N).fill(0));
      for(let i=0;i<N;i++){
        let rs=0;
        for(let k=0;k<N;k++){
          if(i===k) continue;
          const tot = wins[i][k] + wins[k][i];
          if(tot>0){ const pij = wins[k][i]/tot; P[i][k]=pij; rs += pij; }
        }
        P[i][i] = Math.max(0, 1-rs);
      }
      // power iteration
      let pi = Array(N).fill(1/N);
      for(let t=0;t<60;t++){
        const next = Array(N).fill(0);
        for(let i=0;i<N;i++){
          for(let k=0;k<N;k++){ next[k] += pi[i]*P[i][k]; }
        }
        pi = next;
      }
      return pi;
    }
  }

  function renderRanking(arr){
    rankingTableBody.innerHTML = "";
    arr.forEach((row, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = \`<td>\${idx+1}</td><td class="mono">\${row.id}</td><td>\${row.title}</td><td>\${row.score.toFixed(4)}</td>\`;
      rankingTableBody.appendChild(tr);
    });
  }

  function exportScoresCSV(){
    const header = ["uid","posterId", ...METRICS.map(m=>m.id),"updatedAt"];
    const lines = [header.join(",")];
    Array.from(SCORES_CACHE.values()).forEach(s => {
      const m = METRICS.map(def => (s.metrics?.[def.id] ?? ""));
      lines.push([s.uid, s.posterId, ...m, (s.updatedAt?.seconds||"")].join(","));
    });
    downloadText("scores.csv", lines.join("\n"));
  }

  function exportRankingCSV(){
    const algo = algoSelect.value;
    const alpha = Number(hybridAlphaEl.value);
    const shrink = Number(shrinkageEl.value);
    const arr = computeRanking(algo, alpha, shrink);
    const lines = ["rank,posterId,title,score"];
    arr.forEach((r,i)=> lines.push([i+1, r.id, r.title, r.score].join(",")));
    downloadText("ranking.csv", lines.join("\n"));
  }

  function downloadText(filename, text){
    const blob = new Blob([text], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Bootstrap: preload posters for admin KPI ----
  (async function boot(){
    try {
      CONFIG = await loadJSON("config.json");
      eventTitleEl.textContent = CONFIG.eventTitle || "Poster Scoring";
    } catch (e) {
      console.warn("config.json not found yet", e);
    }
  })();
</script>
