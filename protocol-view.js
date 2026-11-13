/* protocol-view.js — V3.986: draws a posted protocol inside the public
 * site's protocol page.
 *
 * Runs in protocol-view.html, which the site's #/protocols/{id} page
 * (app.js, wireProtocolView) puts in a frame. The site loads the protocol
 * (publicProtocols/{id} + its content doc — the snapshot "Post to website"
 * wrote from RM's protocol editor) and calls
 *
 *     ProtocolView.render(card, tree)   → Promise
 *
 * The document is assembled by the same code as the lab's document view
 * (ProtocolDocRender.renderDocument + ProtocolWidgets), so calculators,
 * builders and plate maps are live for a visitor too: inputs recompute in
 * the page and nothing is saved. Lab inventory links were turned into item
 * names when the protocol was posted, so nothing here asks for lab data —
 * this file has no database and no sign-in at all.
 *
 * It also keeps the frame exactly as tall as the document, so the site's
 * page does the scrolling, and sends Ctrl/Cmd+P to the document's own
 * print (the browser would otherwise print the site around a clipped
 * frame).
 */
(function () {
  var SITE = 'https://mcgheelab.com';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function niceDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function sitePath(id) { return '/#/protocols/' + encodeURIComponent(id); }
  function shareUrl(id) { return SITE + sitePath(id); }

  function namesList(people) {
    var names = (people || []).map(function (p) { return p && p.name; }).filter(Boolean);
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function renderAbout(card) {
    var el = $('pv-about');
    var people = Array.isArray(card.contributors) ? card.contributors : [];
    var posted = niceDate(card.published_at);
    var updated = niceDate(card.updated_at);
    var facts = [];
    if (posted) facts.push('Posted ' + posted);
    if (updated && updated !== posted) facts.push('updated ' + updated);
    if (card.version > 0) facts.push('version ' + card.version);
    el.innerHTML =
      '<h2>About this protocol</h2>' +
      '<p>' + (people.length
        ? 'Made by ' + esc(namesList(people)) + ' of the <a href="/#/team">McGhee Lab</a>, University of Arizona.'
        : 'From the <a href="/#/team">McGhee Lab</a>, University of Arizona.') + '</p>' +
      (facts.length ? '<p>' + esc(facts.join(' · ')) + '.</p>' : '') +
      '<p class="pv-link">Link to this protocol: <a href="' + esc(sitePath(card.id)) + '">' +
        esc(shareUrl(card.id)) + '</a></p>';
    el.hidden = false;
  }

  /* The frame is as tall as the document. body is a flow-root, so its
   * height includes the sheet's margins. */
  function fit() {
    var frame = window.frameElement;
    if (frame) frame.style.height = Math.ceil(document.body.getBoundingClientRect().height) + 'px';
  }

  /* `card` = publicProtocols/{id}; `tree` = the tree from its content doc. */
  async function render(card, tree) {
    var PW = window.ProtocolWidgets;
    var PF = window.ProtocolFormulas;
    var docEl = $('pv-doc');
    card = card || {};
    tree = window.ProtocolSchemas.normalizeTree(tree || { meta: {}, sections: [] });

    var formulas = PF.collectFormulasFromPlainTree(tree);
    var needsMath = formulas.length > 0 ||
      (tree.sections || []).some(function (sec) {
        return (sec.children || []).some(function (b) {
          return b && (b.kind === 'builder' || b.kind === 'layoutMap' || b.kind === 'design');
        });
      });
    var math = null;
    if (needsMath) {
      try { math = await PF.ensureMathjs(); }
      catch (err) { console.warn('[protocol-view] mathjs load failed:', err && err.message); }
    }

    var ctx = PW.createContext({ container: docEl, math: math, formulas: formulas, overrides: {} });
    if (math) ctx.table = PF.buildSymbolTable(formulas, math, ctx.overrides);

    var updated = niceDate(card.updated_at || card.published_at);
    window.ProtocolDocRender.renderDocument(docEl, {
      doc: { title: card.title || '' },
      tree: tree,
      brand: null,
      ctx: ctx,
      metaBits: [
        card.byline || 'McGhee Lab',
        updated ? 'Updated ' + updated : '',
        card.version > 0 ? 'v' + card.version : '',
      ],
      footerText: '“' + (card.title || card.id || 'Protocol') + '” · McGhee Lab, University of Arizona · ' +
        shareUrl(card.id || '').replace(/^https:\/\//, ''),
    });
    PW.mountRefresherBus(ctx);

    docEl.hidden = false;
    renderAbout(card);
    // The browser names a saved PDF after the document's title.
    document.title = (card.title ? card.title + ' — ' : '') + 'McGhee Lab protocol';
    fit();
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(fit).observe(document.body);
  } else {
    window.addEventListener('load', fit);
    setInterval(fit, 1000);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'p') {
      e.preventDefault();
      window.print();
    }
  });

  window.ProtocolView = { render: render };
})();
