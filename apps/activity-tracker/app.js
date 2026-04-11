/* ================================================================
   Activity Tracker — McGheeLab Lab App
   Daily activity logging with hierarchical categories,
   ML-powered categorization, AI integration, and analytics.
   Privacy: all data is strictly owner-only.
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');
  function db() {
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }

  /* ─── State ──────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _trackerData = null;   // categories, mlModel, settings
  let _entries = [];          // entries for currently viewed date range
  let _currentDate = todayStr();
  let _currentSection = 'daily';
  let _chartInstances = {};
  let _toastTimer = null;
  let _recognition = null;   // SpeechRecognition instance
  let _aiPending = null;     // AI suggestions awaiting approval
  let _bulkMode = false;     // toggle between single task input and bulk paste
  let _skippedEventIds = new Set(); // calendar events skipped this session
  let _huddlePlans = [];     // Huddle plans for current day (own + signed up)
  let _skippedHuddleIds = new Set(); // Huddle plans skipped this session

  /* ─── Default Categories ─────────────────────────────────── */
  const DEFAULT_CATEGORIES = [
    {
      id: 'research', label: 'Research', color: '#5baed1', children: [
        { id: 'writing', label: 'Writing', children: [
          { id: 'papers', label: 'Papers', children: [] },
          { id: 'protocols', label: 'Protocols', children: [] },
          { id: 'grants', label: 'Grant Writing', children: [] },
          { id: 'patents', label: 'Patents', children: [] }
        ]},
        { id: 'experiments', label: 'Experiments', children: [] },
        { id: 'analysis', label: 'Data Analysis', children: [] },
        { id: 'lit_review', label: 'Literature Review', children: [] },
        { id: 'data_management', label: 'Data Management', children: [] },
        { id: 'conferences', label: 'Conferences', children: [
          { id: 'conf_presentations', label: 'Presentations', children: [] },
          { id: 'poster_sessions', label: 'Poster Sessions', children: [] },
          { id: 'conf_attendance', label: 'Attendance', children: [] }
        ]},
        { id: 'meetings_research', label: 'Meetings', children: [
          { id: 'lab_meeting', label: 'Lab Meeting', children: [] },
          { id: 'one_on_one', label: 'One-on-One', children: [] },
          { id: 'mentorship', label: 'Mentorship', children: [] },
          { id: 'collaboration', label: 'Collaboration', children: [] }
        ]}
      ]
    },
    {
      id: 'coursework', label: 'Coursework', color: '#86efac', children: [
        { id: 'course_content', label: 'Generating Content', children: [] },
        { id: 'grading', label: 'Grading', children: [] },
        { id: 'homework', label: 'Homework', children: [] },
        { id: 'attending_class', label: 'Attending Class', children: [] },
        { id: 'office_hours', label: 'Office Hours', children: [] },
        { id: 'course_prep', label: 'Course Prep', children: [] },
        { id: 'student_advising', label: 'Student Advising', children: [] }
      ]
    },
    {
      id: 'service', label: 'Service', color: '#c4b5fd', children: [
        { id: 'outreach', label: 'Outreach', children: [
          { id: 'lab_tours', label: 'Lab Tours', children: [] },
          { id: 'interviews', label: 'Interviews', children: [] },
          { id: 'public_engagement', label: 'Public Engagement', children: [] }
        ]},
        { id: 'reviews', label: 'Reviews', children: [
          { id: 'defense_review', label: 'Defense Committee', children: [] },
          { id: 'paper_review', label: 'Paper Review', children: [] },
          { id: 'grant_review', label: 'Grant Review', children: [] }
        ]},
        { id: 'committee_work', label: 'Committee Work', children: [] },
        { id: 'professional_society', label: 'Professional Society', children: [] }
      ]
    },
    {
      id: 'professional_dev', label: 'Professional Development', color: '#fbbf24', children: [
        { id: 'training', label: 'Training / Workshops', children: [] },
        { id: 'networking', label: 'Networking', children: [] },
        { id: 'certifications', label: 'Certifications', children: [] },
        { id: 'seminar_attendance', label: 'Seminar Attendance', children: [] }
      ]
    },
    {
      id: 'admin', label: 'Administration', color: '#fca5a5', children: [
        { id: 'email', label: 'Email / Communications', children: [] },
        { id: 'lab_management', label: 'Lab Management', children: [] },
        { id: 'purchasing', label: 'Purchasing / Orders', children: [] },
        { id: 'safety_compliance', label: 'Safety / Compliance', children: [] },
        { id: 'reporting', label: 'Reporting', children: [] }
      ]
    }
  ];

  const STOP_WORDS = new Set([
    'the','and','for','that','this','with','from','have','had','has','was','were',
    'been','are','but','not','you','all','can','her','his','one','our','out','day',
    'get','got','did','its','let','say','she','too','use','way','who','how','man',
    'new','now','old','see','just','also','back','been','come','each','first','give',
    'good','into','last','long','look','make','many','most','only','over','some',
    'take','than','them','then','very','when','which','about','after','again','being',
    'could','every','great','might','never','other','still','their','there','these',
    'thing','think','those','three','under','where','while','would','before','between',
    'during','should','through','today','went','done','work','worked','working','spent',
    'time','hour','hours','minute','minutes'
  ]);

  /* ═══════════════════════════════════════════════════════════
     BOOTSTRAP
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    // Strategy: try AppBridge first (works in embedded + standalone).
    // If it fails or times out, fall back to Firebase Auth directly
    // (works because same-origin iframes share Firebase auth state).
    let booted = false;

    async function boot(user, profile) {
      if (booted) return;
      booted = true;
      _user = user;
      _profile = profile;
      try {
        await loadData();
      } catch (err) {
        console.error('[ActivityTracker] loadData failed:', err);
        initDefaults();
      }
      render();

      // Enable tab swipe on mobile
      if (McgheeLab.MobileShell?.enableTabSwipe) {
        McgheeLab.MobileShell.enableTabSwipe(
          [{ id: 'daily' }, { id: 'weekly' }, { id: 'analytics' }, { id: 'categories' }, { id: 'settings' }],
          () => _currentSection,
          (id) => { _currentSection = id; render(); }
        );
      }
    }

    // Path 1: AppBridge (handles both embedded postMessage and standalone Firebase)
    McgheeLab.AppBridge.init();
    if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'activity-tracker', title: 'Activity Tracker' });
    McgheeLab.AppBridge.onReady((user, profile) => {
      if (user) boot(user, profile);
    });

    // Path 2: Direct Firebase Auth fallback — covers cases where AppBridge
    // times out but user is actually signed in (same-origin iframe)
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged(async (fbUser) => {
        if (booted || !fbUser) return;
        console.log('[ActivityTracker] Using Firebase Auth directly');
        try {
          const doc = await firebase.firestore().collection('users').doc(fbUser.uid).get();
          const profile = doc.exists ? doc.data() : { role: 'guest' };
          boot(
            { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName },
            profile
          );
        } catch (err) {
          console.error('[ActivityTracker] Firebase Auth fallback failed:', err);
          boot(
            { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName },
            { role: 'guest' }
          );
        }
      });
    }
  });

  function initDefaults() {
    _trackerData = {
      categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
      mlModel: { wordWeights: {}, categoryPriors: {}, totalSamples: 0 },
      settings: { defaultView: 'daily', workingHours: { start: '08:00', end: '18:00' } }
    };
    _entries = [];
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — direct access, owner-only
     ═══════════════════════════════════════════════════════════ */
  async function loadData() {
    const uid = _user.uid;
    // Load tracker settings/categories/ml model
    const doc = await db().collection('trackerData').doc(uid).get();
    if (doc.exists) {
      _trackerData = doc.data();
      // Ensure categories exist (merge defaults if missing)
      if (!_trackerData.categories || !_trackerData.categories.length) {
        _trackerData.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
      }
      if (!_trackerData.mlModel) {
        _trackerData.mlModel = { wordWeights: {}, categoryPriors: {}, totalSamples: 0 };
      }
      if (!_trackerData.settings) {
        _trackerData.settings = { defaultView: 'daily', workingHours: { start: '08:00', end: '18:00' } };
      }
    } else {
      _trackerData = {
        categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)),
        mlModel: { wordWeights: {}, categoryPriors: {}, totalSamples: 0 },
        settings: { defaultView: 'daily', workingHours: { start: '08:00', end: '18:00' } }
      };
      await saveTrackerData();
    }
    // Load entries for current date + Huddle plans
    await loadEntries(_currentDate, _currentDate);
    await loadHuddlePlans(_currentDate);
  }

  async function loadEntries(startDate, endDate) {
    try {
      const snap = await db().collection('trackerEntries').doc(_user.uid)
        .collection('entries')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .orderBy('date', 'desc')
        .get();
      _entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('[ActivityTracker] loadEntries failed:', err);
      // If the error contains an index creation link, show it
      if (err.message?.includes('index')) {
        console.warn('[ActivityTracker] Firestore needs a composite index. Check the error above for the creation link.');
      }
      _entries = [];
    }
  }

  async function loadEntriesForWeek(weekStart) {
    const end = offsetDate(weekStart, 6);
    await loadEntries(weekStart, end);
  }

  async function loadEntriesForRange(startDate, endDate) {
    await loadEntries(startDate, endDate);
  }

  /* ─── Huddle Integration — load plans for the current day ─── */
  async function loadHuddlePlans(dateStr) {
    try {
      // Get the ISO week ID for the target date
      const d = new Date(dateStr + 'T12:00:00');
      const tmp = new Date(d.getTime());
      tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
      const jan4 = new Date(tmp.getFullYear(), 0, 4);
      const weekNum = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
      const weekId = tmp.getFullYear() + '-W' + String(weekNum).padStart(2, '0');

      const snap = await db().collection('huddlePlans')
        .where('weekId', '==', weekId)
        .where('plannedDay', '==', dateStr)
        .get();

      const uid = _user.uid;
      _huddlePlans = snap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(p => {
          if (p.status !== 'planned') return false;
          // Include if user owns the plan
          if (p.ownerUid === uid) return true;
          // Include if user signed up (watcher or joiner)
          if ((p.watchers || []).some(w => w.uid === uid)) return true;
          if ((p.joiners || []).some(j => j.uid === uid)) return true;
          return false;
        });
    } catch (err) {
      // Huddle collection may not exist yet — fail silently
      _huddlePlans = [];
    }
  }

  async function saveTrackerData() {
    await db().collection('trackerData').doc(_user.uid).set(
      { ..._trackerData, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  async function saveEntry(entry) {
    const uid = _user.uid;
    entry.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    if (entry.id) {
      const id = entry.id;
      const data = { ...entry };
      delete data.id;
      await db().collection('trackerEntries').doc(uid).collection('entries').doc(id).set(data, { merge: true });
      return id;
    }
    entry.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await db().collection('trackerEntries').doc(uid).collection('entries').add(entry);
    return ref.id;
  }

  async function deleteEntry(entryId) {
    await db().collection('trackerEntries').doc(_user.uid).collection('entries').doc(entryId).delete();
  }

  /* ═══════════════════════════════════════════════════════════
     ML CLASSIFIER — Multinomial Naive Bayes
     ═══════════════════════════════════════════════════════════ */
  function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  function mlTrain(text, categoryId) {
    const model = _trackerData.mlModel;
    const words = tokenize(text);
    model.categoryPriors[categoryId] = (model.categoryPriors[categoryId] || 0) + 1;
    model.totalSamples++;
    for (const w of words) {
      if (!model.wordWeights[w]) model.wordWeights[w] = {};
      model.wordWeights[w][categoryId] = (model.wordWeights[w][categoryId] || 0) + 1;
    }
  }

  function mlPredict(text, topN) {
    topN = topN || 3;
    const model = _trackerData.mlModel;
    if (model.totalSamples < 5) return [];
    const words = tokenize(text);
    if (!words.length) return [];
    const scores = {};
    const vocabSize = Object.keys(model.wordWeights).length || 1;

    for (const cat of Object.keys(model.categoryPriors)) {
      scores[cat] = Math.log(model.categoryPriors[cat] / model.totalSamples);
      let catTotal = 0;
      for (const wc of Object.values(model.wordWeights)) {
        catTotal += (wc[cat] || 0);
      }
      catTotal = catTotal || 1;
      for (const w of words) {
        const count = model.wordWeights[w]?.[cat] || 0;
        scores[cat] += Math.log((count + 1) / (catTotal + vocabSize));
      }
    }

    return Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([cat, score]) => ({ categoryId: cat, score }));
  }

  /* ═══════════════════════════════════════════════════════════
     AI CATEGORIZATION — Anthropic API
     ═══════════════════════════════════════════════════════════ */
  async function aiCategorize(entries) {
    const apiKey = _profile?.anthropicKey;
    if (!apiKey) {
      showToast('Add your Anthropic API key in Settings', 'error');
      return null;
    }
    const uncategorized = entries.filter(e => !e.categoryPath || !e.categoryPath.length);
    if (!uncategorized.length) {
      showToast('All tasks are already categorized');
      return null;
    }

    const catTree = flattenCategoriesForPrompt(_trackerData.categories);
    const taskList = uncategorized.map((e, i) => `${i + 1}. "${e.text}"${e.duration ? ` (${e.duration}m)` : ''}`).join('\n');

    const prompt = `You are categorizing daily activities for an academic lab member. Here are the available categories:\n\n${catTree}\n\nCategorize each task below. Return ONLY valid JSON — an array of objects with "index" (1-based), "categoryPath" (array of category IDs from root to leaf), and "estimatedDuration" (minutes, only if not already provided).\n\nTasks:\n${taskList}\n\nRespond with the JSON array only, no markdown fences.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const j = await res.json();
      if (j.error) {
        showToast('API error: ' + j.error.message, 'error');
        return null;
      }
      const text = j.content?.[0]?.text || '';
      const parsed = JSON.parse(text);
      return { suggestions: parsed, entries: uncategorized };
    } catch (err) {
      showToast('AI categorization failed: ' + err.message, 'error');
      return null;
    }
  }

  function flattenCategoriesForPrompt(cats, prefix) {
    prefix = prefix || '';
    let result = '';
    for (const cat of cats) {
      const path = prefix ? prefix + ' > ' + cat.label : cat.label;
      const ids = prefix ? prefix.split(' > ').map(l => findCatIdByLabel(cats, l)).filter(Boolean) : [];
      result += `- ${path} (id: ${cat.id})\n`;
      if (cat.children?.length) {
        result += flattenCategoriesForPrompt(cat.children, path);
      }
    }
    return result;
  }

  function findCatIdByLabel(cats, label) {
    for (const c of cats) {
      if (c.label === label) return c.id;
      if (c.children?.length) {
        const found = findCatIdByLabel(c.children, label);
        if (found) return found;
      }
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════
     BULK PASTE — Split paragraph into tasks
     ═══════════════════════════════════════════════════════════ */

  // Split a paragraph into individual task strings
  function splitParagraph(text) {
    // Split on sentence boundaries: period/exclamation/question followed by space or newline,
    // or on newlines, or on semicolons
    return text
      .split(/(?<=[.!?])\s+|\n+|;\s*/)
      .map(s => s.replace(/^[-\u2022\u2013*]\s*/, '').trim()) // strip bullet prefixes
      .filter(s => s.length > 3); // discard fragments
  }

  // AI-powered: parse paragraph into tasks with categories in one shot
  async function aiBulkParse(text) {
    const apiKey = _profile?.anthropicKey;
    if (!apiKey) {
      showToast('Add your Anthropic API key on the Dashboard', 'error');
      return null;
    }

    const catTree = flattenCategoriesForPrompt(_trackerData.categories);
    const prompt = `You are parsing a daily activity log for an academic lab member. The user wrote a paragraph describing everything they did today. Split it into individual tasks and categorize each one.

Available categories:
${catTree}

User's log:
"${text}"

Return ONLY valid JSON — an array of objects, each with:
- "text": the task description (clean, concise — do not include the duration in the text)
- "categoryPath": array of category IDs from root to leaf (e.g., ["research", "writing", "papers"])
- "duration": estimated minutes (integer, parse from text like "90m", "1.5h", "2 hours", or estimate if not stated — use null if truly unknown)

Split every distinct activity into its own task. Respond with the JSON array only, no markdown fences.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const j = await res.json();
      if (j.error) {
        showToast('API error: ' + j.error.message, 'error');
        return null;
      }
      const raw = j.content?.[0]?.text || '';
      return JSON.parse(raw);
    } catch (err) {
      showToast('AI parse failed: ' + err.message, 'error');
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     CATEGORY HELPERS
     ═══════════════════════════════════════════════════════════ */
  function getCategories() {
    return _trackerData?.categories || DEFAULT_CATEGORIES;
  }

  function findCategory(id, cats) {
    cats = cats || getCategories();
    for (const c of cats) {
      if (c.id === id) return c;
      if (c.children?.length) {
        const found = findCategory(id, c.children);
        if (found) return found;
      }
    }
    return null;
  }

  function getCategoryPath(leafId) {
    const path = [];
    function search(cats, trail) {
      for (const c of cats) {
        const next = [...trail, c.id];
        if (c.id === leafId) { path.push(...next); return true; }
        if (c.children?.length && search(c.children, next)) return true;
      }
      return false;
    }
    search(getCategories(), []);
    return path;
  }

  function getCategoryLabel(path) {
    if (!path || !path.length) return 'Uncategorized';
    const labels = [];
    let cats = getCategories();
    for (const id of path) {
      const found = cats.find(c => c.id === id);
      if (!found) break;
      labels.push(found.label);
      cats = found.children || [];
    }
    return labels.join(' > ');
  }

  function getTopLevelColor(path) {
    if (!path || !path.length) return 'rgba(255,255,255,.2)';
    const top = getCategories().find(c => c.id === path[0]);
    return top?.color || 'rgba(255,255,255,.2)';
  }

  // Build flat list of all leaf categories for dropdown
  function flatLeafCategories(cats, parentPath, parentColor) {
    cats = cats || getCategories();
    parentPath = parentPath || [];
    parentColor = parentColor || null;
    const result = [];
    for (const c of cats) {
      const path = [...parentPath, c.id];
      const color = parentColor || c.color;
      if (!c.children || !c.children.length) {
        result.push({ id: c.id, label: c.label, path, color, depth: path.length });
      } else {
        // Include the parent as a groupable item too
        result.push({ id: c.id, label: c.label, path, color, depth: path.length, isGroup: true });
        result.push(...flatLeafCategories(c.children, path, color));
      }
    }
    return result;
  }

  /* ═══════════════════════════════════════════════════════════
     DURATION PARSING
     ═══════════════════════════════════════════════════════════ */
  function parseDuration(text) {
    // Match patterns like "90m", "1.5h", "2h30m", "45 min", "1 hour"
    let duration = null;
    let cleaned = text;
    const patterns = [
      { rx: /(\d+(?:\.\d+)?)\s*h(?:ours?|r)?(?:\s*(\d+)\s*m(?:in(?:utes?)?)?)?/i, fn: (m) => Math.round(parseFloat(m[1]) * 60) + (parseInt(m[2]) || 0) },
      { rx: /(\d+)\s*m(?:in(?:utes?)?)?/i, fn: (m) => parseInt(m[1]) }
    ];
    for (const p of patterns) {
      const match = text.match(p.rx);
      if (match) {
        duration = p.fn(match);
        cleaned = text.replace(match[0], '').trim().replace(/\s{2,}/g, ' ');
        break;
      }
    }
    return { duration, text: cleaned };
  }

  /* ═══════════════════════════════════════════════════════════
     DATE HELPERS
     ═══════════════════════════════════════════════════════════ */
  function todayStr() {
    return localDateStr(new Date());
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatDateShort(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function offsetDate(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return localDateStr(d);
  }

  function getWeekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day + 1); // Monday
    return localDateStr(d);
  }

  function formatMinutes(mins) {
    if (!mins && mins !== 0) return '';
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER — Main dispatcher
     ═══════════════════════════════════════════════════════════ */
  function render() {
    try {
      if (McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('act-tabs');
      appEl.innerHTML = `
        <div class="act-layout">
          <nav class="act-sidebar" id="act-tabs">
            ${sidebarHTML()}
          </nav>
          <div class="act-main" id="act-main">
            ${renderSection()}
          </div>
        </div>
        <div class="act-toast hidden" id="act-toast"></div>
      `;
      wireSidebar();
      wireSection();
      // Center active tab in scrollable nav
      if (McgheeLab.MobileShell?.centerActiveTab) {
        McgheeLab.MobileShell.centerActiveTab(document.getElementById('act-tabs'), '.active');
      }
    } catch (err) {
      console.error('[ActivityTracker] render failed:', err);
      appEl.innerHTML = `<div class="app-card" style="margin:2rem;text-align:center">
        <h2>Activity Tracker</h2>
        <p style="color:var(--danger)">Failed to render: ${err.message}</p>
        <p style="color:var(--muted);font-size:.85rem">Check the browser console for details.</p>
        <button class="app-btn app-btn--primary" onclick="location.reload()" style="margin-top:1rem">Reload</button>
      </div>`;
    }
  }

  function sidebarHTML() {
    const items = [
      { id: 'daily', icon: calendarIcon(), label: 'Daily' },
      { id: 'weekly', icon: weekIcon(), label: 'Weekly' },
      { id: 'analytics', icon: chartIcon(), label: 'Analytics' },
      { id: 'categories', icon: tagIcon(), label: 'Categories' },
      { id: 'settings', icon: gearIcon(), label: 'Settings' }
    ];
    return items.map(it =>
      `<button class="act-sidebar-btn${_currentSection === it.id ? ' active' : ''}" data-section="${it.id}">
        <span class="act-sidebar-icon">${it.icon}</span>${it.label}
      </button>`
    ).join('');
  }

  function wireSidebar() {
    appEl.querySelectorAll('.act-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        _currentSection = btn.dataset.section;
        if (_currentSection === 'weekly') {
          await loadEntriesForWeek(getWeekStart(_currentDate));
        } else if (_currentSection === 'analytics') {
          const start = offsetDate(todayStr(), -30);
          await loadEntriesForRange(start, todayStr());
        } else {
          await loadEntries(_currentDate, _currentDate);
        }
        render();
      });
    });
  }

  function renderSection() {
    switch (_currentSection) {
      case 'daily': return renderDaily();
      case 'weekly': return renderWeekly();
      case 'analytics': return renderAnalytics();
      case 'categories': return renderCategoriesManager();
      case 'settings': return renderSettings();
      default: return renderDaily();
    }
  }

  function wireSection() {
    switch (_currentSection) {
      case 'daily': wireDaily(); break;
      case 'weekly': wireWeekly(); break;
      case 'analytics': wireAnalytics(); break;
      case 'categories': wireCategoriesManager(); break;
      case 'settings': wireSettings(); break;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     DAILY VIEW
     ═══════════════════════════════════════════════════════════ */
  function renderDaily() {
    const entries = _entries.filter(e => e.date === _currentDate);
    const hasMic = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasAI = !!_profile?.anthropicKey;
    const hasML = _trackerData.mlModel.totalSamples >= 5;
    const uncategorizedCount = entries.filter(e => !e.categoryPath || !e.categoryPath.length).length;

    let html = `
      <div class="act-date-nav">
        <button class="act-date-btn" id="act-prev">${chevronLeft()}</button>
        <h2>${formatDate(_currentDate)}</h2>
        ${_currentDate !== todayStr() ? '<button class="act-date-today" id="act-today">Today</button>' : ''}
        <button class="act-date-btn" id="act-next">${chevronRight()}</button>
      </div>

      <div class="act-input-mode">
        <button class="act-mode-tab${!_bulkMode ? ' active' : ''}" id="act-mode-single">Single Task</button>
        <button class="act-mode-tab${_bulkMode ? ' active' : ''}" id="act-mode-bulk">Bulk Paste</button>
      </div>

      ${!_bulkMode ? `
      <div class="act-input-area">
        <div class="act-input-wrap">
          <input type="text" class="act-input" id="act-task-input"
            placeholder="What did you do? (e.g., Ran PCR 90m)" autocomplete="off" />
          ${hasMic ? `<button class="act-mic-btn" id="act-mic" title="Voice input">${micIcon()}</button>` : ''}
        </div>
        <button class="act-add-btn" id="act-add-btn">Add</button>
      </div>` : `
      <div class="act-bulk-area">
        <div class="act-bulk-textarea-wrap">
          <textarea class="act-input act-bulk-input" id="act-bulk-input" rows="5"
            placeholder="Paste everything you did today. Each sentence becomes a task.&#10;&#10;e.g.: Ran PCR for MEBP samples 90m. Reviewed Smith manuscript for Nature 45m. Had lab meeting to discuss results 1h. Graded homework assignments 2h."></textarea>
          ${hasMic ? `<button class="act-mic-btn act-bulk-mic" id="act-bulk-mic" title="Dictate (continuous)">${micIcon()}</button>` : ''}
        </div>
        <div class="act-bulk-actions">
          <button class="act-add-btn" id="act-bulk-parse">Split &amp; Add</button>
          ${hasML ? `<button class="act-ml-btn" id="act-bulk-ml">Split &amp; ML Categorize</button>` : ''}
          ${hasAI ? `<button class="act-ai-btn" id="act-bulk-ai">AI Parse &amp; Categorize</button>` : ''}
          <span class="act-bulk-hint">Splits by sentence. Duration auto-detected from text.</span>
        </div>
      </div>`}

      <div class="act-input-area" style="margin-top:.5rem;${_bulkMode ? 'display:none' : ''}">
        ${uncategorizedCount > 0 && hasML ? `<button class="act-ml-btn" id="act-ml-btn">ML Categorize (${uncategorizedCount})</button>` : ''}
        ${uncategorizedCount > 0 && hasAI ? `<button class="act-ai-btn" id="act-ai-btn">AI Categorize (${uncategorizedCount})</button>` : ''}
      </div>`;

    // Huddle plans suggestion panel
    if (_huddlePlans.length) {
      const loggedHuddleIds = new Set(entries.filter(e => e.source === 'huddle' && e.huddlePlanId).map(e => e.huddlePlanId));
      const unloggedHuddle = _huddlePlans.filter(hp =>
        !loggedHuddleIds.has(hp.id) && !_skippedHuddleIds.has(hp.id)
      );
      if (unloggedHuddle.length) {
        html += `<div class="app-card" style="margin-top:.75rem;border-color:var(--accent)">
          <p style="margin:0 0 .5rem;font-size:.88rem;color:var(--accent)">
            <strong>${unloggedHuddle.length}</strong> Huddle plan${unloggedHuddle.length > 1 ? 's' : ''} scheduled today:
          </p>`;
        for (const hp of unloggedHuddle) {
          const isOwner = hp.ownerUid === _user.uid;
          const role = isOwner ? 'Your plan' : 'Signed up';
          const dur = hp.startTime && hp.endTime ? (() => {
            const [sh, sm] = hp.startTime.split(':').map(Number);
            const [eh, em] = hp.endTime.split(':').map(Number);
            return (eh * 60 + em) - (sh * 60 + sm);
          })() : null;
          const timeLabel = hp.startTime ? hp.startTime + (hp.endTime ? '\u2013' + hp.endTime : '') : '';
          html += `<div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border)">
            <span style="flex:1;font-size:.85rem">${esc(hp.text)}
              <span style="color:var(--muted);font-size:.75rem">${timeLabel}${dur ? ' (' + formatMinutes(dur) + ')' : ''}</span>
              <span style="color:var(--accent);font-size:.68rem;margin-left:.25rem">${esc(role)}</span>
            </span>
            <button class="act-add-btn act-huddle-import" data-huddle-id="${hp.id}" data-title="${esc(hp.text)}" data-duration="${dur || ''}" style="padding:.25rem .5rem;font-size:.75rem">Log it</button>
            <button class="act-ml-btn act-huddle-skip" data-huddle-id="${hp.id}" style="padding:.25rem .5rem;font-size:.75rem">Skip</button>
          </div>`;
        }
        html += '</div>';
      }
    }

    // AI approval overlay
    if (_aiPending) {
      html += renderAiApproval();
    }

    // Task list
    if (entries.length) {
      html += '<div class="act-task-list" id="act-task-list">';
      for (const entry of entries) {
        html += renderTaskRow(entry);
      }
      html += '</div>';
    } else {
      html += `<div class="act-empty"><div class="act-empty-icon">&#128203;</div><p>No tasks logged for this day.</p><p style="font-size:.8rem">Type what you did and press Add.</p></div>`;
    }

    // Summary chips
    if (entries.length) {
      html += renderSummary(entries);
    }

    // Unlogged calendar events prompt (via shared CalendarService)
    const _calendarEvents = McgheeLab.CalendarService?.getEventsForDate(_currentDate) || [];
    if (_calendarEvents.length) {
      const loggedEventIds = new Set(entries.filter(e => e.calendarEventId).map(e => e.calendarEventId));
      const unlogged = _calendarEvents.filter(ev =>
        !loggedEventIds.has(ev.id) && !_skippedEventIds.has(ev.id)
      );
      if (unlogged.length) {
        html += `<div class="app-card" style="margin-top:.75rem;border-color:var(--warning)">
          <p style="margin:0 0 .5rem;font-size:.88rem;color:var(--warning)">You have ${unlogged.length} calendar event${unlogged.length > 1 ? 's' : ''} not yet logged:</p>`;
        for (const ev of unlogged) {
          html += `<div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border)">
            <span style="flex:1;font-size:.85rem">${esc(ev.title)} <span style="color:var(--muted);font-size:.75rem">${ev.startTime || ''}${ev.duration ? ' (' + formatMinutes(ev.duration) + ')' : ''}</span></span>
            <button class="act-add-btn act-daily-cal-import" data-event-id="${esc(ev.id)}" data-title="${esc(ev.title)}" data-duration="${ev.duration || ''}" style="padding:.25rem .5rem;font-size:.75rem">Log it</button>
            <button class="act-ml-btn act-daily-cal-skip" data-event-id="${esc(ev.id)}" style="padding:.25rem .5rem;font-size:.75rem">Skip</button>
          </div>`;
        }
        html += '</div>';
      }
    }

    return html;
  }

  function renderTaskRow(entry) {
    const color = getTopLevelColor(entry.categoryPath);
    const label = getCategoryLabel(entry.categoryPath);
    const isUncategorized = !entry.categoryPath || !entry.categoryPath.length;
    const suggestions = isUncategorized ? mlPredict(entry.text) : [];

    return `
      <div class="act-task-row" data-id="${entry.id}">
        <div class="act-task-text">${esc(entry.text)}</div>
        ${entry.duration ? `<span class="act-task-duration">${formatMinutes(entry.duration)}</span>` : `<input type="text" class="act-task-duration-input" data-id="${entry.id}" placeholder="0m" title="Duration (e.g. 30m, 1h)" />`}
        <div class="act-cat-selector">
          ${isUncategorized
            ? `<button class="act-cat-badge act-cat-unset" data-id="${entry.id}" title="Assign category">+ Category</button>`
            : `<span class="act-cat-badge" style="background:${color}22;color:${color}" data-id="${entry.id}" title="Change category" role="button" tabindex="0">${esc(label)}</span>`
          }
          <div class="act-cat-dropdown" hidden id="cat-dd-${entry.id}">${categoryDropdownHTML()}</div>
        </div>
        ${suggestions.length ? `<div class="act-suggestions">${suggestions.map(s => {
          const cat = findCategory(s.categoryId);
          return cat ? `<button class="act-suggest-pill" data-entry="${entry.id}" data-cat="${s.categoryId}">${esc(cat.label)}</button>` : '';
        }).join('')}</div>` : ''}
        <div class="act-stars" data-id="${entry.id}">
          ${[1,2,3,4,5].map(n => `<button class="act-star${(entry.milestone || 0) >= n ? ' filled' : ''}" data-star="${n}" title="Milestone ${n}">${starIcon()}</button>`).join('')}
        </div>
        <div class="act-task-actions">
          <button class="act-task-action-btn act-edit-btn" data-edit="${entry.id}" title="Edit">${editIcon()}</button>
          <button class="act-task-action-btn" data-delete="${entry.id}" title="Delete">${trashIcon()}</button>
        </div>
      </div>`;
  }

  function renderEditModal(entry) {
    return `<div class="act-edit-overlay" id="act-edit-overlay">
      <div class="act-edit-modal">
        <h3 style="margin:0 0 1rem">Edit Task</h3>
        <div style="display:flex;flex-direction:column;gap:.75rem">
          <div>
            <label class="app-label">Task</label>
            <input type="text" class="app-input" id="act-edit-text" value="${esc(entry.text)}" />
          </div>
          <div style="display:flex;gap:.75rem">
            <div style="flex:1">
              <label class="app-label">Date</label>
              <input type="date" class="app-input" id="act-edit-date" value="${entry.date || _currentDate}" />
            </div>
            <div style="width:100px">
              <label class="app-label">Duration</label>
              <input type="text" class="app-input" id="act-edit-duration" value="${entry.duration ? entry.duration + 'm' : ''}" placeholder="e.g. 90m" />
            </div>
          </div>
        </div>
        <div style="display:flex;gap:.5rem;margin-top:1rem;justify-content:flex-end">
          <button class="app-btn app-btn--secondary" id="act-edit-cancel">Cancel</button>
          <button class="app-btn app-btn--primary" id="act-edit-save" data-id="${entry.id}">Save</button>
        </div>
      </div>
    </div>`;
  }

  function categoryDropdownHTML() {
    const flat = flatLeafCategories();
    let html = '';
    let lastTopId = null;
    for (const item of flat) {
      if (item.path.length === 1 && item.isGroup) {
        lastTopId = item.id;
        html += `<div class="act-cat-group-label"><span class="act-cat-dot" style="background:${item.color}"></span> ${esc(item.label)}</div>`;
        continue;
      }
      if (item.isGroup) continue; // skip intermediate groups
      const depth = item.depth > 2 ? 'depth-2' : '';
      html += `<button class="act-cat-option ${depth}" data-path="${item.path.join(',')}" data-leaf="${item.id}">
        <span class="act-cat-dot" style="background:${item.color}"></span>${esc(item.label)}
      </button>`;
    }
    return html;
  }

  function renderSummary(entries) {
    const totals = {};
    for (const e of entries) {
      const topId = e.categoryPath?.[0] || '_uncategorized';
      totals[topId] = (totals[topId] || 0) + (e.duration || 0);
    }
    let html = '<div class="act-summary">';
    for (const [id, mins] of Object.entries(totals)) {
      if (id === '_uncategorized') {
        html += `<div class="act-summary-chip"><span class="act-summary-dot" style="background:rgba(255,255,255,.2)"></span>Uncategorized <span class="act-summary-time">${formatMinutes(mins) || '—'}</span></div>`;
      } else {
        const cat = findCategory(id);
        if (!cat) continue;
        html += `<div class="act-summary-chip"><span class="act-summary-dot" style="background:${cat.color}"></span>${esc(cat.label)} <span class="act-summary-time">${formatMinutes(mins) || '—'}</span></div>`;
      }
    }
    const totalMins = entries.reduce((s, e) => s + (e.duration || 0), 0);
    html += `<div class="act-summary-chip" style="margin-left:auto;border-color:var(--accent)"><strong>Total</strong> <span class="act-summary-time">${formatMinutes(totalMins) || '—'}</span></div>`;
    html += '</div>';
    return html;
  }

  function renderAiApproval() {
    const { suggestions, entries } = _aiPending;
    let html = `<div class="act-ai-overlay"><h3>AI Suggestions — Review &amp; Approve</h3>`;
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const entry = entries[i];
      if (!entry) continue;
      const catLabel = s.categoryPath ? getCategoryLabel(s.categoryPath) : 'Unknown';
      html += `<div class="act-ai-row" data-idx="${i}">
        <span class="act-ai-row-text">${esc(entry.text)} &rarr; <strong>${esc(catLabel)}</strong>${s.estimatedDuration && !entry.duration ? ` (${s.estimatedDuration}m)` : ''}</span>
        <button class="act-ai-accept" data-accept="${i}">Accept</button>
        <button class="act-ai-reject" data-reject="${i}">Reject</button>
      </div>`;
    }
    html += `<div style="margin-top:.75rem;display:flex;gap:.5rem">
      <button class="act-add-btn" id="act-ai-accept-all">Accept All</button>
      <button class="act-ml-btn" id="act-ai-dismiss">Dismiss</button>
    </div></div>`;
    return html;
  }

  function wireDaily() {
    // Date nav
    document.getElementById('act-prev')?.addEventListener('click', async () => {
      _currentDate = offsetDate(_currentDate, -1);
      await loadEntries(_currentDate, _currentDate);
      await loadHuddlePlans(_currentDate);
      refreshMain();
    });
    document.getElementById('act-next')?.addEventListener('click', async () => {
      _currentDate = offsetDate(_currentDate, 1);
      await loadEntries(_currentDate, _currentDate);
      await loadHuddlePlans(_currentDate);
      refreshMain();
    });
    document.getElementById('act-today')?.addEventListener('click', async () => {
      _currentDate = todayStr();
      await loadEntries(_currentDate, _currentDate);
      await loadHuddlePlans(_currentDate);
      refreshMain();
    });

    // Add task
    const input = document.getElementById('act-task-input');
    const addBtn = document.getElementById('act-add-btn');
    async function addTask() {
      const raw = input?.value?.trim();
      if (!raw) return;
      const { duration, text } = parseDuration(raw);
      const entry = {
        date: _currentDate,
        text,
        categoryPath: [],
        duration: duration,
        milestone: 0,
        source: 'manual'
      };
      const id = await saveEntry(entry);
      entry.id = id;
      _entries.unshift(entry);
      input.value = '';
      refreshMain();
      showToast('Task added');
    }
    addBtn?.addEventListener('click', addTask);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

    // Voice input
    wireVoiceInput(input);
    wireBulkVoiceInput();

    // Mode toggle (single / bulk)
    document.getElementById('act-mode-single')?.addEventListener('click', () => {
      if (!_bulkMode) return;
      _bulkMode = false;
      refreshMain();
    });
    document.getElementById('act-mode-bulk')?.addEventListener('click', () => {
      if (_bulkMode) return;
      _bulkMode = true;
      refreshMain();
    });

    // Bulk paste — Split & Add (no categorization)
    document.getElementById('act-bulk-parse')?.addEventListener('click', async () => {
      const raw = document.getElementById('act-bulk-input')?.value?.trim();
      if (!raw) return;
      const sentences = splitParagraph(raw);
      if (!sentences.length) { showToast('No tasks found', 'error'); return; }
      let count = 0;
      for (const s of sentences) {
        const { duration, text } = parseDuration(s);
        if (!text) continue;
        const entry = { date: _currentDate, text, categoryPath: [], duration, milestone: 0, source: 'manual' };
        const id = await saveEntry(entry);
        entry.id = id;
        _entries.unshift(entry);
        count++;
      }
      showToast(`Added ${count} task${count > 1 ? 's' : ''}`);
      _bulkMode = false;
      refreshMain();
    });

    // Bulk paste — Split & ML Categorize
    document.getElementById('act-bulk-ml')?.addEventListener('click', async () => {
      const raw = document.getElementById('act-bulk-input')?.value?.trim();
      if (!raw) return;
      const sentences = splitParagraph(raw);
      if (!sentences.length) { showToast('No tasks found', 'error'); return; }
      let count = 0;
      for (const s of sentences) {
        const { duration, text } = parseDuration(s);
        if (!text) continue;
        const preds = mlPredict(text, 1);
        const catPath = preds.length ? getCategoryPath(preds[0].categoryId) : [];
        const entry = { date: _currentDate, text, categoryPath: catPath, duration, milestone: 0, source: 'manual' };
        const id = await saveEntry(entry);
        entry.id = id;
        _entries.unshift(entry);
        if (catPath.length) { mlTrain(text, catPath[catPath.length - 1]); }
        count++;
      }
      await saveTrackerData();
      showToast(`Added ${count} task${count > 1 ? 's' : ''} (ML categorized)`);
      _bulkMode = false;
      refreshMain();
    });

    // Bulk paste — AI Parse & Categorize
    document.getElementById('act-bulk-ai')?.addEventListener('click', async () => {
      const raw = document.getElementById('act-bulk-input')?.value?.trim();
      if (!raw) return;
      const btn = document.getElementById('act-bulk-ai');
      if (btn) { btn.disabled = true; btn.textContent = 'Parsing...'; }
      const tasks = await aiBulkParse(raw);
      if (btn) { btn.disabled = false; btn.textContent = 'AI Parse & Categorize'; }
      if (!tasks || !tasks.length) { showToast('AI returned no tasks', 'error'); return; }
      // Show as approval overlay (reuse _aiPending pattern)
      // First create stub entries for each task
      const stubEntries = [];
      for (const t of tasks) {
        const entry = { date: _currentDate, text: t.text, categoryPath: [], duration: t.duration || null, milestone: 0, source: 'ai' };
        const id = await saveEntry(entry);
        entry.id = id;
        _entries.unshift(entry);
        stubEntries.push(entry);
      }
      // Build approval with AI-suggested categories
      _aiPending = {
        suggestions: tasks.map(t => ({ categoryPath: t.categoryPath, estimatedDuration: t.duration })),
        entries: stubEntries
      };
      _bulkMode = false;
      refreshMain();
      showToast(`Parsed ${tasks.length} task${tasks.length > 1 ? 's' : ''} — review categories`);
    });

    // ML categorize button
    document.getElementById('act-ml-btn')?.addEventListener('click', () => {
      const dayEntries = _entries.filter(e => e.date === _currentDate);
      let changed = 0;
      for (const entry of dayEntries) {
        if (entry.categoryPath?.length) continue;
        const preds = mlPredict(entry.text, 1);
        if (preds.length) {
          const path = getCategoryPath(preds[0].categoryId);
          if (path.length) {
            entry.categoryPath = path;
            saveEntry(entry);
            changed++;
          }
        }
      }
      if (changed) {
        showToast(`ML categorized ${changed} task${changed > 1 ? 's' : ''}`);
        refreshMain();
      } else {
        showToast('No confident predictions yet');
      }
    });

    // AI categorize button
    document.getElementById('act-ai-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('act-ai-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Thinking...'; }
      const dayEntries = _entries.filter(e => e.date === _currentDate);
      const result = await aiCategorize(dayEntries);
      if (result) {
        _aiPending = result;
        refreshMain();
      }
      if (btn) { btn.disabled = false; btn.textContent = 'AI Categorize'; }
    });

    // AI approval
    wireAiApproval();

    // Task interactions (category, stars, duration, delete, suggestions)
    wireTaskInteractions();

    // Calendar "Log it" buttons in daily view
    appEl.querySelectorAll('.act-daily-cal-import').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.title;
        const duration = parseInt(btn.dataset.duration) || null;
        const eventId = btn.dataset.eventId;
        const entry = {
          date: _currentDate,
          text: title,
          categoryPath: [],
          duration,
          milestone: 0,
          source: 'calendar',
          calendarEventId: eventId
        };
        const id = await saveEntry(entry);
        entry.id = id;
        _entries.unshift(entry);
        refreshMain();
        showToast('Logged: ' + title);
      });
    });

    // Daily view skip buttons
    appEl.querySelectorAll('.act-daily-cal-skip').forEach(btn => {
      btn.addEventListener('click', () => {
        _skippedEventIds.add(btn.dataset.eventId);
        refreshMain();
      });
    });

    // Huddle "Log it" buttons
    appEl.querySelectorAll('.act-huddle-import').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.title;
        const duration = parseInt(btn.dataset.duration) || null;
        const huddleId = btn.dataset.huddleId;
        const entry = {
          date: _currentDate,
          text: title,
          categoryPath: [],
          duration,
          milestone: 0,
          source: 'huddle',
          huddlePlanId: huddleId
        };
        const id = await saveEntry(entry);
        entry.id = id;
        _entries.unshift(entry);
        refreshMain();
        showToast('Logged from Huddle: ' + title);
      });
    });

    // Huddle skip buttons
    appEl.querySelectorAll('.act-huddle-skip').forEach(btn => {
      btn.addEventListener('click', () => {
        _skippedHuddleIds.add(btn.dataset.huddleId);
        refreshMain();
      });
    });

    // Auto-fetch calendar events for the day via shared service
    if (McgheeLab.CalendarService) {
      const cal = McgheeLab.CalendarService;
      const conn = cal.isConnected();
      if (conn.google || conn.outlook || conn.ics || conn.outlookIcs) {
        const existing = cal.getEventsForDate(_currentDate);
        if (!existing.length) {
          cal.fetchAll(_currentDate).then(() => {
            if (cal.getEventsForDate(_currentDate).length) refreshMain();
          });
        }
      }
    }
  }

  function wireVoiceInput(input) {
    const mic = document.getElementById('act-mic');
    if (!mic || !input) return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    mic.addEventListener('click', () => {
      if (_recognition) {
        _recognition.stop();
        _recognition = null;
        mic.classList.remove('recording');
        return;
      }
      _recognition = new SpeechRec();
      _recognition.continuous = false;
      _recognition.interimResults = false;
      _recognition.lang = 'en-US';
      _recognition.onresult = (ev) => {
        const text = ev.results[0]?.[0]?.transcript || '';
        input.value = (input.value ? input.value + ' ' : '') + text;
        input.focus();
      };
      _recognition.onend = () => { _recognition = null; mic.classList.remove('recording'); };
      _recognition.onerror = () => { _recognition = null; mic.classList.remove('recording'); };
      _recognition.start();
      mic.classList.add('recording');
    });
  }

  function wireBulkVoiceInput() {
    const mic = document.getElementById('act-bulk-mic');
    const ta = document.getElementById('act-bulk-input');
    if (!mic || !ta) return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    mic.addEventListener('click', () => {
      if (_recognition) {
        _recognition.stop();
        _recognition = null;
        mic.classList.remove('recording');
        return;
      }
      _recognition = new SpeechRec();
      _recognition.continuous = true;
      _recognition.interimResults = false;
      _recognition.lang = 'en-US';
      _recognition.onresult = (ev) => {
        let transcript = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) transcript += ev.results[i][0].transcript;
        }
        if (transcript) {
          ta.value = (ta.value ? ta.value + ' ' : '') + transcript;
          ta.focus();
        }
      };
      _recognition.onend = () => { _recognition = null; mic.classList.remove('recording'); };
      _recognition.onerror = () => { _recognition = null; mic.classList.remove('recording'); };
      _recognition.start();
      mic.classList.add('recording');
    });
  }

  function wireAiApproval() {
    if (!_aiPending) return;

    // Accept individual
    appEl.querySelectorAll('.act-ai-accept').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.accept);
        await applyAiSuggestion(idx);
        _aiPending.suggestions[idx]._applied = true;
        if (_aiPending.suggestions.every(s => s._applied || s._rejected)) _aiPending = null;
        refreshMain();
      });
    });

    // Reject individual
    appEl.querySelectorAll('.act-ai-reject').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.reject);
        _aiPending.suggestions[idx]._rejected = true;
        btn.closest('.act-ai-row')?.remove();
        if (_aiPending.suggestions.every(s => s._applied || s._rejected)) _aiPending = null;
      });
    });

    // Accept all
    document.getElementById('act-ai-accept-all')?.addEventListener('click', async () => {
      for (let i = 0; i < _aiPending.suggestions.length; i++) {
        if (!_aiPending.suggestions[i]._applied && !_aiPending.suggestions[i]._rejected) {
          await applyAiSuggestion(i);
        }
      }
      _aiPending = null;
      refreshMain();
      showToast('All AI suggestions applied');
    });

    // Dismiss
    document.getElementById('act-ai-dismiss')?.addEventListener('click', () => {
      _aiPending = null;
      refreshMain();
    });
  }

  async function applyAiSuggestion(idx) {
    const s = _aiPending.suggestions[idx];
    const entry = _aiPending.entries[idx];
    if (!entry || !s?.categoryPath) return;
    // Find entry in _entries
    const real = _entries.find(e => e.id === entry.id);
    if (!real) return;
    real.categoryPath = s.categoryPath;
    if (s.estimatedDuration && !real.duration) {
      real.duration = s.estimatedDuration;
    }
    await saveEntry(real);
    // Train ML on this
    const leafId = s.categoryPath[s.categoryPath.length - 1];
    mlTrain(real.text, leafId);
    await saveTrackerData();
  }

  function wireTaskInteractions() {
    // Category dropdown toggle
    appEl.querySelectorAll('.act-cat-badge, .act-cat-unset').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = badge.dataset.id;
        const dd = document.getElementById('cat-dd-' + id);
        if (!dd) return;
        // Close other dropdowns
        appEl.querySelectorAll('.act-cat-dropdown:not([hidden])').forEach(d => { if (d !== dd) d.hidden = true; });
        dd.hidden = !dd.hidden;
      });
    });

    // Category selection
    appEl.querySelectorAll('.act-cat-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        const dd = opt.closest('.act-cat-dropdown');
        const row = opt.closest('.act-task-row');
        const entryId = row?.dataset.id;
        const pathStr = opt.dataset.path;
        if (!entryId || !pathStr) return;
        const path = pathStr.split(',');
        const entry = _entries.find(e => e.id === entryId);
        if (!entry) return;
        entry.categoryPath = path;
        await saveEntry(entry);
        // Train ML
        mlTrain(entry.text, path[path.length - 1]);
        await saveTrackerData();
        dd.hidden = true;
        refreshMain();
      });
    });

    // ML suggestion pills
    appEl.querySelectorAll('.act-suggest-pill').forEach(pill => {
      pill.addEventListener('click', async () => {
        const entryId = pill.dataset.entry;
        const catId = pill.dataset.cat;
        const entry = _entries.find(e => e.id === entryId);
        if (!entry) return;
        const path = getCategoryPath(catId);
        entry.categoryPath = path;
        await saveEntry(entry);
        mlTrain(entry.text, catId);
        await saveTrackerData();
        refreshMain();
        showToast('Categorized');
      });
    });

    // Star/milestone rating
    appEl.querySelectorAll('.act-stars').forEach(container => {
      const entryId = container.dataset.id;
      container.querySelectorAll('.act-star').forEach(star => {
        star.addEventListener('click', async () => {
          const n = parseInt(star.dataset.star);
          const entry = _entries.find(e => e.id === entryId);
          if (!entry) return;
          entry.milestone = entry.milestone === n ? 0 : n; // toggle
          await saveEntry(entry);
          refreshMain();
        });
      });
    });

    // Duration inline input
    appEl.querySelectorAll('.act-task-duration-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const entryId = inp.dataset.id;
        const entry = _entries.find(e => e.id === entryId);
        if (!entry) return;
        const { duration } = parseDuration(inp.value + 'm'); // default to minutes
        if (duration) {
          entry.duration = duration;
          await saveEntry(entry);
          refreshMain();
        }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { inp.blur(); }
      });
    });

    // Edit
    appEl.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = _entries.find(e => e.id === btn.dataset.edit);
        if (!entry) return;
        // Insert edit modal into DOM
        const existing = document.getElementById('act-edit-overlay');
        if (existing) existing.remove();
        appEl.insertAdjacentHTML('beforeend', renderEditModal(entry));
        wireEditModal(entry);
      });
    });

    // Delete
    appEl.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delete;
        await deleteEntry(id);
        _entries = _entries.filter(e => e.id !== id);
        refreshMain();
        showToast('Task deleted');
      });
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
      appEl.querySelectorAll('.act-cat-dropdown:not([hidden])').forEach(d => d.hidden = true);
    });
  }

  function wireEditModal(entry) {
    document.getElementById('act-edit-cancel')?.addEventListener('click', () => {
      document.getElementById('act-edit-overlay')?.remove();
    });
    document.getElementById('act-edit-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'act-edit-overlay') e.target.remove();
    });
    document.getElementById('act-edit-save')?.addEventListener('click', async () => {
      const text = document.getElementById('act-edit-text')?.value?.trim();
      const date = document.getElementById('act-edit-date')?.value;
      const durRaw = document.getElementById('act-edit-duration')?.value?.trim();
      if (!text) return;
      const { duration } = durRaw ? parseDuration(durRaw + (durRaw.match(/[hm]/) ? '' : 'm')) : { duration: null };
      const oldDate = entry.date;
      entry.text = text;
      entry.date = date || oldDate;
      if (duration !== null) entry.duration = duration;
      await saveEntry(entry);
      // If date changed, remove from current view's entries and reload
      if (entry.date !== oldDate) {
        _entries = _entries.filter(e => e.id !== entry.id);
      }
      document.getElementById('act-edit-overlay')?.remove();
      refreshMain();
      showToast('Task updated');
    });
  }

  /* ═══════════════════════════════════════════════════════════
     WEEKLY VIEW
     ═══════════════════════════════════════════════════════════ */
  function renderWeekly() {
    const weekStart = getWeekStart(_currentDate);
    let html = `
      <div class="act-date-nav">
        <button class="act-date-btn" id="act-week-prev">${chevronLeft()}</button>
        <h2>Week of ${formatDateShort(weekStart)}</h2>
        <button class="act-date-today" id="act-week-today">This Week</button>
        <button class="act-date-btn" id="act-week-next">${chevronRight()}</button>
      </div>
      <p style="color:var(--muted);font-size:.78rem;margin:0 0 .75rem">Drag tasks between days to reassign dates.</p>
      <div class="act-week-grid">`;

    for (let i = 0; i < 7; i++) {
      const day = offsetDate(weekStart, i);
      const dayEntries = _entries.filter(e => e.date === day);
      const isToday = day === todayStr();
      html += `<div class="act-week-day${isToday ? ' today' : ''}" data-drop-date="${day}">
        <div class="act-week-day-header">${formatDateShort(day)}</div>
        ${dayEntries.map(e => {
          const color = getTopLevelColor(e.categoryPath);
          return `<div class="act-week-task" draggable="true" data-entry-id="${e.id}" data-entry-date="${e.date}" style="background:${color}22;border-left:2px solid ${color}">${esc(e.text.slice(0, 40))}${e.duration ? ' <span style="opacity:.6">' + formatMinutes(e.duration) + '</span>' : ''}</div>`;
        }).join('')}
        ${!dayEntries.length ? '<div class="act-week-empty" style="color:var(--muted);font-size:.7rem;opacity:.5">No tasks</div>' : ''}
      </div>`;
    }
    html += '</div>';

    html += renderSummary(_entries);

    return html;
  }

  function wireWeekly() {
    document.getElementById('act-week-prev')?.addEventListener('click', async () => {
      _currentDate = offsetDate(getWeekStart(_currentDate), -7);
      await loadEntriesForWeek(getWeekStart(_currentDate));
      refreshMain();
    });
    document.getElementById('act-week-next')?.addEventListener('click', async () => {
      _currentDate = offsetDate(getWeekStart(_currentDate), 7);
      await loadEntriesForWeek(getWeekStart(_currentDate));
      refreshMain();
    });
    document.getElementById('act-week-today')?.addEventListener('click', async () => {
      _currentDate = todayStr();
      await loadEntriesForWeek(getWeekStart(_currentDate));
      refreshMain();
    });

    // Drag and drop between days
    wireWeeklyDragDrop();
  }

  function wireWeeklyDragDrop() {
    let dragEntryId = null;

    appEl.querySelectorAll('.act-week-task[draggable]').forEach(task => {
      task.addEventListener('dragstart', (e) => {
        dragEntryId = task.dataset.entryId;
        e.dataTransfer.effectAllowed = 'move';
        task.style.opacity = '.4';
      });
      task.addEventListener('dragend', () => {
        task.style.opacity = '';
        appEl.querySelectorAll('.act-week-day').forEach(d => d.classList.remove('act-drop-over'));
      });
    });

    appEl.querySelectorAll('.act-week-day[data-drop-date]').forEach(dayEl => {
      dayEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dayEl.classList.add('act-drop-over');
      });
      dayEl.addEventListener('dragleave', () => {
        dayEl.classList.remove('act-drop-over');
      });
      dayEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        dayEl.classList.remove('act-drop-over');
        if (!dragEntryId) return;
        const newDate = dayEl.dataset.dropDate;
        const entry = _entries.find(en => en.id === dragEntryId);
        if (!entry || entry.date === newDate) return;
        entry.date = newDate;
        await saveEntry(entry);
        refreshMain();
        showToast('Moved to ' + formatDateShort(newDate));
        dragEntryId = null;
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     ANALYTICS VIEW
     ═══════════════════════════════════════════════════════════ */
  function renderAnalytics() {
    const hasAI = !!_profile?.anthropicKey;

    return `
      <h2 style="margin:0 0 1rem">Analytics — Last 30 Days</h2>

      <div class="act-metrics" id="act-metrics"></div>

      <div class="act-charts-grid">
        <div class="act-chart-card">
          <h3>Time Distribution</h3>
          <div class="act-chart-wrap"><canvas id="act-chart-dist"></canvas></div>
        </div>
        <div class="act-chart-card">
          <h3>Daily Trend</h3>
          <div class="act-chart-wrap"><canvas id="act-chart-trend"></canvas></div>
        </div>
        <div class="act-chart-card">
          <h3>Category Breakdown</h3>
          <div class="act-chart-wrap"><canvas id="act-chart-cats"></canvas></div>
        </div>
        <div class="act-chart-card">
          <h3>Milestones</h3>
          <div class="act-chart-wrap" id="act-milestones-wrap"></div>
        </div>
      </div>

      ${hasAI ? `<button class="act-ai-btn" id="act-ai-insights" style="margin-top:.5rem">Get AI Insights</button><div id="act-ai-insights-result" style="margin-top:.75rem"></div>` : ''}
    `;
  }

  function wireAnalytics() {
    // Destroy old charts
    Object.values(_chartInstances).forEach(c => { try { c.destroy(); } catch {} });
    _chartInstances = {};

    const entries = _entries;
    buildMetrics(entries);
    buildDistributionChart(entries);
    buildTrendChart(entries);
    buildCategoryChart(entries);
    buildMilestoneList(entries);

    // AI insights
    document.getElementById('act-ai-insights')?.addEventListener('click', async () => {
      const btn = document.getElementById('act-ai-insights');
      const result = document.getElementById('act-ai-insights-result');
      if (!result) return;
      btn.disabled = true;
      btn.textContent = 'Analyzing...';
      result.innerHTML = '<p style="color:var(--muted)">Thinking...</p>';

      const apiKey = _profile?.anthropicKey;
      if (!apiKey) { result.innerHTML = '<p style="color:var(--danger)">Add API key in Settings.</p>'; btn.disabled = false; return; }

      const summary = buildDataSummaryForAI(entries);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{ role: 'user', content: `You are an academic productivity advisor. Analyze this 30-day activity summary for a lab member and provide 3-5 specific, actionable insights about time management and efficiency. Be encouraging but honest.\n\n${summary}` }]
          })
        });
        const j = await res.json();
        const text = j.content?.[0]?.text || j.error?.message || 'No response';
        result.innerHTML = `<div class="app-card" style="white-space:pre-wrap;font-size:.88rem;line-height:1.6">${esc(text)}</div>`;
      } catch (err) {
        result.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
      }
      btn.disabled = false;
      btn.textContent = 'Get AI Insights';
    });
  }

  function buildMetrics(entries) {
    const el = document.getElementById('act-metrics');
    if (!el) return;
    const totalMins = entries.reduce((s, e) => s + (e.duration || 0), 0);
    const daysLogged = new Set(entries.map(e => e.date)).size;
    const avgPerDay = daysLogged ? Math.round(totalMins / daysLogged) : 0;
    const milestones = entries.filter(e => e.milestone > 0).length;
    const catCount = new Set(entries.filter(e => e.categoryPath?.length).map(e => e.categoryPath[0])).size;

    el.innerHTML = [
      { val: formatMinutes(totalMins) || '0m', label: 'Total Time' },
      { val: daysLogged, label: 'Days Logged' },
      { val: formatMinutes(avgPerDay) || '0m', label: 'Avg / Day' },
      { val: entries.length, label: 'Total Tasks' },
      { val: milestones, label: 'Milestones' },
      { val: catCount, label: 'Categories' }
    ].map(m => `<div class="act-metric-card"><div class="act-metric-value">${m.val}</div><div class="act-metric-label">${m.label}</div></div>`).join('');
  }

  function buildDistributionChart(entries) {
    const canvas = document.getElementById('act-chart-dist');
    if (!canvas) return;
    const totals = {};
    for (const e of entries) {
      const topId = e.categoryPath?.[0] || '_other';
      totals[topId] = (totals[topId] || 0) + (e.duration || 0);
    }
    const cats = getCategories();
    const labels = [];
    const data = [];
    const colors = [];
    for (const [id, mins] of Object.entries(totals)) {
      const cat = cats.find(c => c.id === id);
      labels.push(cat?.label || 'Other');
      data.push(Math.round(mins / 60 * 10) / 10);
      colors.push(cat?.color || 'rgba(255,255,255,.2)');
    }
    _chartInstances.dist = new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#8a94a6', font: { size: 10 } } } }
      }
    });
  }

  function buildTrendChart(entries) {
    const canvas = document.getElementById('act-chart-trend');
    if (!canvas) return;
    const byDate = {};
    for (const e of entries) {
      byDate[e.date] = (byDate[e.date] || 0) + (e.duration || 0);
    }
    const dates = Object.keys(byDate).sort();
    const data = dates.map(d => Math.round(byDate[d] / 60 * 10) / 10);

    _chartInstances.trend = new Chart(canvas, {
      type: 'line',
      data: {
        labels: dates.map(d => formatDateShort(d)),
        datasets: [{
          data,
          borderColor: '#5baed1',
          backgroundColor: 'rgba(91,174,209,.15)',
          fill: true,
          tension: .3,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8a94a6', font: { size: 9 }, maxRotation: 45 }, grid: { display: false } },
          y: { ticks: { color: '#8a94a6', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,.06)' }, title: { display: true, text: 'Hours', color: '#8a94a6', font: { size: 10 } } }
        }
      }
    });
  }

  function buildCategoryChart(entries) {
    const canvas = document.getElementById('act-chart-cats');
    if (!canvas) return;
    const totals = {};
    for (const e of entries) {
      const leaf = e.categoryPath?.[e.categoryPath.length - 1];
      if (!leaf) continue;
      const cat = findCategory(leaf);
      totals[leaf] = { mins: (totals[leaf]?.mins || 0) + (e.duration || 0), label: cat?.label || leaf, color: getTopLevelColor(e.categoryPath) };
    }
    const sorted = Object.values(totals).sort((a, b) => b.mins - a.mins).slice(0, 10);
    _chartInstances.cats = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: sorted.map(s => s.label),
        datasets: [{ data: sorted.map(s => Math.round(s.mins / 60 * 10) / 10), backgroundColor: sorted.map(s => s.color + 'cc'), borderRadius: 3 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8a94a6', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,.06)' }, title: { display: true, text: 'Hours', color: '#8a94a6', font: { size: 10 } } },
          y: { ticks: { color: '#8a94a6', font: { size: 9 } }, grid: { display: false } }
        }
      }
    });
  }

  function buildMilestoneList(entries) {
    const wrap = document.getElementById('act-milestones-wrap');
    if (!wrap) return;
    const milestones = entries.filter(e => e.milestone > 0).sort((a, b) => b.milestone - a.milestone || b.date?.localeCompare(a.date));
    if (!milestones.length) {
      wrap.innerHTML = '<div class="act-empty" style="padding:1rem"><p>No milestones yet</p></div>';
      return;
    }
    wrap.style.overflowY = 'auto';
    wrap.innerHTML = milestones.map(m =>
      `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.82rem;border-bottom:1px solid var(--border)">
        <span style="color:#fbbf24">${'&#9733;'.repeat(m.milestone)}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.text)}</span>
        <span style="color:var(--muted);font-size:.72rem">${formatDateShort(m.date)}</span>
      </div>`
    ).join('');
  }

  function buildDataSummaryForAI(entries) {
    const totals = {};
    for (const e of entries) {
      const topId = e.categoryPath?.[0] || 'uncategorized';
      const cat = findCategory(topId);
      const label = cat?.label || 'Uncategorized';
      totals[label] = (totals[label] || 0) + (e.duration || 0);
    }
    const daysLogged = new Set(entries.map(e => e.date)).size;
    const totalMins = entries.reduce((s, e) => s + (e.duration || 0), 0);
    let summary = `Period: 30 days\nDays with logged activity: ${daysLogged}\nTotal tasks: ${entries.length}\nTotal time: ${formatMinutes(totalMins)}\n\nTime by category:\n`;
    for (const [label, mins] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
      const pct = totalMins ? Math.round(mins / totalMins * 100) : 0;
      summary += `- ${label}: ${formatMinutes(mins)} (${pct}%)\n`;
    }
    const milestones = entries.filter(e => e.milestone > 0);
    if (milestones.length) {
      summary += `\nMilestones (${milestones.length}):\n`;
      for (const m of milestones) {
        summary += `- ${'*'.repeat(m.milestone)} ${m.text} (${m.date})\n`;
      }
    }
    return summary;
  }

  /* ═══════════════════════════════════════════════════════════
     CATEGORIES MANAGER
     ═══════════════════════════════════════════════════════════ */
  function renderCategoriesManager() {
    let html = `<h2 style="margin:0 0 1rem">Categories</h2>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:1rem">Organize your activity categories. Click + to add subcategories.</p>`;
    html += '<div class="app-card">' + renderCatTree(getCategories(), 0) + '</div>';
    html += `<div style="margin-top:.75rem"><button class="act-add-cat-btn" id="act-add-top-cat">+ Add Top-Level Category</button></div>`;
    return html;
  }

  function renderCatTree(cats, depth) {
    let html = `<ul class="act-cat-tree${depth > 0 ? ' act-cat-children' : ''}">`;
    for (const cat of cats) {
      html += `<li>
        <div class="act-cat-item">
          <span class="act-cat-color-dot" style="background:${cat.color || getTopLevelColor([cat.id])}"></span>
          <span class="act-cat-name">${esc(cat.label)}</span>
          <button class="act-add-cat-btn" data-parent="${cat.id}" title="Add subcategory">+</button>
          ${depth > 0 ? `<button class="act-task-action-btn" data-remove-cat="${cat.id}" title="Remove">${trashIcon()}</button>` : ''}
        </div>
        ${cat.children?.length ? renderCatTree(cat.children, depth + 1) : ''}
      </li>`;
    }
    html += '</ul>';
    return html;
  }

  function wireCategoriesManager() {
    // Add subcategory
    appEl.querySelectorAll('[data-parent]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const parentId = btn.dataset.parent;
        const name = prompt('Subcategory name:');
        if (!name?.trim()) return;
        const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const parent = findCategory(parentId, _trackerData.categories);
        if (!parent) return;
        if (!parent.children) parent.children = [];
        parent.children.push({ id, label: name.trim(), children: [] });
        await saveTrackerData();
        refreshMain();
        showToast('Category added');
      });
    });

    // Add top-level
    document.getElementById('act-add-top-cat')?.addEventListener('click', async () => {
      const name = prompt('Category name:');
      if (!name?.trim()) return;
      const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      _trackerData.categories.push({ id, label: name.trim(), color, children: [] });
      await saveTrackerData();
      refreshMain();
      showToast('Category added');
    });

    // Remove category
    appEl.querySelectorAll('[data-remove-cat]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.removeCat;
        if (!confirm('Remove this category?')) return;
        removeCategoryById(id, _trackerData.categories);
        await saveTrackerData();
        refreshMain();
        showToast('Category removed');
      });
    });
  }

  function removeCategoryById(id, cats) {
    for (let i = 0; i < cats.length; i++) {
      if (cats[i].id === id) { cats.splice(i, 1); return true; }
      if (cats[i].children?.length && removeCategoryById(id, cats[i].children)) return true;
    }
    return false;
  }

  /* ═══════════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════════ */
  function renderSettings() {
    const s = _trackerData.settings || {};
    const hasKey = !!_profile?.anthropicKey;

    return `
      <h2 style="margin:0 0 1rem">Settings</h2>

      <div class="app-card act-settings-group">
        <h3>AI Assistant</h3>
        <div class="act-settings-row">
          <div>
            <div class="act-settings-label">Anthropic API Key</div>
            <div class="act-settings-hint">${hasKey ? 'Key configured in your profile.' : 'Add via your CV Builder settings to enable AI features.'}</div>
          </div>
          <span class="app-badge ${hasKey ? 'app-badge--active' : 'app-badge--soon'}">${hasKey ? 'Active' : 'Not Set'}</span>
        </div>
      </div>

      <div class="app-card act-settings-group">
        <h3>ML Model</h3>
        <div class="act-settings-row">
          <div>
            <div class="act-settings-label">Training samples</div>
            <div class="act-settings-hint">${_trackerData.mlModel.totalSamples} categorized tasks. ${_trackerData.mlModel.totalSamples < 5 ? 'Need at least 5 for predictions.' : 'Model is active.'}</div>
          </div>
          <span class="app-badge ${_trackerData.mlModel.totalSamples >= 5 ? 'app-badge--active' : 'app-badge--soon'}">${_trackerData.mlModel.totalSamples >= 5 ? 'Active' : 'Training'}</span>
        </div>
        ${_trackerData.mlModel.totalSamples > 0 ? `<div class="act-settings-row"><div><div class="act-settings-label">Reset ML Model</div><div class="act-settings-hint">Clear all training data and start fresh.</div></div><button class="app-btn app-btn--danger" id="act-reset-ml">Reset</button></div>` : ''}
      </div>

      <div class="app-card act-settings-group">
        <h3>Working Hours</h3>
        <div class="act-settings-row">
          <div class="act-settings-label">Start time</div>
          <input type="time" class="app-input" id="act-work-start" value="${s.workingHours?.start || '08:00'}" style="width:120px" />
        </div>
        <div class="act-settings-row">
          <div class="act-settings-label">End time</div>
          <input type="time" class="app-input" id="act-work-end" value="${s.workingHours?.end || '18:00'}" style="width:120px" />
        </div>
      </div>

      <div class="app-card act-settings-group">
        <h3>Data</h3>
        <div class="act-settings-row">
          <div>
            <div class="act-settings-label">Export data</div>
            <div class="act-settings-hint">Download all entries as JSON.</div>
          </div>
          <button class="app-btn app-btn--secondary" id="act-export">Export JSON</button>
        </div>
      </div>
    `;
  }

  function wireSettings() {
    // Reset ML
    document.getElementById('act-reset-ml')?.addEventListener('click', async () => {
      if (!confirm('Reset the ML model? This clears all training data.')) return;
      _trackerData.mlModel = { wordWeights: {}, categoryPriors: {}, totalSamples: 0 };
      await saveTrackerData();
      refreshMain();
      showToast('ML model reset');
    });

    // Working hours
    const startInput = document.getElementById('act-work-start');
    const endInput = document.getElementById('act-work-end');
    async function saveHours() {
      if (!_trackerData.settings) _trackerData.settings = {};
      if (!_trackerData.settings.workingHours) _trackerData.settings.workingHours = {};
      _trackerData.settings.workingHours.start = startInput?.value || '08:00';
      _trackerData.settings.workingHours.end = endInput?.value || '18:00';
      await saveTrackerData();
      showToast('Saved');
    }
    startInput?.addEventListener('change', saveHours);
    endInput?.addEventListener('change', saveHours);

    // Export
    document.getElementById('act-export')?.addEventListener('click', async () => {
      const start = '2020-01-01';
      const end = '2099-12-31';
      await loadEntries(start, end);
      const blob = new Blob([JSON.stringify({ trackerData: _trackerData, entries: _entries }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `activity-tracker-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported');
      // Reload current date entries
      await loadEntries(_currentDate, _currentDate);
    });
  }

  /* Calendar integration is now handled by the shared CalendarService
     (apps/shared/calendar-service.js) and configured via Settings. */


  /* All calendar functions (renderCalendar, wireCalendar, OAuth, ICS parsing, etc.)
     have been moved to apps/shared/calendar-service.js.
     Calendar UI configuration now lives in the Settings app. */

  /* ═══════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════ */
  function refreshMain() {
    const main = document.getElementById('act-main');
    if (main) {
      main.innerHTML = renderSection();
      wireSection();
    }
  }

  function showToast(msg, type) {
    const el = document.getElementById('act-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'act-toast ' + (type || 'ok');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.className = 'act-toast hidden'; }, 2600);
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ─── SVG Icons (inline, small) ─────────────────────────── */
  function calendarIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'; }
  function weekIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="22"/><line x1="15" y1="4" x2="15" y2="22"/></svg>'; }
  function chartIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'; }
  function tagIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'; }
  function gearIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>'; }
  function calSyncIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M16 14l-4 4-2-2"/></svg>'; }
  function googleIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>'; }
  function outlookIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#0078D4" d="M24 7.387v10.478c0 .23-.08.424-.238.583a.793.793 0 01-.583.238h-8.87V6.565h8.87c.23 0 .424.08.583.238.159.159.238.353.238.583z"/><path fill="#0364B8" d="M14.309 6.565v12.122L0 16.58V4.674l14.309 1.891z"/><ellipse fill="#fff" cx="7.155" cy="11.626" rx="3.46" ry="3.98"/><ellipse fill="#0078D4" cx="7.155" cy="11.626" rx="2.38" ry="2.93"/></svg>'; }
  function appleIcon() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>'; }
  function micIcon() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'; }
  function starIcon() { return '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'; }
  function editIcon() { return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'; }
  function trashIcon() { return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'; }
  function chevronLeft() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>'; }
  function chevronRight() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'; }
})();
