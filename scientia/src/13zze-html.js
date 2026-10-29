/* ==========================================================================
   13zze · HTML pages keep their state and take notes.
   • The page as you left it: a slider moved, a box ticked, a value typed, a
     choice picked, a section opened — kept with the component
     (block.htmlState = {media, v}) and put back every time the page is shown
     again (the note redrawn or reopened, the page maximised, the app
     started again). The card and its maximised view move together.
     ⋯ → "Back to how the page starts" forgets it.
   • Notes in the page (maximised): ✎ Note, then click where it goes — or
     select text and pick ✎ Note. The note is pinned in the page (in the card
     too) and is also a component beside it on the paper, like a quote
     (quote.note), connected to the page ("comments"). Click the pin to edit
     or remove it; edit it on the paper as any component.
   Controls a page draws itself (a plot's own zoom, sliders made of shapes
   rather than form fields) are not kept. The page stays sandboxed: a small
   script added to its copy reports and restores; it can't reach the app.
   ========================================================================== */
const HTMLX = {
  notes: srcId => QUOTE.of(srcId).filter(q => q.quote.note),
  frames: srcId => $$('iframe').filter(fr => fr._qsrc === srcId && fr.contentWindow),
  post(srcId, msg, not) { HTMLX.frames(srcId).forEach(fr => { if (fr !== not) fr.contentWindow.postMessage(msg, '*'); }); },
  state(b) { const s = b && b.htmlState; return s && s.media === b.media ? s.v || {} : {}; },
  /** Added to the page's copy after the quote reporter (13zw QUOTE.fill): the state it was left at, and the script. */
  more(srcId) { const st = JSON.stringify(HTMLX.state(srcId && M.block(srcId))).replace(/</g, '\\u003c'); return '<script>window.__sisState=' + st + ';<\/script>' + HTMLX.SCRIPT; },
  paint(srcId) { HTMLX.post(srcId, { sis: 'notes', list: HTMLX.notes(srcId).map(q => ({ id: q.id, text: q.body.text, at: q.quote.at || null, exact: q.quote.exact || null })) }); },
  /** A note at a spot of the page (or on a passage): a component beside the page, connected to it, pinned in it. */
  make(srcId, where, text) {
    const src = M.block(srcId); text = (text || '').trim(); if (!src || !text) return null;
    const rec = MEDIA.get(src.media), n = QUOTE.of(src.id).length;
    const b = M.addBlock(src.docId, null, { label: 'Note', x: Math.round(((src.x || 0) + (src.w || 616) + 56) / 14) * 14, y: Math.round(((src.y || 0) + n * 126) / 14) * 14, w: 300,
      quote: { src: src.id, kind: 'html', note: true, at: where.at || null, exact: where.exact || null, prefix: where.prefix || '', suffix: where.suffix || '', file: rec ? rec.name : '', color: null } });
    M.saveBlockBody(b, { text, marks: [] }); M.wire(b.id, src.id, 'comments', true); IX.rebuild(); changed();
    setTimeout(() => QUOTE.paintMarks(src.id), 120); return b;
  },
  /** Write (or edit) a note in a small box at the spot. */
  write(srcId, where, x, y, note) {
    const ta = h('textarea.inp', { rows: 3, placeholder: 'A note at this spot of the page…' }); if (note) ta.value = note.body.text;
    const go = () => { const v = ta.value.trim(); closePop();
      if (note) { const cur = M.block(note.id); if (!cur) return; if (!v) return QUOTE.erase([cur.id]); if (v !== cur.body.text) { M.saveBlockBody(cur, { text: v, marks: [] }); changed(); } return; }
      if (v && HTMLX.make(srcId, where, v)) toast('Note added — in the page, and beside it on the paper'); };
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === 'Escape') closePop(); });
    popover(x, y, [h('h5', note ? 'Note in the page' : 'New note in the page'), ta,
      h('div.row', { style: { gap: '6px', marginTop: '6px', alignItems: 'center' } }, h('span.tiny.muted', { style: { marginRight: 'auto' } }, 'Enter keeps it · Shift+Enter: new line'),
        note ? h('button.btn.xs', { on: { click: e => { closePop(); const ov = $('.embed-max.mx-hl'); ov && MXHL.close(ov); App.jump(note.id, e); } } }, 'On the paper ↗') : null,
        note ? h('button.btn.xs.danger', { on: { click: () => { closePop(); QUOTE.erase([note.id]); } } }, 'Remove') : null,
        h('button.btn.xs.pri', { on: { click: go } }, note ? 'Save' : 'Add'))]);
    setTimeout(() => ta.focus(), 20);
  },
  /** ✎ Note in a maximised page: the next click in it says where. */
  pick(ov, srcId) {
    const fr = $('iframe', ov); if (!fr || !fr.contentWindow) return; HTMLX._pick && HTMLX._pick.off();
    fr.contentWindow.postMessage({ sis: 'notemode', on: true }, '*'); ov.classList.add('mx-picking');
    const hint = h('div.mx-hint', 'Click where the note goes in the page · Esc cancels'); const bar = $(':scope > .em-bar', ov); bar ? bar.after(hint) : ov.prepend(hint);
    HTMLX._pick = { ov, srcId, off: () => { try { fr.contentWindow && fr.contentWindow.postMessage({ sis: 'notemode', on: false }, '*'); } catch { } ov.classList.remove('mx-picking'); hint.remove(); HTMLX._pick = null; } };
  },
  /** States are saved quietly (sliding isn't an undo step) a moment after the last move. */
  pend: new Set(),
  flush: debounce(() => { DB.quiet = true; try { HTMLX.pend.forEach(id => { const b = M.block(id); b && DB.put('blocks', b); }); } finally { DB.quiet = false; } HTMLX.pend.clear(); }, 400),

  SCRIPT: `<script>(function(){var P=window.parent,S=window.__sisState||{},cur={},busy=false,t=null,NOTES=[],pick=false,eat=false;
function ctl(){return [].slice.call(document.querySelectorAll('input,select,textarea'));}
function skip(el){var y=(el.type||'').toLowerCase();return /^(file|password|hidden|submit|button|reset|image)$/.test(y);}
function kOf(el,L){return el.id?'#'+el.id:'@'+L.indexOf(el);}
function rd(el){var y=(el.type||'').toLowerCase();if(y==='checkbox'||y==='radio')return el.checked;if(el.multiple)return [].map.call(el.selectedOptions,function(o){return o.value;});return el.value;}
function wr(el,v){var y=(el.type||'').toLowerCase();if(y==='checkbox'||y==='radio'){if(el.checked===!!v)return false;el.checked=!!v;return true;}if(el.multiple&&v&&v.map){var ch=false;[].forEach.call(el.options,function(o){var s=v.indexOf(o.value)>=0;if(o.selected!==s){o.selected=s;ch=true;}});return ch;}if(el.value===String(v))return false;el.value=v;return true;}
function dets(){return [].slice.call(document.querySelectorAll('details'));}
function apply(st){busy=true;var L=ctl(),D=dets(),left=0;try{Object.keys(st).forEach(function(k){if(k.indexOf('^d')===0){var d=D[+k.slice(2)];if(d&&d.open!==!!st[k])d.open=!!st[k];return;}var el=k.charAt(0)==='#'?document.getElementById(k.slice(1)):L[+k.slice(1)];if(!el||skip(el)){left++;return;}if(wr(el,st[k])){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}});}catch(x){}busy=false;return left;}
function send(){clearTimeout(t);t=setTimeout(function(){P.postMessage({sis:'state',state:cur},'*');},150);}
function snap(el){var L=ctl();if(L.indexOf(el)<0||skip(el))return;var y=(el.type||'').toLowerCase();if(y==='radio'&&el.name){L.forEach(function(x){if((x.type||'').toLowerCase()==='radio'&&x.name===el.name&&x.form===el.form)cur[kOf(x,L)]=x.checked;});}else cur[kOf(el,L)]=rd(el);send();}
document.addEventListener('input',function(e){if(!busy&&e.isTrusted)snap(e.target);},true);
document.addEventListener('change',function(e){if(!busy&&e.isTrusted)snap(e.target);},true);
document.addEventListener('toggle',function(e){var d=e.target;if(busy||!e.isTrusted||!d||d.tagName!=='DETAILS')return;cur['^d'+dets().indexOf(d)]=d.open;send();},true);
function kids(p){return [].filter.call(p.children,function(c){return !(c.tagName==='MARK'&&c.classList.contains('sis-q'));});}
function pathOf(el){var a=[];while(el&&el.parentElement&&el!==document.body){a.unshift(kids(el.parentElement).indexOf(el));el=el.parentElement;}return a.join('/');}
function byPath(s){var el=document.body;if(!s)return el;var a=String(s).split('/');for(var i=0;i<a.length&&el;i++)el=kids(el)[+a[i]];return el||null;}
function spot(x,y){var el=document.elementFromPoint(x,y)||document.body;if(el===document.documentElement)el=document.body;var r=el.getBoundingClientRect();return {path:pathOf(el),fx:r.width?+((x-r.left)/r.width).toFixed(4):0,fy:r.height?+((y-r.top)/r.height).toFixed(4):0,px:Math.round(x+scrollX),py:Math.round(y+scrollY)};}
function where(n){if(n.exact){var m=document.querySelector('mark.sis-q[data-q="'+n.id+'"]');if(m){var q=m.getBoundingClientRect();return {x:q.right+scrollX+4,y:q.top+scrollY+q.height/2};}}var a=n.at;if(!a)return null;var el=byPath(a.path);if(el&&el!==document.body){var R=el.getBoundingClientRect();if(R.width||R.height)return {x:R.left+scrollX+R.width*a.fx,y:R.top+scrollY+R.height*a.fy};}return {x:a.px,y:a.py};}
function draw(){[].forEach.call(document.querySelectorAll('.sis-note'),function(x){x.remove();});NOTES.forEach(function(n){var p=where(n);if(!p)return;var el=document.createElement('div');el.className='sis-note';el.setAttribute('data-q',n.id);el.style.left=Math.round(p.x)+'px';el.style.top=Math.round(p.y)+'px';var b=document.createElement('b');b.textContent='\\u270E';var s=document.createElement('span');s.textContent=n.text||'';el.appendChild(b);el.appendChild(s);
el.addEventListener('pointerdown',function(e){e.stopPropagation();},true);el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var r=el.getBoundingClientRect();P.postMessage({sis:'note',id:n.id,x:r.left,y:r.bottom},'*');});document.documentElement.appendChild(el);});}
document.addEventListener('pointerdown',function(e){if(!pick||(e.target.closest&&e.target.closest('.sis-note')))return;e.preventDefault();e.stopPropagation();pick=false;eat=true;document.documentElement.classList.remove('sis-picking');P.postMessage({sis:'spot',at:spot(e.clientX,e.clientY),x:e.clientX,y:e.clientY},'*');},true);
document.addEventListener('click',function(e){if(eat){eat=false;e.preventDefault();e.stopPropagation();}},true);
document.addEventListener('keydown',function(e){if(pick&&e.key==='Escape'){pick=false;document.documentElement.classList.remove('sis-picking');P.postMessage({sis:'pickoff'},'*');}},true);
window.addEventListener('message',function(e){var d=e.data||{};if(d.sis==='restore'){cur=d.state||{};apply(cur);}else if(d.sis==='notes'){NOTES=d.list||[];draw();}else if(d.sis==='notemode'){pick=!!d.on;document.documentElement.classList.toggle('sis-picking',pick);}else if(d.sis==='goto'){var n=document.querySelector('.sis-note[data-q="'+d.id+'"]');if(n&&!document.querySelector('mark.sis-q[data-q="'+d.id+'"]')){n.scrollIntoView({block:'center',behavior:'smooth'});n.classList.add('sis-flash');setTimeout(function(){n.classList.remove('sis-flash');},1800);}}});
window.addEventListener('resize',function(){if(NOTES.length)draw();});
var st=document.createElement('style');st.textContent='.sis-note{position:absolute;z-index:2147483000;transform:translate(-3px,-50%);display:flex;align-items:flex-start;gap:5px;max-width:240px;padding:4px 8px 4px 6px;background:#fff8c5;color:#3a3200;border:1px solid #e3cf5a;border-left:3px solid #e0b400;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.18);font:12.5px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;white-space:pre-wrap;word-break:break-word;text-align:left}.sis-note b{opacity:.7;flex:none}.sis-note span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.sis-note:hover{z-index:2147483001}.sis-note:hover span{display:block}.sis-note.sis-flash{outline:2px solid #e08a00}html.sis-picking,html.sis-picking *{cursor:crosshair!important}';(document.head||document.documentElement).appendChild(st);
function start(){cur=JSON.parse(JSON.stringify(S));if(Object.keys(cur).length&&apply(cur))setTimeout(function(){apply(cur);},800);P.postMessage({sis:'hello'},'*');if(window.ResizeObserver&&document.body)new ResizeObserver(function(){if(NOTES.length)draw();}).observe(document.body);}
if(document.readyState==='complete')setTimeout(start,0);else window.addEventListener('load',function(){setTimeout(start,0);});})();<\/script>`,
};
QUOTE.more = HTMLX.more;
{
  window.addEventListener('message', e => { const d = e.data; if (!d || !d.sis) return;
    const fr = [...document.querySelectorAll('iframe')].find(f => f.contentWindow === e.source); if (!fr || !fr._qsrc) return; const src = fr._qsrc, b = M.block(src); if (!b) return;
    const at = (x, y) => { const r = fr.getBoundingClientRect(), k = r.width / (fr.clientWidth || r.width || 1); return { x: r.left + x * k, y: r.top + y * k }; };
    if (d.sis === 'state') { b.htmlState = { media: b.media, v: d.state || {} }; HTMLX.pend.add(b.id); HTMLX.flush(); HTMLX.post(src, { sis: 'restore', state: b.htmlState.v }, fr); }
    else if (d.sis === 'hello') { fr.contentWindow.postMessage({ sis: 'restore', state: HTMLX.state(b) }, '*'); QUOTE.paintMarks(src); }   // a page reloaded (⟳) gets what it was left at since
    else if (d.sis === 'spot') { HTMLX._pick && HTMLX._pick.off(); const p = at(d.x, d.y); HTMLX.write(src, { at: d.at }, p.x, p.y + 10); }
    else if (d.sis === 'pickoff') HTMLX._pick && HTMLX._pick.off();
    else if (d.sis === 'note') { const q = M.block(d.id); if (q && q.quote && q.quote.note) { const p = at(d.x, d.y); HTMLX.write(src, null, p.x, p.y + 6, q); } } });
  // Esc while choosing the spot cancels that, not the maximised view
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && HTMLX._pick) { e.stopImmediatePropagation(); e.preventDefault(); HTMLX._pick.off(); } }, true);
  // the pins follow the quotes: drawn whenever the highlights are
  const pm = QUOTE.paintMarks; QUOTE.paintMarks = function (srcId) { const r = pm.call(QUOTE, srcId); const s = M.block(srcId); if (s && s.kind === 'html') HTMLX.paint(srcId); return r; };
  // ✎ Note in the maximised page's bar
  const em = EMBED.max; EMBED.max = function (b) { const r = em.call(EMBED, b), ov = [...$$('.embed-max')].pop(), bar = ov && $(':scope > .em-bar', ov);
    if (bar) { const btn = h('button.btn.sm', { title: 'Write a note in the page: click where it goes (or select text, then ✎ Note)', on: { click: () => HTMLX._pick ? HTMLX._pick.off() : HTMLX.pick(ov, b.id) } }, '✎ Note'), a = $('a.btn', bar); a ? a.before(btn) : bar.append(btn); }
    return r; };
  // ✎ Note on a selected passage
  const qm = QUOTE.menu; QUOTE.menu = function (sel, x, y) { const r = qm.call(QUOTE, sel, x, y), src = M.block(sel.src);
    if (src && src.kind === 'html' && sel.frame) { const pop = $('.pop.q-menu') || [...$$('.pop')].pop(), row = pop && $('.q-cols', pop);
      if (row) row.append(h('button.btn.xs', { title: 'A note on this passage, pinned in the page', on: { click: () => { closePop(); const w = { exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix }; QUOTE.clearSel(sel); HTMLX.write(sel.src, w, x, y); } } }, '✎ Note')); }
    return r; };
  // a note component says where it is pinned
  const bx = DocView.box; DocView.box = function (b) { const el = bx.apply(this, arguments);
    if (el && b && b.quote && b.quote.note) { el.classList.remove('q-box'); el.classList.add('hn-box'); const f = $(':scope > .q-from', el); if (f) f.replaceChildren('✎ pinned in ', h('b', b.quote.file || 'the page'), ' — show it'); }
    return el; };
  // ⋯ on the page: forget what it was left at
  const wm = WIDGETS.html.menu; WIDGETS.html.menu = b => [...wm(b), Object.keys(HTMLX.state(b)).length ? { label: 'Back to how the page starts', sub: 'Forgets the values you left it at', run: () => { delete b.htmlState; DB.put('blocks', b); changed(); } } : null];
}
