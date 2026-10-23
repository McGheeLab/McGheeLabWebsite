/* paper-writing-guide.js — V3.334
 *
 * The "✍️ Guide" pill tab in the paper editor's tabbed side panel. It is
 * a FOCUSED single-purpose tool, not a reference encyclopedia: it shows
 * the student what the section they are *currently writing* should
 * contain — the rhetorical moves, a short purpose, live self-checks
 * computed from the paper tree, and (collapsed) pitfalls + a good-vs-weak
 * example. Full lessons live in the training-paper-*.html pages; the
 * footer links out to them rather than duplicating their content.
 *
 * Guidance is CURATED STATIC content (no AI). It follows the writer's
 * focus by default; the 📌 pin toggle freezes it on the current section.
 *
 * Public surface (consumed by paper-equations.js's panel):
 *   window.PaperWritingGuide.buildTabContent(rootEl)  // idempotent scaffold
 *   window.PaperWritingGuide.refresh()                // re-render for current context
 *   window.PaperWritingGuide.getContext()             // {sectionId, sectionKind, blockId, blockKind} | null
 *
 * Reads only public accessors: window.PaperEditor.getPaperMap() and
 * window.PaperSchemas. Holds no editor state and mutates nothing.
 */
(function () {
  'use strict';

  /* ── Curated content, keyed by PaperSchemas section kind ─────────────
   *
   * Each entry: { icon, purpose, moves:[{id,label,hint}], checks:[id],
   *               pitfalls:[str], example:{good,bad,note}, training:url }
   * `checks` names ids in the CHECKS registry below. Kinds without an
   * entry (or `custom`) fall back to GENERIC. */
  var TRAIN = '/rm/pages/training-paper-';
  var GUIDE_CONTENT = {
    abstract: {
      icon: 'document-text',
      purpose: 'A self-contained miniature of the whole paper — most readers never get past it.',
      moves: [
        { id: 'context', label: 'Set the context', hint: '1–2 sentences on why this problem matters. No textbook history.' },
        { id: 'problem', label: 'Name the problem', hint: 'One sentence: the specific gap or question you address.' },
        { id: 'approach', label: 'State what you did', hint: '"Here we…" — the approach, in plain language.' },
        { id: 'results', label: 'Give key results with numbers', hint: 'The one or two headline findings, quantified. Past tense.' },
        { id: 'implication', label: 'State the implication', hint: 'Why the result matters / what it enables.' },
      ],
      checks: ['word-count', 'no-citations', 'disallowed-content'],
      pitfalls: [
        'Writing it first — draft it last, once the results are settled.',
        'Vague results ("various conditions were tested") instead of numbers.',
        'Citations or undefined abbreviations (an abstract stands alone).',
      ],
      example: {
        good: 'Traction force microscopy requires soft substrates whose stiffness is hard to tune reproducibly. Here we introduce a two-stage crosslinking gel that holds modulus within 8% across batches, enabling force maps with <5% batch variance.',
        bad: 'Cell mechanics is an important field. We made a gel and measured forces. The results were good and have many applications.',
        note: 'The good version names the gap, quantifies the result, and states the payoff.',
      },
      training: TRAIN + 'abstract.html',
    },
    keywords: {
      icon: 'tag',
      purpose: 'Discovery terms — how a searcher who has never heard of your paper would find it.',
      moves: [
        { id: 'distinct', label: 'Pick 4–6 terms', hint: 'Prefer terms NOT already in your title (the title is already indexed).' },
        { id: 'searcher', label: 'Think like a searcher', hint: 'What phrase would someone type to look for this work?' },
      ],
      checks: ['word-count'],
      pitfalls: ['Repeating the title verbatim.', 'Over-broad single words ("biology") that match everything.'],
      example: {
        good: 'traction force microscopy; hydrogel stiffness; batch reproducibility; substrate crosslinking',
        bad: 'cells; forces; gel; science',
        note: 'Specific multi-word phrases beat generic single words.',
      },
      training: TRAIN + 'writing.html',
    },
    introduction: {
      icon: 'compass',
      purpose: 'Funnel the reader from "why this field matters" down to "here is exactly what we did."',
      moves: [
        { id: 'context', label: 'Establish context', hint: '1–2 sentences. Why does this problem matter now? No textbook openings.' },
        { id: 'known', label: 'What is known', hint: 'Brief, cited synthesis — only the work that sets up your gap.' },
        { id: 'gap', label: 'State the gap', hint: '"However, X remains unknown/unmeasured…" — one clear sentence.' },
        { id: 'purpose', label: 'Purpose + approach', hint: '"Here we show…" — what you did and how, in 2–3 sentences.' },
        { id: 'payoff', label: 'Preview the payoff', hint: 'Optional: one sentence on what the reader gains.' },
      ],
      checks: ['word-count', 'no-citations', 'skeleton-without-body'],
      pitfalls: [
        'Opening with textbook facts everyone already knows.',
        'Reviewing the whole field instead of the path to your specific gap.',
        'Burying the gap statement in the middle of a paragraph.',
      ],
      example: {
        good: 'Substrate stiffness governs cell traction, yet current gels drift up to 30% between batches. Prior tuning methods trade reproducibility for range. However, no approach fixes modulus without sacrificing tunability. Here we…',
        bad: 'Cells are the building blocks of life. Scientists have studied them for centuries. In this paper we study gels.',
        note: 'The good version reaches a concrete gap in three sentences.',
      },
      training: TRAIN + 'introduction.html',
    },
    background: {
      icon: 'books',
      purpose: 'Give the reader only what they need to follow YOUR argument — not a full literature review.',
      moves: [
        { id: 'orient', label: 'Orient the reader', hint: 'The minimum context to understand the rest of the paper.' },
        { id: 'synthesize', label: 'Synthesize prior work (cited)', hint: 'Group by idea, not by paper. Every claim gets a citation.' },
        { id: 'handoff', label: 'Hand off to the gap', hint: 'End pointing at what is still missing — the thing your work does.' },
      ],
      checks: ['word-count', 'no-citations'],
      pitfalls: ['Summarizing every related paper one by one.', 'Background the reader does not need for the results.'],
      training: TRAIN + 'introduction.html',
    },
    methods: {
      icon: 'beaker',
      purpose: 'Enough detail that a competent peer could reproduce your work exactly.',
      moves: [
        { id: 'materials', label: 'Reagents & materials', hint: 'Name, source/vendor, and catalog number for anything non-obvious.' },
        { id: 'params', label: 'Conditions', hint: 'Concentrations, times, temperatures, volumes — the exact numbers.' },
        { id: 'instrument', label: 'Instruments & settings', hint: 'Model + key acquisition settings (magnification, wavelength, etc.).' },
        { id: 'replicates', label: 'n and replicate structure', hint: 'How many, biological vs technical replicates, how randomized.' },
        { id: 'stats', label: 'Statistics & software', hint: 'Which test, which software + version, significance threshold.' },
        { id: 'approvals', label: 'Approvals', hint: 'IRB/IACUC/biosafety numbers where applicable.' },
      ],
      checks: ['skeleton-without-body'],
      pitfalls: [
        'Re-describing an established method instead of citing it.',
        'Leaving out n, catalog numbers, or software versions.',
      ],
      example: {
        good: 'Cells were seeded at 2×10⁴ cells/cm² on gels (n = 6 biological replicates) and imaged on a Nikon AX-R at 60× (561 nm). Traction was computed in ImageJ 1.54 (FTTC plugin). Groups were compared with a two-sided t-test (α = 0.05).',
        bad: 'Cells were seeded on gels and imaged. Traction was calculated and compared between groups.',
        note: 'Tip: use the inventory quick-insert to pull exact reagent/catalog details.',
      },
      training: TRAIN + 'methods.html',
    },
    results: {
      icon: 'chart-bar',
      purpose: 'Narrate what the data show — figure by figure — without interpreting yet.',
      moves: [
        { id: 'goal', label: 'State the goal', hint: '"To determine whether…" — why this experiment, in one clause.' },
        { id: 'did', label: 'What you did', hint: 'One clause of method — just enough to read the figure.' },
        { id: 'observed', label: 'What you observed', hint: 'The data, with numbers and a figure reference (insert a Fig. token).' },
        { id: 'micro', label: 'One-line takeaway', hint: 'At most one interpretive sentence — save the rest for Discussion.' },
      ],
      checks: ['results-figure-first', 'para-no-figref', 'unlabeled-numbered'],
      pitfalls: [
        'Interpretation creep — explaining why before Discussion.',
        'Re-narrating the Methods instead of pointing at the result.',
        'Describing a figure the reader cannot find (no reference token).',
      ],
      example: {
        good: 'To test batch stability, we measured modulus across six preparations. Modulus varied by 8% (Fig. 2a), well below the 30% of conventional gels.',
        bad: 'We think our gel is better. It probably works because the crosslinking is more even, which is important for cells.',
        note: 'The good version leads with the number and points at the figure.',
      },
      training: TRAIN + 'results.html',
    },
    discussion: {
      icon: 'chat-bubble-oval-left',
      purpose: 'Interpret what the results mean, honestly place them against the literature, and say what is next.',
      moves: [
        { id: 'restate', label: 'Restate the key finding', hint: 'In new words — not a copy of the abstract or results.' },
        { id: 'interpret', label: 'Interpret vs. literature (cited)', hint: 'How does this agree with / differ from prior work?' },
        { id: 'mechanism', label: 'Offer a mechanism', hint: 'Why might the result be what it is? Flag it as interpretation.' },
        { id: 'limits', label: 'State limitations', hint: 'Specific and honest — what the study cannot conclude.' },
        { id: 'implications', label: 'Implications & future work', hint: 'What this enables and the next concrete step.' },
      ],
      checks: ['word-count', 'no-citations'],
      pitfalls: [
        'Introducing brand-new results here (they belong in Results).',
        'Claiming the data "prove" something — say "suggest" / "are consistent with".',
        'Ignoring studies that conflict with your finding.',
      ],
      training: TRAIN + 'discussion.html',
    },
    conclusions: {
      icon: 'check-circle',
      purpose: 'One tight paragraph answering "so what" — no new information.',
      moves: [
        { id: 'answer', label: 'Answer the question', hint: 'The single most important takeaway of the paper.' },
        { id: 'sowhat', label: 'State the significance', hint: 'Why it matters beyond this study.' },
      ],
      checks: ['disallowed-content'],
      pitfalls: ['New data, figures, or citations.', 'Repeating the abstract word-for-word.'],
      training: TRAIN + 'discussion.html',
    },
    acknowledgements: {
      icon: 'heart-handshake',
      purpose: 'Credit funding, facilities, and non-author contributors.',
      moves: [
        { id: 'funding', label: 'Funding', hint: 'Agencies and grant numbers.' },
        { id: 'people', label: 'People & facilities', hint: 'Core facilities and anyone who helped but is not an author.' },
      ],
      checks: [],
      training: TRAIN + 'writing.html',
    },
    references: {
      icon: 'bookmark',
      purpose: 'Auto-generated at export from your [@cite] tokens.',
      moves: [
        { id: 'manage', label: 'Manage citations in the References tab', hint: 'Insert, link, and review every citation from the References pill — you do not write this section by hand.' },
      ],
      checks: [],
      training: TRAIN + 'writing.html',
    },
  };

  /* Guidance for a focused non-paragraph block. */
  var BLOCK_GUIDE = {
    figure: {
      icon: 'photo',
      purpose: 'A caption that lets the figure be read without the main text.',
      moves: [
        { id: 'title', label: 'Lead with a title sentence', hint: 'A short declarative statement of the takeaway, not "Figure showing…".' },
        { id: 'panels', label: 'Describe each panel', hint: '(A) …, (B) … — one clause per panel, in order.' },
        { id: 'methods', label: 'Give the reading minimum', hint: 'Scale bars, stains/channels, n, what error bars represent, significance markers.' },
      ],
      checks: ['caption-empty'],
      pitfalls: ['Captions that only label ("Figure 2") without stating the point.', 'Undefined error bars or significance stars.'],
      training: TRAIN + 'results.html',
    },
  };

  var GENERIC = {
    icon: 'pencil-square',
    purpose: 'Write one idea per paragraph, led by a topic sentence that carries the claim.',
    moves: [
      { id: 'topic', label: 'Open with the claim', hint: 'The first sentence states what the paragraph argues.' },
      { id: 'support', label: 'Support it', hint: 'Evidence, data, or citations that back the claim.' },
      { id: 'link', label: 'Link forward', hint: 'End by setting up the next idea.' },
    ],
    checks: ['skeleton-without-body'],
    pitfalls: ['Paragraphs covering several ideas at once.'],
    training: TRAIN + 'paragraphs.html',
  };

  /* Constant craft tips shown (collapsed) on every section. */
  var CRAFT_TIPS = [
    'One idea per paragraph; the topic sentence carries the claim.',
    'A skeleton bullet is one sentence — outline first, then expand to prose.',
    'Place a figure/equation/table reference token where you mention it; numbering stays live.',
    'Write content, not formatting — the export template handles journal style.',
  ];

  /* ── Snapshot of the paper tree ──────────────────────────────────────
   *
   * Built fresh on each refresh by walking PaperEditor.getPaperMap().
   * Plain-JS projection so checks never hold Y refs. */
  function _yStr(y) {
    if (!y) return '';
    if (typeof y === 'string') return y;
    if (typeof y.toString === 'function') return y.toString();
    return '';
  }

  function _buildSnapshot() {
    var PE = window.PaperEditor;
    var map = PE && PE.getPaperMap && PE.getPaperMap();
    var snap = { sections: [], refTokens: Object.create(null), numberedLabels: [] };
    if (!map || typeof map.get !== 'function') return snap;
    var sections = map.get('sections');
    if (!sections || typeof sections.forEach !== 'function') return snap;

    function noteRefs(text) {
      if (!text) return;
      var re = /\[!(fig|tab):([^\]\n:]+)/g, m;
      while ((m = re.exec(text))) snap.refTokens[m[1] + ':' + m[2].trim()] = true;
    }

    sections.forEach(function (secMap) {
      if (!secMap || typeof secMap.get !== 'function') return;
      var kind = secMap.get('kind') || 'custom';
      var sec = {
        id: secMap.get('id'),
        kind: kind,
        label: _yStr(secMap.get('label')),
        style: _styleFor(kind, secMap.get('style_overrides')),
        blocks: [],
      };
      var children = secMap.get('children');
      if (children && typeof children.forEach === 'function') {
        children.forEach(function (blk) {
          if (!blk || typeof blk.get !== 'function') return;
          var bkind = blk.get('kind') || 'paragraph';
          var b = { id: blk.get('id'), kind: bkind, status: blk.get('status') || 'draft',
                    body: '', skeletonText: '', numbered: false, hasLabel: false };
          if (bkind === 'paragraph') {
            b.body = _yStr(blk.get('body'));
            var sk = blk.get('skeleton_items');
            if (sk && typeof sk.forEach === 'function') {
              var parts = [];
              sk.forEach(function (it) { if (it && it.get) parts.push(_yStr(it.get('text'))); });
              b.skeletonText = parts.join(' ').trim();
            }
            if (!b.skeletonText) b.skeletonText = _yStr(blk.get('skeleton'));
            noteRefs(b.body);
          } else if (bkind === 'figure') {
            b.body = _yStr(blk.get('body'));   // caption
            var fattrs = blk.get('attrs');
            if (fattrs && fattrs.get) {
              b.numbered = fattrs.get('numbered') !== false;
              b.hasLabel = !!(fattrs.get('label') || '').trim();
            }
            noteRefs(b.body);
          } else if (bkind === 'table') {
            var tattrs = blk.get('attrs');
            if (tattrs && tattrs.get) {
              b.numbered = tattrs.get('numbered') !== false;
              b.hasLabel = !!(tattrs.get('label') || '').trim();
              noteRefs(_yStr(tattrs.get('caption')));
            }
          }
          sec.blocks.push(b);
        });
      }
      snap.sections.push(sec);
    });

    /* Numbered float labels for the unreferenced-floats check. */
    try {
      (window.PaperEditor.getNumberedFigures() || []).forEach(function (f) {
        if (f.label) snap.numberedLabels.push({ kind: 'fig', label: f.label, num: f.num, section: 'Figure ' + f.num });
      });
      (window.PaperEditor.getNumberedTables() || []).forEach(function (t) {
        if (t.label) snap.numberedLabels.push({ kind: 'tab', label: t.label, num: t.num, section: 'Table ' + t.num });
      });
    } catch (e) {}
    return snap;
  }

  function _styleFor(kind, overrides) {
    var S = window.PaperSchemas;
    if (S && typeof S.styleFor === 'function') {
      try { return S.styleFor({ kind: kind, style_overrides: overrides }); } catch (e) {}
    }
    return {};
  }

  function _sectionSnap(snap, sectionId) {
    for (var i = 0; i < snap.sections.length; i++) {
      if (snap.sections[i].id === sectionId) return snap.sections[i];
    }
    return null;
  }

  /* Word count of prose, stripping tokens/markup. */
  function _wordCount(body) {
    if (!body) return 0;
    var t = body
      .replace(/\$[^$]*\$/g, ' ')      // math
      .replace(/\[[@!][^\]\n]*\]/g, ' ') // cite / ref / footnote tokens
      .replace(/[*~^`_]/g, ' ');        // markdown emphasis marks
    var m = t.match(/\S+/g);
    return m ? m.length : 0;
  }

  function _sectionWords(sec) {
    var n = 0;
    sec.blocks.forEach(function (b) { if (b.kind === 'paragraph') n += _wordCount(b.body); });
    return n;
  }

  /* ── Checks registry ──────────────────────────────────────────────────
   * Each: run(sec, snap) → {level:'ok'|'warn'|'info', message} | null. */
  var CITE_KINDS = { introduction: 1, background: 1, discussion: 1 };
  var CHECKS = {
    'word-count': function (sec) {
      var max = sec.style && sec.style.maxWords;
      if (!max) return null;
      var n = _sectionWords(sec);
      if (!n) return null;
      if (n > max) return { level: 'warn', message: n + ' / ' + max + ' words — over the limit' };
      return { level: 'info', message: n + ' / ' + max + ' words' };
    },
    'no-citations': function (sec) {
      if (!CITE_KINDS[sec.kind]) return null;
      var proseParas = sec.blocks.filter(function (b) { return b.kind === 'paragraph' && _wordCount(b.body) >= 40; });
      if (!proseParas.length) return null;
      /* V3.645 — `[@item:KEY]` shares the citation namespace but is an
       * inventory reference, not a citation. Strip those first or a
       * Methods paragraph whose only bracket token is a reagent reads
       * as "cited" and this check silently stops firing on it. */
      var uncited = proseParas.filter(function (b) {
        return String(b.body).replace(/\[@item:[A-Za-z0-9][\w-]*\]/g, '').indexOf('[@') === -1;
      });
      if (!uncited.length) return null;
      return { level: 'warn', message: uncited.length + ' substantial paragraph' + (uncited.length > 1 ? 's have' : ' has') + ' no citations' };
    },
    'skeleton-without-body': function (sec) {
      var n = sec.blocks.filter(function (b) {
        return b.kind === 'paragraph' && b.skeletonText && !b.body.trim();
      }).length;
      if (!n) return null;
      return { level: 'info', message: n + ' outlined paragraph' + (n > 1 ? 's' : '') + ' still need prose' };
    },
    'results-figure-first': function (sec) {
      if (sec.kind !== 'results') return null;
      var hasPara = sec.blocks.some(function (b) { return b.kind === 'paragraph' && _wordCount(b.body) >= 20; });
      var hasFloat = sec.blocks.some(function (b) { return b.kind === 'figure' || b.kind === 'table'; });
      if (hasPara && !hasFloat) return { level: 'warn', message: 'Results usually narrate a figure — none placed in this section yet' };
      return null;
    },
    'para-no-figref': function (sec) {
      if (sec.kind !== 'results') return null;
      var n = sec.blocks.filter(function (b) {
        return b.kind === 'paragraph' && _wordCount(b.body) >= 20 &&
          b.body.indexOf('[!fig:') === -1 && b.body.indexOf('[!tab:') === -1;
      }).length;
      if (!n) return null;
      return { level: 'info', message: n + ' results paragraph' + (n > 1 ? 's' : '') + ' without a figure/table reference' };
    },
    'unlabeled-numbered': function (sec) {
      var n = sec.blocks.filter(function (b) {
        return (b.kind === 'figure' || b.kind === 'table') && b.numbered && !b.hasLabel;
      }).length;
      if (!n) return null;
      return { level: 'warn', message: n + ' numbered float' + (n > 1 ? 's' : '') + ' with no label — can\'t be cross-referenced yet' };
    },
    'disallowed-content': function (sec) {
      var st = sec.style || {};
      var bad = [];
      sec.blocks.forEach(function (b) {
        if (b.kind === 'figure' && st.allowFigures === false) bad.push('figure');
        if (b.kind === 'table' && st.allowFigures === false) bad.push('table');
        if (b.kind === 'equation' && st.allowEquations === false) bad.push('equation');
      });
      if (!bad.length) return null;
      return { level: 'warn', message: 'This section usually should not contain a ' + bad[0] + '.' };
    },
    'caption-empty': function (sec, snap, block) {
      if (!block || block.kind !== 'figure') return null;
      if (block.body.trim()) return null;
      return { level: 'warn', message: 'This figure has no caption yet' };
    },
  };

  function _runChecks(ids, sec, snap, block) {
    var out = [];
    (ids || []).forEach(function (id) {
      var fn = CHECKS[id];
      if (!fn) return;
      try {
        var r = fn(sec, snap, block);
        if (r) out.push(r);
      } catch (e) {}
    });
    return out;
  }

  /* Paper-wide checks (no-focus view). */
  function _paperChecks(snap) {
    var out = [];
    /* Unreferenced numbered floats. */
    var orphans = snap.numberedLabels.filter(function (f) {
      return !snap.refTokens[f.kind + ':' + f.label];
    });
    if (orphans.length) {
      out.push({ level: 'warn', message: orphans.length + ' numbered float' + (orphans.length > 1 ? 's are' : ' is') + ' never referenced in the text' });
    }
    /* Status roll-up across every block. */
    var counts = { draft: 0, 'needs-review': 0, complete: 0 };
    snap.sections.forEach(function (sec) {
      sec.blocks.forEach(function (b) { if (counts[b.status] != null) counts[b.status]++; });
    });
    var total = counts.draft + counts['needs-review'] + counts.complete;
    if (total) {
      out.push({ level: 'info', message: counts.draft + ' draft · ' + counts['needs-review'] + ' needs-review · ' + counts.complete + ' complete' });
    }
    return out;
  }

  /* ── Focus context ───────────────────────────────────────────────────── */
  var _lastFocus = null;    // most recent focus from paper-editor
  var _pinned = null;       // frozen context when follow is off
  var _follow = true;
  try { _follow = localStorage.getItem('rm_paper_guide_follow') !== '0'; } catch (e) {}

  function _displayCtx() { return _follow ? _lastFocus : _pinned; }

  window.addEventListener('paper-focus-changed', function (e) {
    _lastFocus = (e && e.detail) || null;
    if (_follow) _scheduleRender(true);
  });

  /* Recompute checks on doc changes (throttled), without a full re-render. */
  var _checkTimer = null;
  window.addEventListener('paper-panel-changed', function () {
    if (!_isVisible()) return;
    if (_checkTimer) return;
    _checkTimer = setTimeout(function () {
      _checkTimer = null;
      if (_isVisible()) _render();
    }, 1500);
  });

  function _isVisible() {
    if (!_root) return false;
    var tab = _root.closest ? _root.closest('.pe-tab-content') : null;
    if (tab && tab.style.display === 'none') return false;
    var pane = _root.closest ? _root.closest('#pe-equations-pane') : null;
    if (pane && pane.hidden) return false;
    return true;
  }

  var _renderTimer = null;
  function _scheduleRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(function () { _renderTimer = null; _render(); }, 60);
  }

  /* ── Rendering ───────────────────────────────────────────────────────── */
  var _root = null;

  function _kindLabel(kind) {
    var S = window.PaperSchemas;
    return (S && S.SECTION_KIND_LABELS && S.SECTION_KIND_LABELS[kind]) || (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Section');
  }

  function _el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function _checkRow(c) {
    var row = _el('div', 'pe-guide-check pe-guide-check--' + c.level);
    row.appendChild(_el('span', 'pe-guide-check-dot'));
    row.appendChild(_el('span', 'pe-guide-check-msg', c.message));
    return row;
  }

  function _detailsBlock(summary, buildBody, open) {
    var d = document.createElement('details');
    d.className = 'pe-guide-details';
    if (open) d.open = true;
    var s = document.createElement('summary');
    s.textContent = summary;
    d.appendChild(s);
    buildBody(d);
    return d;
  }

  function _render() {
    if (!_root) return;
    var snap = _buildSnapshot();
    var ctx = _displayCtx();
    _root.innerHTML = '';

    /* Header: icon + label + pin toggle. */
    var content, sec = null, block = null, headingKind;
    if (ctx && ctx.blockKind === 'figure') {
      content = BLOCK_GUIDE.figure;
      headingKind = 'Figure caption';
      sec = _sectionSnap(snap, ctx.sectionId);
      if (sec) { for (var i = 0; i < sec.blocks.length; i++) { if (sec.blocks[i].id === ctx.blockId) { block = sec.blocks[i]; break; } } }
    } else if (ctx && ctx.sectionKind) {
      content = GUIDE_CONTENT[ctx.sectionKind] || GENERIC;
      headingKind = _kindLabel(ctx.sectionKind);
      sec = _sectionSnap(snap, ctx.sectionId);
    }

    var header = _el('div', 'pe-guide-header');
    var titleWrap = _el('div', 'pe-guide-title');
    var titleIcon = _el('span', 'pe-guide-icon');
    titleIcon.innerHTML = ICON.render(content ? content.icon : 'pencil');
    titleWrap.appendChild(titleIcon);
    titleWrap.appendChild(_el('span', 'pe-guide-kind', content ? headingKind : 'Writing Guide'));
    header.appendChild(titleWrap);

    var pin = _el('button', 'pe-icon-btn pe-guide-pin');
    ICON.label(pin, _follow ? 'pin' : 'map-pin');
    pin.type = 'button';
    pin.title = _follow ? 'Following your cursor — click to pin to this section' : 'Pinned — click to follow your cursor again';
    pin.setAttribute('aria-pressed', _follow ? 'false' : 'true');
    pin.addEventListener('click', function () {
      if (_follow) { _pinned = _lastFocus; _follow = false; }
      else { _follow = true; }
      try { localStorage.setItem('rm_paper_guide_follow', _follow ? '1' : '0'); } catch (e) {}
      _render();
    });
    header.appendChild(pin);
    _root.appendChild(header);

    if (!content) { _renderPaperLevel(snap); return; }

    /* Purpose. */
    _root.appendChild(_el('div', 'pe-guide-purpose', content.purpose));

    /* Moves. */
    var moves = _el('div', 'pe-guide-moves');
    (content.moves || []).forEach(function (mv) {
      var row = _el('div', 'pe-guide-move');
      var head = _el('button', 'pe-guide-move-head');
      head.type = 'button';
      head.appendChild(_el('span', 'pe-guide-move-num'));
      head.appendChild(_el('span', 'pe-guide-move-label', mv.label));
      var hint = _el('div', 'pe-guide-move-hint', mv.hint);
      hint.hidden = true;
      head.addEventListener('click', function () {
        hint.hidden = !hint.hidden;
        row.classList.toggle('open', !hint.hidden);
      });
      row.appendChild(head);
      row.appendChild(hint);
      moves.appendChild(row);
    });
    _root.appendChild(moves);

    /* Live checks. */
    var checks = _runChecks(content.checks, sec || { kind: (ctx && ctx.sectionKind) || 'custom', blocks: [], style: {} }, snap, block);
    checks.sort(function (a, b) {
      var rank = { warn: 0, info: 1, ok: 2 };
      return rank[a.level] - rank[b.level];
    });
    if (checks.length) {
      var checkWrap = _el('div', 'pe-guide-checks');
      checkWrap.appendChild(_el('div', 'pe-guide-checks-title', 'Live self-check'));
      checks.forEach(function (c) { checkWrap.appendChild(_checkRow(c)); });
      _root.appendChild(checkWrap);
    }

    /* Collapsed: pitfalls. */
    if (content.pitfalls && content.pitfalls.length) {
      _root.appendChild(_detailsBlock('Common pitfalls', function (d) {
        var ul = _el('ul', 'pe-guide-list');
        content.pitfalls.forEach(function (p) { ul.appendChild(_el('li', null, p)); });
        d.appendChild(ul);
      }));
    }

    /* Collapsed: example. */
    if (content.example) {
      _root.appendChild(_detailsBlock('Good vs. weak example', function (d) {
        var g = _el('div', 'pe-guide-example pe-guide-example--good');
        g.appendChild(_el('span', 'pe-guide-example-tag', '✓ Stronger'));
        g.appendChild(_el('div', 'pe-guide-example-text', content.example.good));
        d.appendChild(g);
        var b = _el('div', 'pe-guide-example pe-guide-example--bad');
        b.appendChild(_el('span', 'pe-guide-example-tag', '✗ Weaker'));
        b.appendChild(_el('div', 'pe-guide-example-text', content.example.bad));
        d.appendChild(b);
        if (content.example.note) d.appendChild(_el('div', 'pe-guide-example-note', content.example.note));
      }));
    }

    /* Collapsed: constant craft tips. */
    _root.appendChild(_detailsBlock('Paragraph craft', function (d) {
      var ul = _el('ul', 'pe-guide-list');
      CRAFT_TIPS.forEach(function (t) { ul.appendChild(_el('li', null, t)); });
      d.appendChild(ul);
    }));

    /* Footer: full lesson link. */
    if (content.training) {
      var foot = _el('div', 'pe-guide-footer');
      var a = document.createElement('a');
      a.href = content.training;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'pe-guide-lesson-link';
      a.textContent = 'Full lesson →';
      foot.appendChild(a);
      _root.appendChild(foot);
    }
  }

  function _renderPaperLevel(snap) {
    _root.appendChild(_el('div', 'pe-guide-purpose', 'Click into a paragraph to get guidance for that section. Meanwhile, here is a check of the whole draft.'));
    var checks = _paperChecks(snap);
    if (checks.length) {
      var wrap = _el('div', 'pe-guide-checks');
      wrap.appendChild(_el('div', 'pe-guide-checks-title', 'Whole-draft check'));
      checks.forEach(function (c) { wrap.appendChild(_checkRow(c)); });
      _root.appendChild(wrap);
    }
    /* Per-section word counts. */
    if (snap.sections.length) {
      var list = _el('div', 'pe-guide-section-counts');
      snap.sections.forEach(function (sec) {
        var words = _sectionWords(sec);
        var max = sec.style && sec.style.maxWords;
        var row = _el('div', 'pe-guide-section-count');
        row.appendChild(_el('span', 'pe-guide-section-name', sec.label || _kindLabel(sec.kind)));
        var cnt = _el('span', 'pe-guide-section-words', max ? (words + ' / ' + max + ' w') : (words + ' w'));
        if (max && words > max) cnt.classList.add('over');
        row.appendChild(cnt);
        list.appendChild(row);
      });
      _root.appendChild(list);
    }
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.PaperWritingGuide = {
    buildTabContent: function (rootEl) {
      if (!rootEl) return;
      _root = rootEl;
      _render();
    },
    refresh: function () { if (_root) _render(); },
    getContext: function () { return _displayCtx(); },
  };
})();
