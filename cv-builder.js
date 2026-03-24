/* ================================================================
   CV BUILDER — V3.2
   Full-featured academic CV manager for McGheeLab.
   Ported from McGheeLab/CV React app to vanilla JS with Firestore.
   ================================================================ */
(function () {
'use strict';

const McgheeLab = window.McgheeLab || {};

/* ── PDF.js Loader ──────────────────────────────────────────────── */
const pdfJsScript = document.createElement('script');
pdfJsScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
document.head.appendChild(pdfJsScript);
pdfJsScript.onload = function () {
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
};

/* ── Theme Colors (matches McGheeLab site tokens) ──────────────── */
const T = {
  bg:'#0b0d12', surface:'#121620', surfaceHover:'#1a2030',
  border:'rgba(255,255,255,.08)', borderLight:'rgba(255,255,255,.12)',
  accent:'#5baed1', text:'#eef2f7', muted:'#a8b3c7', mutedLight:'#a8b3c7',
  red:'#fca5a5', green:'#86efac', blue:'#7cc4ff', purple:'#c4b5fd',
  // Aliases for backward-compat in inline styles
  gold:'#5baed1', cream:'#eef2f7',
};

/* ── Section Metadata ──────────────────────────────────────────── */
const SM = {
  dashboard:     {label:'Dashboard',         icon:'\u25C8', color:T.accent},
  analytics:     {label:'Analytics',         icon:'\u25B2', color:'#7cc4ff'},
  profile:       {label:'Profile',           icon:'\u25C9', color:T.text},
  journals:      {label:'Journal Papers',    icon:'\u25A4', color:'#5baed1'},
  conferences:   {label:'Conference Papers', icon:'\u25A5', color:'#7cc4ff'},
  books:         {label:'Books & Chapters',  icon:'\u25A6', color:'#c4b5fd'},
  patents:       {label:'Patents',           icon:'\u2B21', color:'#fca5a5'},
  grants:        {label:'Grants & Funding',  icon:'\u25CE', color:'#86efac'},
  software:      {label:'Software & Data',   icon:'\u2B21', color:'#86efac'},
  presentations: {label:'Presentations',     icon:'\u25B7', color:'#7cc4ff'},
  awards:        {label:'Awards & Honors',   icon:'\u2726', color:'#fbbf24'},
  service:       {label:'Service & Editing', icon:'\u25E7', color:'#c4b5fd'},
  students:      {label:'Students',          icon:'\u25D1', color:'#fbbf24'},
  courses:       {label:'Courses Taught',    icon:'\u25EB', color:'#7cc4ff'},
  import_:       {label:'Import',            icon:'\u21D3', color:'#86efac'},
  ai:            {label:'AI Assistant',      icon:'\u2726', color:'#c4b5fd'},
  versions:      {label:'CV Versions',       icon:'\u25FB', color:T.text},
  export_:       {label:'Export & Share',    icon:'\u2197', color:'#5baed1'},
  citations:     {label:'Citation Tracker',  icon:'\u2726', color:'#7cc4ff'},
  orcid:         {label:'ORCID Sync',        icon:'\u2295', color:'#86efac'},
  settings:      {label:'Settings',          icon:'\u2699', color:T.muted},
};

const NAV_GROUPS = [
  {label:'Overview',     keys:['dashboard','analytics','profile']},
  {label:'Publications', keys:['journals','conferences','books']},
  {label:'Research',     keys:['patents','grants','software']},
  {label:'Activities',   keys:['presentations','awards','service']},
  {label:'Teaching',     keys:['students','courses']},
  {label:'Tools',        keys:['import_','ai','versions','export_','citations','orcid','settings']},
];

const SECTION_LABELS = {
  journals:'Journal Publications', conferences:'Conference Papers', books:'Books & Book Chapters',
  patents:'Patents', presentations:'Presentations & Invited Talks', grants:'Grants & Funding',
  students:'Students Supervised', awards:'Awards & Honors', service:'Service & Editorial',
  courses:'Courses Taught', software:'Software & Datasets',
};

/* ── Schemas ───────────────────────────────────────────────────── */
const SCHEMAS = {
  journals:      {doiField:true, fields:[{key:'doi',label:'DOI',type:'doi',span:2},{key:'title',label:'Title',type:'text',span:2,required:true},{key:'authors',label:'Authors',type:'text',span:2,required:true,hint:'Smith J, Doe A, ...'},{key:'journal',label:'Journal',type:'text',required:true},{key:'year',label:'Year',type:'number',required:true},{key:'volume',label:'Volume',type:'text'},{key:'issue',label:'Issue',type:'text'},{key:'pages',label:'Pages',type:'text'},{key:'impact_factor',label:'Impact Factor',type:'number'},{key:'quartile',label:'Quartile',type:'select',options:['','Q1','Q2','Q3','Q4']},{key:'citations',label:'Citations',type:'number'},{key:'status',label:'Status',type:'select',options:['Published','In Press','Under Review','Submitted','In Preparation']},{key:'abstract',label:'Abstract',type:'textarea',span:2},{key:'keywords',label:'Keywords',type:'text',span:2,hint:'comma separated'}]},
  conferences:   {doiField:true, fields:[{key:'doi',label:'DOI',type:'doi',span:2},{key:'title',label:'Title',type:'text',span:2,required:true},{key:'authors',label:'Authors',type:'text',span:2,required:true},{key:'conference',label:'Conference',type:'text',required:true},{key:'location',label:'Location',type:'text'},{key:'year',label:'Year',type:'number',required:true},{key:'pages',label:'Pages',type:'text'},{key:'type',label:'Type',type:'select',options:['Oral','Poster','Invited Talk','Keynote','Workshop']},{key:'status',label:'Status',type:'select',options:['Published','Accepted','Submitted']},{key:'abstract',label:'Abstract',type:'textarea',span:2}]},
  books:         {fields:[{key:'title',label:'Title',type:'text',span:2,required:true},{key:'authors',label:'Authors',type:'text',span:2},{key:'editors',label:'Editors',type:'text',span:2},{key:'role',label:'My Role',type:'select',options:['Author','Co-Author','Editor','Co-Editor','Chapter Author']},{key:'chapter',label:'Chapter Title',type:'text',span:2},{key:'publisher',label:'Publisher',type:'text',required:true},{key:'year',label:'Year',type:'number',required:true},{key:'edition',label:'Edition',type:'text'},{key:'isbn',label:'ISBN',type:'text'},{key:'pages',label:'Pages',type:'text'},{key:'doi',label:'DOI',type:'text'}]},
  patents:       {fields:[{key:'number',label:'Patent Number',type:'text',required:true},{key:'title',label:'Title',type:'text',span:2,required:true},{key:'inventors',label:'Inventors',type:'text',span:2,required:true},{key:'assignee',label:'Assignee',type:'text'},{key:'filing_date',label:'Filing Date',type:'date'},{key:'grant_date',label:'Grant Date',type:'date'},{key:'country',label:'Country',type:'text'},{key:'status',label:'Status',type:'select',options:['Granted','Pending','Published','Abandoned']},{key:'description',label:'Description',type:'textarea',span:2}]},
  presentations: {fields:[{key:'title',label:'Title',type:'text',span:2,required:true},{key:'event',label:'Event/Venue',type:'text',required:true},{key:'location',label:'Location',type:'text'},{key:'date',label:'Date',type:'date',required:true},{key:'type',label:'Type',type:'select',options:['Invited Talk','Keynote','Contributed Talk','Seminar','Webinar','Panel','Workshop']},{key:'audience',label:'Audience',type:'select',options:['International','National','Regional','Local','Institutional']},{key:'slides_url',label:'Slides URL',type:'text',span:2},{key:'notes',label:'Notes',type:'textarea',span:2}]},
  grants:        {fields:[{key:'title',label:'Grant Title',type:'text',span:2,required:true},{key:'agency',label:'Agency',type:'text',required:true},{key:'role',label:'My Role',type:'select',options:['PI','Co-PI','Co-I','Collaborator','Consultant']},{key:'amount',label:'Amount (USD)',type:'number'},{key:'start_date',label:'Start Date',type:'date'},{key:'end_date',label:'End Date',type:'date'},{key:'status',label:'Status',type:'select',options:['Active','Completed','Pending','Submitted','Not Funded']},{key:'grant_id',label:'Grant ID',type:'text'},{key:'description',label:'Description',type:'textarea',span:2}]},
  students:      {fields:[{key:'name',label:'Student Name',type:'text',required:true},{key:'degree',label:'Degree',type:'select',options:['BSc','MSc','PhD','PostDoc','Visiting Researcher']},{key:'thesis_title',label:'Thesis/Project',type:'text',span:2},{key:'start_year',label:'Start Year',type:'number',required:true},{key:'end_year',label:'End Year',type:'number'},{key:'status',label:'Status',type:'select',options:['Current','Graduated','Withdrawn']},{key:'current_position',label:'Current Position',type:'text',span:2},{key:'co_supervisor',label:'Co-Supervisor',type:'text'},{key:'notes',label:'Notes',type:'textarea',span:2}]},
  awards:        {fields:[{key:'title',label:'Award Title',type:'text',span:2,required:true},{key:'awarding_body',label:'Awarding Body',type:'text',required:true},{key:'year',label:'Year',type:'number',required:true},{key:'category',label:'Category',type:'select',options:['Research','Teaching','Service','Fellowship','Prize','Recognition','Other']},{key:'description',label:'Description',type:'textarea',span:2}]},
  service:       {fields:[{key:'role',label:'Role',type:'text',required:true},{key:'organization',label:'Organization',type:'text',required:true},{key:'type',label:'Type',type:'select',options:['Journal Editor','Associate Editor','Reviewer','Editorial Board','Committee','Program Chair','Organizing Committee','Advisory Board','Department','University','Professional Society','Other']},{key:'start_year',label:'Start Year',type:'number'},{key:'end_year',label:'End Year',type:'number'},{key:'ongoing',label:'Ongoing',type:'checkbox'},{key:'description',label:'Notes',type:'textarea',span:2}]},
  courses:       {fields:[{key:'name',label:'Course Name',type:'text',required:true},{key:'code',label:'Code',type:'text'},{key:'level',label:'Level',type:'select',options:['Undergraduate','Postgraduate','PhD','Executive']},{key:'role',label:'Role',type:'select',options:['Instructor','Co-Instructor','Guest Lecturer','Teaching Assistant']},{key:'semester',label:'Semester',type:'select',options:['Fall','Spring','Summer','Full Year']},{key:'year',label:'Year',type:'number'},{key:'enrollment',label:'Enrollment',type:'number'},{key:'institution',label:'Institution',type:'text'},{key:'description',label:'Description',type:'textarea',span:2}]},
  software:      {fields:[{key:'name',label:'Name',type:'text',required:true},{key:'description',label:'Description',type:'text',span:2},{key:'type',label:'Type',type:'select',options:['Software','Dataset','Algorithm','Library','Tool','Other']},{key:'url',label:'URL / Repo',type:'text',span:2},{key:'doi',label:'DOI',type:'text'},{key:'language',label:'Language',type:'text'},{key:'license',label:'License',type:'text'},{key:'year',label:'Year',type:'number'}]},
};

/* ── Default Data ──────────────────────────────────────────────── */
function mkDefault() {
  return {
    profile:{name:'',title:'',institution:'',department:'',email:'',phone:'',website:'',orcid:'',scholar:'',address:'',bio:''},
    journals:[],conferences:[],books:[],patents:[],presentations:[],grants:[],
    students:[],awards:[],service:[],courses:[],software:[],cv_versions:[],
    citation_meta:{lastRun:null,log:[],autoInterval:'off'},
  };
}

/* ── Utilities ─────────────────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9);
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* ── CrossRef DOI Fetch ────────────────────────────────────────── */
async function fetchDOI(doi) {
  const clean = doi.replace(/^https?:\/\/doi\.org\//i, '').trim();
  const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(clean));
  if (!res.ok) throw new Error('Not found');
  const { message: w } = await res.json();
  const authors = (w.author || []).map(a =>
    (a.family || '') + ' ' + ((a.given || '').split(' ').map(n => (n[0] || '')).join(''))
  ).join(', ').trim();
  return {
    title: ((w.title || [''])[0] || '').replace(/<[^>]+>/g, ''), authors, doi: clean,
    journal: (w['container-title'] || [''])[0],
    year: w.issued?.['date-parts']?.[0]?.[0] || '',
    volume: w.volume || '', issue: w.issue || '', pages: w.page || '',
    abstract: (w.abstract || '').replace(/<[^>]+>/g, ''),
    citations: w['is-referenced-by-count'] || 0,
  };
}

async function fetchCitationCount(doi) {
  const clean = doi.replace(/^https?:\/\/doi\.org\//i, '').trim();
  const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(clean));
  if (!res.ok) return null;
  const { message: w } = await res.json();
  return w['is-referenced-by-count'] ?? null;
}

/* ── BibTeX Parser ─────────────────────────────────────────────── */
function cleanLatex(s) {
  if (!s) return '';
  return s.replace(/\\textbf\{([^}]*)\}/g,'$1').replace(/\\textit\{([^}]*)\}/g,'$1')
    .replace(/\\emph\{([^}]*)\}/g,'$1').replace(/\\textsc\{([^}]*)\}/g,'$1')
    .replace(/\\textrm\{([^}]*)\}/g,'$1').replace(/\\href\{[^}]*\}\{([^}]*)\}/g,'$1')
    .replace(/\\url\{([^}]*)\}/g,'$1').replace(/\\newline/g,'').replace(/[{}]/g,'')
    .replace(/\\\\/g,'').replace(/\\&/g,'&').replace(/~+/g,' ').replace(/\s+/g,' ')
    .replace(/^["'\s]+|["'\s]+$/g,'').trim();
}

function parseBibtex(raw) {
  const entries = [];
  // Reverse lookup: section label → section key
  const labelToSec = {};
  for (const [k, label] of Object.entries(SECTION_LABELS)) labelToSec[label.toLowerCase()] = k;
  // Common aliases
  ['journals','conferences','patents','presentations','grants','students','awards','service','courses','software','books'].forEach(k => { labelToSec[k] = k; });
  labelToSec['teaching'] = 'courses'; labelToSec['books & chapters'] = 'books';

  // Entry type → section
  const TYPE_SEC = {
    article:'journals', inproceedings:'conferences', conference:'conferences',
    book:'books', incollection:'books', patent:'patents', presentation:'presentations',
    grant:'grants', student:'students', award:'awards', service:'service', course:'courses',
  };

  // Track section context from comment headers (% ── Section Name ──)
  let commentSec = null;
  const secMarkers = [];
  let charPos = 0;
  for (const line of raw.split('\n')) {
    const cm = line.match(/^%\s*[─—━═\-]{2,}\s*(.+?)\s*[─—━═\-]{2,}/);
    if (cm) { const lbl = cm[1].trim().toLowerCase(); if (labelToSec[lbl]) commentSec = labelToSec[lbl]; }
    secMarkers.push({ pos: charPos, section: commentSec });
    charPos += line.length + 1;
  }
  function secAt(p) { let s = null; for (const mk of secMarkers) { if (mk.pos <= p && mk.section) s = mk.section; } return s; }

  const re = /@(\w+)\s*\{([^,]+),([^@]*)\}/gs; let m;
  while ((m = re.exec(raw)) !== null) {
    const [, type,, body] = m; const f = {};
    const fr = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)")/g; let fm;
    while ((fm = fr.exec(body)) !== null)
      f[fm[1].toLowerCase()] = cleanLatex(fm[2] || fm[3] || '');
    const t = type.toLowerCase();
    const authors = cleanLatex((f.author || '').replace(/\s+and\s+/gi, ', '));
    const title = cleanLatex(f.title || '');
    const year = f.year || '';
    const doi = f.doi || '';
    const sec = TYPE_SEC[t] || secAt(m.index) || 'journals';
    const base = { _id: uid(), title, year, doi };

    if (sec === 'patents') {
      entries.push({ section:sec, ...base, inventors: authors, number: f.number||'', status: cleanLatex(f.note||f.status||'Granted') });
    } else if (sec === 'presentations') {
      entries.push({ section:sec, ...base, event: f.event||f.booktitle||'', location: f.address||'', date: year.match(/^\d{4}-/) ? year : (year ? year+'-01-01' : ''), type: f.type||'Invited Talk' });
    } else if (sec === 'grants') {
      entries.push({ section:sec, ...base, agency: f.agency||'', role: f.role||'PI', amount: f.amount||'', start_date: year, end_date: f.endyear||'', status: f.status||'' });
    } else if (sec === 'students') {
      entries.push({ section:sec, _id: uid(), name: f.name||'', degree: f.degree||'', thesis_title: title, start_year: year, end_year: f.endyear||'', status: 'Current', current_position: f.position||'' });
    } else if (sec === 'awards') {
      entries.push({ section:sec, ...base, awarding_body: f.organization||'', category: f.category||'' });
    } else if (sec === 'service') {
      entries.push({ section:sec, _id: uid(), role: f.role||'', organization: f.organization||'', type: f.type||'', start_year: year, end_year: f.endyear||'' });
    } else if (sec === 'courses') {
      entries.push({ section:sec, _id: uid(), name: f.name||title, code: f.code||'', role: f.role||'', semester: f.semester||'', year, institution: f.institution||'' });
    } else if (sec === 'conferences') {
      entries.push({ section:sec, ...base, authors, conference: f.booktitle||f.conference||'', location: f.address||'', pages: f.pages||'', status: 'Published' });
    } else if (sec === 'books') {
      entries.push({ section:sec, ...base, authors, publisher: f.publisher||'', isbn: f.isbn||'', chapter: f.chapter||'', editors: f.editor||'', role: t === 'incollection' ? 'Chapter Author' : 'Author' });
    } else {
      entries.push({ section:sec, ...base, authors, journal: f.journal||'', volume: f.volume||'', issue: f.number||'', pages: f.pages||'', status: 'Published', abstract: f.abstract||'' });
    }
  }
  return entries;
}

const BIB_FILE_MAPPINGS = [
  { pattern: /patent/i, section:'patents', tag:null },
  { pattern: /invited|inviet|seminar|talk/i, section:'presentations', tag:'Invited Talk' },
  { pattern: /conference.*first|conf.*first|conference.*speaker/i, section:'conferences', tag:'Speaker' },
  { pattern: /conference.*contrib/i, section:'conferences', tag:'Contributing' },
  { pattern: /conference/i, section:'conferences', tag:null },
  { pattern: /journal.*first|journal_first/i, section:'journals', tag:'First Author' },
  { pattern: /journal.*contrib|journal_contri/i, section:'journals', tag:'Contributing Author' },
  { pattern: /journal.*review|inreview/i, section:'journals', tag:'In Review' },
  { pattern: /journal/i, section:'journals', tag:null },
  { pattern: /book/i, section:'books', tag:null },
];

function detectSectionFromFilename(filename) {
  const name = (filename || '').replace(/\.bib$/i, '');
  for (let i = 0; i < BIB_FILE_MAPPINGS.length; i++) {
    if (BIB_FILE_MAPPINGS[i].pattern.test(name))
      return { section: BIB_FILE_MAPPINGS[i].section, tag: BIB_FILE_MAPPINGS[i].tag };
  }
  return { section:'journals', tag:null };
}

function parseBibtexWithContext(raw, sectionOverride, tag) {
  const entries = [];
  // Custom entry types override sectionOverride from filename
  const CUSTOM_TYPES = { patent:'patents', presentation:'presentations', grant:'grants', student:'students', award:'awards', service:'service', course:'courses' };
  const re = /@(\w+)\s*\{([^,]+),([^@]*)\}/gs; let m;
  while ((m = re.exec(raw)) !== null) {
    const t = m[1].toLowerCase();
    const body = m[3]; const f = {};
    const fr = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)")/g; let fm;
    while ((fm = fr.exec(body)) !== null)
      f[fm[1].toLowerCase()] = cleanLatex(fm[2] || fm[3] || '');
    const authors = cleanLatex((f.author || '').replace(/\s+and\s+/gi, ', '));
    const title = cleanLatex(f.title || '');
    const year = f.year || '';
    const doi = f.doi || '';
    const sec = CUSTOM_TYPES[t] || sectionOverride || 'journals';
    const entry = { _id: uid(), section: sec, title, authors, year, doi };
    if (sec === 'journals') { entry.journal = cleanLatex(f.journal||''); entry.volume = f.volume||''; entry.issue = f.number||''; entry.pages = cleanLatex(f.pages||''); entry.status = (tag === 'In Review') ? 'Under Review' : 'Published'; }
    else if (sec === 'conferences') { entry.conference = cleanLatex(f.journal||f.booktitle||''); entry.location = cleanLatex(f.publisher||f.address||''); entry.type = tag === 'Speaker' ? 'Oral' : tag === 'Contributing' ? 'Oral' : ''; entry.status = 'Published'; }
    else if (sec === 'presentations') { entry.event = cleanLatex(f.event||f.journal||f.booktitle||''); entry.location = cleanLatex(f.address||f.publisher||''); entry.type = f.type || tag || 'Invited Talk'; entry.date = year.match(/^\d{4}-/) ? year : (year ? year+'-01-01' : ''); }
    else if (sec === 'patents') { entry.number = f.number || cleanLatex(f.journal||''); entry.inventors = authors; entry.status = cleanLatex(f.note||f.status||'Granted'); delete entry.authors; }
    else if (sec === 'books') { entry.publisher = cleanLatex(f.publisher||''); entry.isbn = f.isbn||''; entry.role = 'Author'; }
    else if (sec === 'grants') { entry.agency = cleanLatex(f.agency||''); entry.role = f.role||'PI'; entry.amount = f.amount||''; entry.start_date = year; entry.end_date = f.endyear||''; entry.status = f.status||''; }
    else if (sec === 'students') { entry.name = f.name||''; entry.degree = f.degree||''; entry.thesis_title = title; entry.start_year = year; entry.end_year = f.endyear||''; entry.status = 'Current'; entry.current_position = f.position||''; }
    else if (sec === 'awards') { entry.awarding_body = f.organization||''; entry.category = f.category||''; }
    else if (sec === 'service') { entry.role = f.role||''; entry.organization = f.organization||''; entry.type = f.type||''; entry.start_year = year; entry.end_year = f.endyear||''; }
    else if (sec === 'courses') { entry.name = f.name||title; entry.code = f.code||''; entry.role = f.role||''; entry.semester = f.semester||''; entry.institution = f.institution||''; }
    if (tag && tag !== 'In Review') entry._importTag = tag;
    entries.push(entry);
  }
  return entries;
}

/* ── Duplicate Detection ───────────────────────────────────────── */
function normalizeStr(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim(); }

function findDuplicates(entry, existingData) {
  const dupes = [];
  const nTitle = normalizeStr(entry.title || entry.name || entry.role || '');
  if (!nTitle || nTitle.length < 4) return dupes;
  const sections = Object.keys(SECTION_LABELS);
  for (const secKey of sections) {
    const list = existingData[secKey] || [];
    for (const existing of list) {
      const eTitle = normalizeStr(existing.title || existing.name || existing.role || '');
      if (!eTitle || eTitle.length < 4) continue;
      if (nTitle === eTitle || (nTitle.length > 10 && eTitle.length > 10 && (nTitle.indexOf(eTitle) >= 0 || eTitle.indexOf(nTitle) >= 0)))
        dupes.push({ section: secKey, entry: existing, matchType: 'title' });
      else if (entry.doi && existing.doi && normalizeStr(entry.doi) === normalizeStr(existing.doi))
        dupes.push({ section: secKey, entry: existing, matchType: 'doi' });
    }
  }
  return dupes;
}

/* ── NSF Document Parsers ──────────────────────────────────────── */
function parseCP(text) {
  const grants = []; const profile = { name:'', title:'', institution:'' };
  let m = text.match(/\*?NAME:\s*([^\n]+)/i); if (m) profile.name = m[1].trim();
  m = text.match(/\*?POSITION\s*TITLE:\s*([^\n]+)/i); if (m) profile.title = m[1].trim();
  m = text.match(/\*?ORGANIZATION\s*AND\s*LOCATION:\s*([^\n]+)/i); if (m) profile.institution = m[1].trim().split(',')[0].trim();
  m = text.match(/orcid\.org\/([0-9\-]+)/i); if (m) profile.orcid = m[1];
  const blocks = text.split(/\*?Proposal\/Active\s*Project\s*Title:/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]; const grant = { _id: uid(), section:'grants' };
    const titleLines = []; const bLines = block.split('\n');
    for (const line of bLines) {
      const l = line.trim(); if (!l) continue;
      if (l.match(/^\*?(Status|Source|Primary|Proposal|Total|Person|Overall|Statement|Year)/i)) break;
      titleLines.push(l);
    }
    grant.title = titleLines.join(' ').trim();
    let sm = block.match(/\*?Status\s*of\s*Support:\s*([^\n]+)/i);
    grant.status = sm ? (sm[1].trim().toLowerCase() === 'current' ? 'Active' : sm[1].trim()) : '';
    sm = block.match(/\*?Source\s*of\s*Support:\s*([^\n]+)/i); grant.agency = sm ? sm[1].trim() : '';
    sm = block.match(/Start\s*Date:.*?(\d{1,2})\/(\d{4})/i); if (sm) grant.start_date = sm[2]+'-'+sm[1].padStart(2,'0')+'-01';
    sm = block.match(/End\s*Date:.*?(\d{1,2})\/(\d{4})/i); if (sm) grant.end_date = sm[2]+'-'+sm[1].padStart(2,'0')+'-01';
    sm = block.match(/Total\s*Anticipated.*?Amount:\s*\$?([\d,]+)/i); grant.amount = sm ? sm[1].replace(/,/g,'') : '';
    grant.role = 'PI';
    if (grant.title) grants.push(grant);
  }
  return { profile: profile.name ? profile : null, grants };
}

function parseBiosketch(text) {
  const journals = []; const profile = { name:'', title:'', institution:'', orcid:'' };
  let m = text.match(/\*?NAME:\s*([^\n]+)/i); if (m) profile.name = m[1].trim();
  m = text.match(/\*?POSITION\s*TITLE:\s*([^\n]+)/i); if (m) profile.title = m[1].trim();
  m = text.match(/PRIMARY\s*ORGANIZATION.*?:\s*([^\n]+)/i); if (m) profile.institution = m[1].trim().split(',')[0].trim();
  m = text.match(/orcid\.org\/([0-9\-]+)/i); if (m) profile.orcid = m[1];
  const prodSection = text.match(/Products([\s\S]*?)(?:Synergistic|Certification|$)/i);
  if (prodSection) {
    const entries = prodSection[1].split(/\n\s*(\d+)\.\s+/);
    for (let i = 1; i < entries.length; i += 2) {
      const entry = (entries[i+1]||'').trim();
      if (!entry || entry.length < 10) continue;
      const pub = { _id: uid(), section:'journals', status:'Published', title:'', authors:'', journal:'', year:'', doi:'' };
      let dm = entry.match(/DOI:\s*(10\.[^\s]+)/i); if (dm) pub.doi = dm[1].replace(/[\s,;]+$/,'');
      dm = entry.match(/\b(19|20)\d{2}\b/); if (dm) pub.year = dm[0];
      const clean = entry.replace(/DOI:.*$/i,'').replace(/Available\s+from:.*$/i,'').trim();
      const parts = clean.split(/\.\s+/);
      if (parts.length >= 2) {
        if (parts[0].match(/[A-Z]\./)) { pub.authors = parts[0].trim(); pub.title = parts.slice(1,-1).join('. ').trim(); }
        else pub.title = parts[0].trim();
      } else pub.title = clean.substring(0,200).trim();
      pub.title = (pub.title||'').replace(/\.\s*$/,'').replace(/\d+\(\d+\):.*$/,'').trim();
      if (pub.title && pub.title.length > 5) journals.push(pub);
    }
  }
  return { profile: profile.name ? profile : null, journals };
}

function parseDocumentText(text, docType) {
  if (!text || text.trim().length < 30) return { profile:null, entries:[] };
  let parsed;
  if (docType === 'cp' || ((!docType || docType === 'auto') && text.match(/Current\s*and\s*Pending|Proposal\/Active\s*Project/i)))
    parsed = parseCP(text);
  else if (docType === 'biosketch' || ((!docType || docType === 'auto') && text.match(/Biographical\s*Sketch|Professional\s*Preparation/i)))
    parsed = parseBiosketch(text);
  else parsed = { profile: null };
  const entries = [];
  for (const sec of Object.keys(SECTION_LABELS)) {
    if (parsed[sec] && Array.isArray(parsed[sec])) {
      for (const e of parsed[sec]) {
        if (!e.section) e.section = sec;
        if (!e._id) e._id = uid();
        entries.push(e);
      }
    }
  }
  return { profile: parsed.profile || null, entries };
}

/* ── LaTeX Generators ──────────────────────────────────────────── */
function escTex(s) {
  return String(s||'').replace(/\\/g,'\\textbackslash{}').replace(/&/g,'\\&').replace(/%/g,'\\%').replace(/\$/g,'\\$')
    .replace(/#/g,'\\#').replace(/_/g,'\\_').replace(/\{/g,'\\{').replace(/\}/g,'\\}').replace(/~/g,'\\textasciitilde{}').replace(/\^/g,'\\textasciicircum{}');
}

function generateModernCV(data, selVer) {
  const p = data.profile;
  const vis = k => !selVer?.hiddenSections?.includes(k);
  const ents = k => { let e = (data[k]||[]).filter(x => !selVer?.hiddenEntries?.[k]?.includes(x._id)); return e.sort((a,b)=>(b.year||b.date||0)-(a.year||a.date||0)); };
  const header = `\\documentclass[11pt,a4paper,sans]{moderncv}\n\\moderncvstyle{banking}\n\\moderncvcolor{blue}\n\\usepackage[scale=0.88]{geometry}\n\\usepackage{hyperref}\n\\name{${escTex(p.name||'First')}}{${escTex('')}}\n\\title{${escTex(p.title||'')}}\n${p.address?`\\address{${escTex(p.address)}}{}{}`:''}\n${p.phone?`\\phone[mobile]{${escTex(p.phone)}}`:''}\n${p.email?`\\email{${escTex(p.email)}}`:''}\n${p.website?`\\homepage{${escTex(p.website)}}`:''}\n${p.orcid?`\\social[orcid]{${escTex(p.orcid)}}`:''}\n\\begin{document}\n\\makecvtitle`;
  const sections = [];
  if (p.bio) sections.push(`\\section{Research Interests}\n${escTex(p.bio)}`);
  if (vis('journals') && ents('journals').length) sections.push(`\\section{Journal Publications}\n${ents('journals').map((e,i)=>`\\cvitem{[${i+1}]}{${escTex(e.authors)}. \\textit{${escTex(e.title)}}. \\textbf{${escTex(e.journal||'')}}${e.volume?`, ${escTex(e.volume)}`:''}${e.issue?`(${escTex(e.issue)})`:''}${e.pages?`:${escTex(e.pages)}`:''},${escTex(String(e.year||''))}${e.doi?`. \\href{https://doi.org/${escTex(e.doi)}}{DOI}`:''}${e.citations?` [Cited: ${e.citations}]`:''}.}`).join('\n')}`);
  if (vis('conferences') && ents('conferences').length) sections.push(`\\section{Conference Papers}\n${ents('conferences').map((e,i)=>`\\cvitem{[${i+1}]}{${escTex(e.authors)}. \\textit{${escTex(e.title)}}. \\textbf{${escTex(e.conference||'')}}${e.location?`, ${escTex(e.location)}`:''},${escTex(String(e.year||''))}${e.type?` [${escTex(e.type)}]`:''}.}`).join('\n')}`);
  if (vis('patents') && ents('patents').length) sections.push(`\\section{Patents}\n${ents('patents').map(e=>`\\cvitem{}{${escTex(e.inventors)}. \\textit{${escTex(e.title)}}. Patent ${escTex(e.number||'')}${e.country?` (${escTex(e.country)})`:''}${e.grant_date?`, ${escTex(e.grant_date)}`:''}. ${escTex(e.status||'')}.}`).join('\n')}`);
  if (vis('grants') && ents('grants').length) sections.push(`\\section{Grants \\& Funding}\n${ents('grants').map(e=>`\\cventry{${escTex(e.start_date||'')}--${escTex(e.end_date||'present')}}{${escTex(e.title||'')}}{${escTex(e.agency||'')}}{Role: ${escTex(e.role||'')}}{${e.amount?`\\$${Number(e.amount).toLocaleString()}`:''}}{${escTex(e.status||'')}}`).join('\n')}`);
  if (vis('presentations') && ents('presentations').length) sections.push(`\\section{Presentations \\& Invited Talks}\n${ents('presentations').map(e=>`\\cvitem{${escTex(e.date||'')}}{\\textit{${escTex(e.title||'')}}. ${escTex(e.event||'')}${e.location?`, ${escTex(e.location)}`:''}${e.type?` [${escTex(e.type)}]`:''}.}`).join('\n')}`);
  if (vis('students') && ents('students').length) sections.push(`\\section{Students Supervised}\n${ents('students').map(e=>`\\cventry{${escTex(String(e.start_year||''))}--${escTex(e.end_year?String(e.end_year):'present')}}{${escTex(e.name||'')}}{${escTex(e.degree||'')}}{${escTex(e.thesis_title||'')}}{${escTex(e.status||'')}}{${e.current_position?`Now: ${escTex(e.current_position)}`:''}}`).join('\n')}`);
  if (vis('awards') && ents('awards').length) sections.push(`\\section{Awards \\& Honors}\n${ents('awards').map(e=>`\\cvitem{${escTex(String(e.year||''))}}{\\textbf{${escTex(e.title||'')}}. ${escTex(e.awarding_body||'')}${e.category?` [${escTex(e.category)}]`:''}.}`).join('\n')}`);
  if (vis('service') && ents('service').length) sections.push(`\\section{Service \\& Editorial}\n${ents('service').map(e=>`\\cvitem{}{${escTex(e.role||'')}, \\textit{${escTex(e.organization||'')}}${e.type?` [${escTex(e.type)}]`:''}, ${escTex(String(e.start_year||''))}--${e.ongoing||!e.end_year?'present':escTex(String(e.end_year))}.}`).join('\n')}`);
  if (vis('courses') && ents('courses').length) sections.push(`\\section{Courses Taught}\n${ents('courses').map(e=>`\\cvitem{${escTex(String(e.year||''))}}{${e.code?`\\textbf{${escTex(e.code)}}: `:''}${escTex(e.name||'')}. ${escTex(e.level||'')}. ${escTex(e.semester||'')}${e.enrollment?`. Enrollment: ${e.enrollment}`:''}.}`).join('\n')}`);
  return `${header}\n\n${sections.join('\n\n')}\n\n\\end{document}`;
}

function generateBibTeX(data) {
  const toKey = e => { const first = (e.authors||e.inventors||'Author').split(/[,\s]/)[0].toLowerCase().replace(/[^a-z]/g,''); return `${first}${e.year||'0000'}`; };
  const entries = [];
  data.journals.forEach(e => entries.push(`@article{${toKey(e)},\n  author = {${e.authors||''}},\n  title = {{${e.title||''}}},\n  journal = {${e.journal||''}},\n  year = {${e.year||''}},\n  volume = {${e.volume||''}},\n  number = {${e.issue||''}},\n  pages = {${e.pages||''}},${e.doi?`\n  doi = {${e.doi}},`:''}\n}`));
  data.conferences.forEach(e => entries.push(`@inproceedings{${toKey(e)},\n  author = {${e.authors||''}},\n  title = {{${e.title||''}}},\n  booktitle = {${e.conference||''}},\n  year = {${e.year||''}},\n  address = {${e.location||''}},${e.doi?`\n  doi = {${e.doi}},`:''}\n}`));
  data.books.forEach(e => entries.push(`@book{${toKey(e)},\n  author = {${e.authors||''}},\n  title = {{${e.title||''}}},\n  publisher = {${e.publisher||''}},\n  year = {${e.year||''}},${e.isbn?`\n  isbn = {${e.isbn}},`:''}\n}`));
  return entries.join('\n\n');
}

/* ── PDF HTML Builder ──────────────────────────────────────────── */
function buildCVHTML(data, selVer, template) {
  const p = data.profile;
  const vis = k => !selVer?.hiddenSections?.includes(k);
  const ents = k => { let e = (data[k]||[]).filter(x => !selVer?.hiddenEntries?.[k]?.includes(x._id)); return e.sort((a,b)=>(b.year||b.date||'0').toString().localeCompare(String(a.year||a.date||'0'))); };
  const rend = (k,e,i) => {
    const a = e.authors||e.inventors||''; const n = pre => `<span class="pn">${pre}</span>`;
    if (k==='journals') return `<p class="pe">${n(`[${i+1}]`)} ${a?a+'. ':''}\u201C${esc(e.title)}.\u201D <em>${esc(e.journal||'')}</em>${e.volume?' '+e.volume:''}${e.issue?'('+e.issue+')':''}${e.pages?':'+e.pages:''}, ${e.year||''}. ${e.doi?'doi:'+e.doi+'.':''}${e.citations?` <span style="color:#666">[Cited: ${e.citations}]</span>`:''}</p>`;
    if (k==='conferences') return `<p class="pe">${n(`[${i+1}]`)} ${a?a+'. ':''}\u201C${esc(e.title)}.\u201D <em>${esc(e.conference||'')}</em>${e.location?', '+esc(e.location):''}, ${e.year||''}${e.type?' ['+e.type+']':''}.</p>`;
    if (k==='grants') return `<p class="pe">${n(`${i+1}.`)} <strong>${esc(e.title||'')}</strong>. ${esc(e.agency||'')}. ${esc(e.role||'')}. ${e.amount?'$'+Number(e.amount).toLocaleString()+'.':''} ${e.start_date||''}\u2013${e.end_date||'present'}.</p>`;
    if (k==='presentations') return `<p class="pe">${n(`${i+1}.`)} \u201C${esc(e.title||'')}.\u201D ${esc(e.event||'')}${e.location?', '+esc(e.location):''}, ${e.date||''}${e.type?' ['+e.type+']':''}.</p>`;
    if (k==='awards') return `<p class="pe">${n(`${i+1}.`)} <strong>${esc(e.title||'')}</strong>. ${esc(e.awarding_body||'')}, ${e.year||''}.</p>`;
    if (k==='students') return `<p class="pe">${n(`${i+1}.`)} <strong>${esc(e.name||'')}</strong>, ${esc(e.degree||'')}${e.thesis_title?'. \u201C'+esc(e.thesis_title)+'.\u201D':''} (${e.start_year||''}\u2013${e.end_year||'present'})${e.current_position?'. Now: '+esc(e.current_position):''}.</p>`;
    if (k==='service') return `<p class="pe">${n(`${i+1}.`)} ${esc(e.role||'')}${e.organization?', '+esc(e.organization):''}${e.type?' ['+e.type+']':''}. ${e.start_year||''}\u2013${e.ongoing||!e.end_year?'present':e.end_year}.</p>`;
    if (k==='courses') return `<p class="pe">${n(`${i+1}.`)} ${e.code?`<strong>${esc(e.code)}</strong>: `:''}<strong>${esc(e.name||'')}</strong>. ${esc(e.level||'')}. ${esc(e.semester||'')} ${e.year||''}${e.enrollment?'. Enrollment: '+e.enrollment:''}.</p>`;
    return `<p class="pe">${n(`${i+1}.`)} ${esc(e.title||e.name||e.role||'')}.</p>`;
  };
  const sectionHTML = Object.keys(SECTION_LABELS).filter(vis).map(k => { const es = ents(k); if (!es.length) return ''; return `<div class="sh">${SECTION_LABELS[k]}</div>${es.map((e,i)=>rend(k,e,i)).join('')}`; }).join('');
  const styles = {
    classic: `body{font-family:'Times New Roman',Georgia,serif;font-size:11pt;color:#111;max-width:720px;margin:0 auto;padding:48px 60px;line-height:1.52}.hd{text-align:center;border-bottom:2.5px solid #111;padding-bottom:14px;margin-bottom:22px}.name{font-size:22pt;font-weight:bold;letter-spacing:.5px}.ti{font-size:12pt;font-style:italic;margin:4px 0}.ct{font-size:9.5pt;color:#444;margin-top:6px}.sh{font-size:11pt;font-weight:bold;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #888;margin:22px 0 10px;padding-bottom:3px}.pe{margin-bottom:9px;text-align:justify;font-size:10.5pt}.pn{font-weight:bold;color:#555;margin-right:3px}`,
    modern: `*{box-sizing:border-box}body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:10pt;margin:0;display:grid;grid-template-columns:190px 1fr;min-height:100vh;color:#222}.sb{background:#1a2332;color:#cdd5e0;padding:32px 18px}.sb .name{font-size:15pt;font-weight:700;color:#fff;margin-bottom:4px;line-height:1.2}.sb .ti{font-size:9pt;color:#8fa3bd;margin-bottom:18px;line-height:1.4}.sb .sl{font-size:7pt;letter-spacing:2px;text-transform:uppercase;color:#4a6a8a;margin:14px 0 6px;border-top:1px solid #253548;padding-top:10px}.sb .si{font-size:8.5pt;color:#a0bace;margin-bottom:4px;word-break:break-word}.main{padding:36px 32px;background:#fff}.sh{font-size:10.5pt;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#1a2332;border-bottom:2px solid #C9A84C;margin:22px 0 10px;padding-bottom:4px}.pe{margin-bottom:9px;font-size:9.5pt;line-height:1.5;color:#333}.pn{font-weight:700;color:#5baed1;margin-right:3px}`,
    nsf: `body{font-family:Arial,sans-serif;font-size:11pt;color:#000;max-width:720px;margin:0 auto;padding:1in;line-height:1.4}.hb{border:2px solid #000;padding:10px 14px;margin-bottom:14px}.name{font-size:13pt;font-weight:bold}.sh{font-size:11pt;font-weight:bold;text-transform:uppercase;margin:16px 0 8px;background:#ddd;padding:3px 8px}.pe{margin-bottom:8px;font-size:10pt;line-height:1.45}.pn{margin-right:3px}`,
  };
  const headers = {
    classic: `<div class="hd"><div class="name">${esc(p.name||'[Name]')}</div>${p.title?`<div class="ti">${esc(p.title)}</div>`:''}${p.department||p.institution?`<div class="ti">${esc([p.department,p.institution].filter(Boolean).join(', '))}</div>`:''}<div class="ct">${[p.email,p.phone,p.website].filter(Boolean).join(' &nbsp;|&nbsp; ')}${p.orcid?`<br>ORCID: ${esc(p.orcid)}`:''}</div></div>${p.bio?`<p style="font-style:italic;margin-bottom:16px;font-size:10.5pt">${esc(p.bio)}</p>`:''}`,
    modern: `<div class="sb"><div class="name">${esc(p.name||'[Name]')}</div><div class="ti">${[p.title,p.department].filter(Boolean).join('<br>')}</div>${p.institution?`<div style="font-size:9pt;color:#6a8aaa;margin-bottom:18px">${esc(p.institution)}</div>`:''}<div class="sl">Contact</div>${p.email?`<div class="si">${esc(p.email)}</div>`:''}${p.phone?`<div class="si">${esc(p.phone)}</div>`:''}${p.website?`<div class="si">${esc(p.website)}</div>`:''}${p.orcid?`<div class="si">ORCID: ${esc(p.orcid)}</div>`:''}${p.bio?`<div class="sl">Research</div><div class="si" style="font-size:8pt;line-height:1.5;color:#8fa3bd">${esc(p.bio)}</div>`:''}</div><div class="main">`,
    nsf: `<div class="hb"><div class="name">${esc(p.name||'[Name]')}</div><div style="font-size:9pt">${[p.title,p.department,p.institution].filter(Boolean).join(' | ')}</div><div style="font-size:9pt">${[p.email,p.website].filter(Boolean).join(' | ')}${p.orcid?' | ORCID: '+esc(p.orcid):''}</div></div>`,
  };
  const footers = { modern:'</div>', classic:'', nsf:'' };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CV \u2014 ${esc(p.name||'Professor')}</title><style>${styles[template]||styles.classic}@media print{body{padding:0}@page{margin:.75in;size:letter}}</style></head><body>${headers[template]||headers.classic}${sectionHTML}${footers[template]||''}<script>window.onload=()=>window.print()<\/script></body></html>`;
}

/* ══════════════════════════════════════════════════════════════════
   STATE MANAGEMENT
   ══════════════════════════════════════════════════════════════════ */
let _data = null;
let _sec = 'dashboard';
let _showForm = false;
let _editing = null;
let _toastTimer = null;
let _chartInstances = {};
let _citationInterval = null;

function getData() { return _data; }
function setData(d) { _data = d; }

async function persist(d) {
  const user = McgheeLab.Auth?.currentUser;
  if (!user) return;
  try {
    await McgheeLab.DB.saveCVData(user.uid, d);
    showToast('Saved \u2713');
  } catch (e) {
    console.error('CV save error:', e);
    showToast('Save failed', 'error');
  }
}

function upd(d) { setData(d); persist(d); renderCurrentSection(); syncAssociations(d); }

function syncAssociations(d) {
  const user = McgheeLab.Auth?.currentUser;
  if (!user) return;
  McgheeLab.DB.syncCVToProfile(user.uid, d).catch(e => console.error('Association sync error:', e));
}

function showToast(msg, type) {
  const el = document.getElementById('cv-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'cv-toast ' + (type || 'ok');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'cv-toast hidden'; }, 2600);
}

function goTo(k) {
  _sec = k; _showForm = false; _editing = null;
  // Close mobile nav
  const overlay = document.getElementById('cv-mobile-overlay');
  const drawer = document.getElementById('cv-mobile-drawer');
  if (overlay) overlay.classList.remove('open');
  if (drawer) drawer.classList.remove('open');
  renderCurrentSection();
  updateNavActive();
}

/* ══════════════════════════════════════════════════════════════════
   RENDER: MAIN SHELL
   ══════════════════════════════════════════════════════════════════ */
function renderCV() {
  return `
    <div class="cv-app" id="cv-app">
      <!-- Mobile Header -->
      <div class="cv-mobile-header" id="cv-mobile-header">
        <button id="cv-mobile-menu-btn" style="background:none;border:none;color:${T.gold};font-size:20px;cursor:pointer;padding:4px">\u2630</button>
        <span style="font-family:inherit;font-weight:700;font-size:14px;color:${T.gold};flex:1">CV Builder</span>
        <span id="cv-mobile-sec-label" style="font-size:12px;color:${T.muted}"></span>
      </div>
      <!-- Mobile Overlay -->
      <div class="cv-mobile-overlay" id="cv-mobile-overlay"></div>
      <div class="cv-mobile-drawer" id="cv-mobile-drawer">
        <div class="cv-sidebar-header">
          <span class="cv-sidebar-title">CV Builder</span>
          <button id="cv-mobile-close-btn" style="background:none;border:none;color:${T.muted};cursor:pointer;font-size:18px;margin-left:auto;padding:2px">\u2715</button>
        </div>
        <div class="cv-sidebar-nav" id="cv-mobile-nav"></div>
      </div>
      <!-- Desktop Sidebar -->
      <div class="cv-sidebar" id="cv-sidebar">
        <div class="cv-sidebar-header">
          <span class="cv-sidebar-title">CV Builder</span>
        </div>
        <div class="cv-sidebar-nav" id="cv-desktop-nav"></div>
      </div>
      <!-- Main Content -->
      <div class="cv-main" id="cv-main">
        <div style="display:flex;align-items:center;justify-content:center;height:200px;color:${T.muted};font-family:inherit;gap:12px">
          <span class="cv-spin" style="width:16px;height:16px"></span> Loading CV data\u2026
        </div>
      </div>
      <!-- Bottom Nav -->
      <div class="cv-bottom-nav" id="cv-bottom-nav">
        <button class="cv-bottom-nav-btn" data-cv-sec="dashboard"><span style="color:${T.gold}">\u25C8</span><span>Home</span></button>
        <button class="cv-bottom-nav-btn" data-cv-sec="journals"><span style="color:#5baed1">\u25A4</span><span>Papers</span></button>
        <button class="cv-bottom-nav-btn" data-cv-sec="analytics"><span style="color:#7cc4ff">\u25B2</span><span>Stats</span></button>
        <button class="cv-bottom-nav-btn" data-cv-sec="export_"><span style="color:#5baed1">\u2197</span><span>Export</span></button>
        <button class="cv-bottom-nav-btn" data-cv-sec="profile"><span style="color:${T.cream}">\u25C9</span><span>Profile</span></button>
      </div>
      <!-- Toast -->
      <div id="cv-toast" class="cv-toast hidden"></div>
    </div>`;
}

function buildNavHTML() {
  let html = '';
  for (const g of NAV_GROUPS) {
    html += `<div class="cv-nav-group-label">${g.label}</div>`;
    for (const k of g.keys) {
      const m = SM[k];
      const cnt = _data?.[k === 'import_' || k === 'export_' ? null : k]?.length;
      html += `<button class="cv-nav-btn${_sec === k ? ' active' : ''}" data-cv-sec="${k}" style="border-left-color:${_sec===k?m.color:'transparent'};color:${_sec===k?T.cream:T.mutedLight}">
        <span class="cv-nav-icon" style="color:${_sec===k?m.color:T.muted}">${m.icon}</span>
        <span class="cv-nav-label">${m.label}</span>
        ${cnt != null && cnt > 0 ? `<span class="cv-nav-count" style="color:${m.color}">${cnt}</span>` : ''}
      </button>`;
    }
  }
  return html;
}

function updateNavActive() {
  document.querySelectorAll('.cv-nav-btn').forEach(btn => {
    const k = btn.dataset.cvSec;
    const m = SM[k];
    if (!m) return;
    const active = k === _sec;
    btn.className = 'cv-nav-btn' + (active ? ' active' : '');
    btn.style.borderLeftColor = active ? m.color : 'transparent';
    btn.style.color = active ? T.cream : T.mutedLight;
    const icon = btn.querySelector('.cv-nav-icon');
    if (icon) icon.style.color = active ? m.color : T.muted;
  });
  const mobileLabel = document.getElementById('cv-mobile-sec-label');
  if (mobileLabel && SM[_sec]) mobileLabel.textContent = SM[_sec].label;
  // Update bottom nav
  document.querySelectorAll('.cv-bottom-nav-btn').forEach(btn => {
    const k = btn.dataset.cvSec;
    const active = k === _sec;
    btn.style.color = active ? T.gold : T.muted;
  });
}

/* ══════════════════════════════════════════════════════════════════
   RENDER: INDIVIDUAL SECTIONS
   ══════════════════════════════════════════════════════════════════ */
function renderCurrentSection() {
  const main = document.getElementById('cv-main');
  if (!main || !_data) return;
  // Destroy old charts
  Object.values(_chartInstances).forEach(c => { try { c.destroy(); } catch {} });
  _chartInstances = {};

  const schema = SCHEMAS[_sec];
  const meta = SM[_sec];

  if (_sec === 'dashboard') { main.innerHTML = renderDashboard(); wireDashboard(); }
  else if (_sec === 'analytics') { main.innerHTML = renderAnalytics(); wireAnalytics(); }
  else if (_sec === 'profile') { main.innerHTML = renderProfile(); wireProfile(); }
  else if (_sec === 'import_') { main.innerHTML = renderImport(); wireImport(); }
  else if (_sec === 'ai') { main.innerHTML = renderAI(); wireAI(); }
  else if (_sec === 'versions') { main.innerHTML = renderVersions(); wireVersions(); }
  else if (_sec === 'export_') { main.innerHTML = renderExport(); wireExport(); }
  else if (_sec === 'citations') { main.innerHTML = renderCitations(); wireCitations(); }
  else if (_sec === 'orcid') { main.innerHTML = renderORCID(); wireORCID(); }
  else if (_sec === 'settings') { main.innerHTML = renderSettings(); wireSettings(); }
  else if (schema) {
    if (_showForm) { main.innerHTML = renderEntryForm(schema, _editing); wireEntryForm(schema); }
    else { main.innerHTML = renderEntryList(_sec, schema, meta); wireEntryList(_sec, schema); }
  }

  // Refresh nav counts
  const desktopNav = document.getElementById('cv-desktop-nav');
  const mobileNav = document.getElementById('cv-mobile-nav');
  if (desktopNav) desktopNav.innerHTML = buildNavHTML();
  if (mobileNav) mobileNav.innerHTML = buildNavHTML();
  updateNavActive();
}

/* ── Dashboard ─────────────────────────────────────────────────── */
function renderDashboard() {
  const d = _data;
  const totalPubs = d.journals.length + d.conferences.length + d.books.length;
  const totalCitations = d.journals.reduce((s,j) => s + (Number(j.citations)||0), 0);
  const hIndex = (() => { const c = d.journals.map(j=>Number(j.citations)||0).sort((a,b)=>b-a); let h=0; while(h<c.length && c[h]>h) h++; return h; })();
  const totalFunding = d.grants.reduce((s,g) => s + (Number(g.amount)||0), 0);
  const activeGrants = d.grants.filter(g=>g.status==='Active').length;
  const currentStudents = d.students.filter(s=>s.status==='Current').length;

  let tilesHTML = '';
  for (const [k,m] of Object.entries(SM)) {
    if (['dashboard','analytics','profile','import_','ai','versions','export_','citations','orcid','settings'].includes(k)) continue;
    const cnt = d[k]?.length || 0;
    tilesHTML += `<div class="cv-dash-tile" data-cv-sec="${k}">
      <span style="font-size:15px;color:${m.color};width:18px;text-align:center">${m.icon}</span>
      <div style="flex:1"><div style="font-size:12px;color:${T.cream};font-family:inherit">${m.label}</div></div>
      <div style="font-size:22px;font-family:inherit;font-weight:700;color:${cnt>0?m.color:T.border}">${cnt}</div>
    </div>`;
  }

  return `<div class="cv-fade-up">
    <div style="margin-bottom:24px">
      ${d.profile.name
        ? `<div style="font-family:inherit;font-weight:700;font-size:28px;color:${T.cream};margin-bottom:4px;line-height:1.2">${esc(d.profile.name)}</div>
           <div style="font-family:inherit;font-size:11px;color:${T.muted}">${esc(d.profile.title||'')}${d.profile.institution?' \u00B7 '+esc(d.profile.institution):''}</div>`
        : `<div style="font-family:inherit;font-weight:700;font-size:28px;color:${T.muted}">Your CV Dashboard</div>`}
    </div>
    <div style="display:flex;gap:1px;margin-bottom:1px;flex-wrap:wrap">
      <div class="cv-stat" style="cursor:pointer" data-cv-sec="journals"><div class="cv-stat-value" style="color:${T.gold}">${totalPubs}</div><div class="cv-stat-label">Publications</div></div>
      <div class="cv-stat" style="cursor:pointer" data-cv-sec="analytics"><div class="cv-stat-value" style="color:${T.blue}">${totalCitations}</div><div class="cv-stat-label">Citations</div></div>
      <div class="cv-stat"><div class="cv-stat-value" style="color:${T.purple}">${hIndex||'\u2014'}</div><div class="cv-stat-label">h-Index</div></div>
      <div class="cv-stat" style="cursor:pointer" data-cv-sec="grants"><div class="cv-stat-value" style="color:${T.green}">${activeGrants}</div><div class="cv-stat-label">Active Grants</div></div>
      <div class="cv-stat" style="cursor:pointer" data-cv-sec="students"><div class="cv-stat-value" style="color:#fbbf24">${currentStudents}</div><div class="cv-stat-label">Students</div></div>
      <div class="cv-stat"><div class="cv-stat-value" style="color:${T.green}">${totalFunding?'$'+(totalFunding/1000).toFixed(0)+'k':'\u2014'}</div><div class="cv-stat-label">Total Funding</div></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1px;margin-top:1px">${tilesHTML}</div>
  </div>`;
}

function wireDashboard() {
  document.querySelectorAll('[data-cv-sec]').forEach(el => {
    el.addEventListener('click', () => goTo(el.dataset.cvSec));
  });
}

/* ── Analytics ─────────────────────────────────────────────────── */
function renderAnalytics() {
  return `<div class="cv-fade-up">
    <h2 class="cv-h2">Analytics</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px">
      <div class="cv-card"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Publications per Year</div><div class="cv-chart-wrap"><canvas id="cv-chart-pubs"></canvas></div></div>
      <div class="cv-card"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Citations per Year</div><div class="cv-chart-wrap"><canvas id="cv-chart-cits"></canvas></div></div>
      <div class="cv-card"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Journal Quartiles</div><div class="cv-chart-wrap"><canvas id="cv-chart-quart"></canvas></div></div>
      <div class="cv-card"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Top Cited Papers</div><div class="cv-chart-wrap"><canvas id="cv-chart-topcit"></canvas></div></div>
    </div>
  </div>`;
}

function wireAnalytics() {
  if (typeof Chart === 'undefined') return;
  const d = _data;
  const chartColors = { gold: T.accent, green: '#86efac', purple: '#c4b5fd', red: '#fca5a5', blue: '#7cc4ff' };
  const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: T.muted, font: { size: 9 } }, grid: { display: false } }, y: { ticks: { color: T.muted, font: { size: 9 } }, grid: { color: T.border } } } };

  // Pubs per year
  const pubsByYear = {};
  [...d.journals, ...d.conferences, ...d.books].forEach(e => { if (e.year) pubsByYear[e.year] = (pubsByYear[e.year]||0) + 1; });
  const pubYears = Object.keys(pubsByYear).sort();
  const pubEl = document.getElementById('cv-chart-pubs');
  if (pubEl && pubYears.length) {
    _chartInstances.pubs = new Chart(pubEl, { type: 'bar', data: { labels: pubYears, datasets: [{ data: pubYears.map(y=>pubsByYear[y]), backgroundColor: T.gold+'cc', borderRadius: 2 }] }, options: chartDefaults });
  }

  // Citations per year
  const citsByYear = {};
  d.journals.forEach(e => { if (e.year && e.citations) citsByYear[e.year] = (citsByYear[e.year]||0) + Number(e.citations); });
  const citYears = Object.keys(citsByYear).sort();
  const citEl = document.getElementById('cv-chart-cits');
  if (citEl && citYears.length) {
    _chartInstances.cits = new Chart(citEl, { type: 'line', data: { labels: citYears, datasets: [{ data: citYears.map(y=>citsByYear[y]), borderColor: T.blue, backgroundColor: T.blue+'33', fill: true, tension: .3, pointRadius: 3 }] }, options: chartDefaults });
  }

  // Quartile distribution
  const qDist = { Q1:0, Q2:0, Q3:0, Q4:0 };
  d.journals.forEach(e => { if (e.quartile && qDist[e.quartile] !== undefined) qDist[e.quartile]++; });
  const qLabels = Object.keys(qDist).filter(k => qDist[k] > 0);
  const quartEl = document.getElementById('cv-chart-quart');
  if (quartEl && qLabels.length) {
    _chartInstances.quart = new Chart(quartEl, { type: 'doughnut', data: { labels: qLabels, datasets: [{ data: qLabels.map(k=>qDist[k]), backgroundColor: [T.gold, chartColors.green, chartColors.purple, chartColors.red] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: T.muted, font: { size: 10 } } } } } });
  }

  // Top cited
  const topCited = d.journals.filter(j=>j.citations).sort((a,b)=>Number(b.citations)-Number(a.citations)).slice(0,10);
  const topEl = document.getElementById('cv-chart-topcit');
  if (topEl && topCited.length) {
    _chartInstances.topcit = new Chart(topEl, { type: 'bar', data: { labels: topCited.map(j=>(j.title||'').slice(0,16)+'\u2026'), datasets: [{ data: topCited.map(j=>Number(j.citations)), backgroundColor: T.blue+'cc', borderRadius: 2 }] }, options: { ...chartDefaults, indexAxis: 'y' } });
  }
}

/* ── Profile ───────────────────────────────────────────────────── */
function renderProfile() {
  const p = _data.profile;
  const fields = [{k:'name',l:'Full Name',span:2,req:true},{k:'title',l:'Title / Position',span:2},{k:'institution',l:'Institution'},{k:'department',l:'Department'},{k:'email',l:'Email'},{k:'phone',l:'Phone'},{k:'website',l:'Website URL'},{k:'orcid',l:'ORCID',hint:'0000-0000-0000-0000'},{k:'scholar',l:'Google Scholar ID'},{k:'address',l:'Office Address',span:2},{k:'bio',l:'Short Bio / Research Interests',type:'textarea',span:2}];
  let fieldsHTML = '';
  for (const f of fields) {
    const val = esc(p[f.k] || '');
    fieldsHTML += `<div ${f.span===2?'class="cv-span-2"':''}>
      <label class="cv-form-label ${f.req?'required':''}">${f.l}${f.req?' *':''}</label>
      ${f.type === 'textarea'
        ? `<textarea class="cv-field" data-cv-profile="${f.k}" rows="3">${val}</textarea>`
        : `<input class="cv-field" data-cv-profile="${f.k}" value="${val}" placeholder="${f.hint||''}">`}
    </div>`;
  }
  return `<div class="cv-fade-up">
    <h2 class="cv-h2">Profile</h2>
    <div class="cv-card">
      <div class="cv-form-grid">${fieldsHTML}
        <div class="cv-span-2" style="display:flex;justify-content:flex-end;margin-top:6px">
          <button class="cv-btn cv-btn-gold" id="cv-profile-save">Save Profile</button>
        </div>
      </div>
    </div>
  </div>`;
}

function wireProfile() {
  document.getElementById('cv-profile-save')?.addEventListener('click', () => {
    const p = { ..._data.profile };
    document.querySelectorAll('[data-cv-profile]').forEach(el => {
      p[el.dataset.cvProfile] = el.value;
    });
    upd({ ..._data, profile: p });
    showToast('Profile saved');
  });
}

/* ── Entry List (generic for all SCHEMAS sections) ─────────────── */
function renderEntryList(section, schema, meta) {
  const entries = _data[section] || [];
  const title = e => e.title || e.name || `${e.role || ''} \u2014 ${e.organization || ''}`;
  const sub = e => [e.journal||e.conference||e.agency||e.event||e.awarding_body||e.publisher||e.code||'', e.semester?(e.semester+' '+(e.year||'')):(e.year||e.date||'')].filter(Boolean).join(' \u00B7 ');
  const badge = e => {
    const s = e.status, t = e.type, q = e.quartile;
    if (s) return { label:s, c: s==='Published'||s==='Granted'||s==='Active'||s==='Graduated'?T.green : s==='Under Review'||s==='Pending'?T.gold : T.muted };
    if (q) return { label:q, c:T.gold };
    if (t) return { label:t, c:meta.color };
    return null;
  };

  let rowsHTML = '';
  if (entries.length === 0) {
    rowsHTML = `<div style="text-align:center;padding:52px 0;color:${T.muted};font-family:inherit;font-size:12px">No entries yet. Click + Add to begin.</div>`;
  } else {
    rowsHTML = `<div style="border:1px solid ${T.border}">`;
    entries.forEach((e, i) => {
      const b = badge(e);
      rowsHTML += `<div class="cv-entry-row" style="${i<entries.length-1?'border-bottom:1px solid '+T.border:''}">
        <span class="cv-entry-num" style="color:${meta.color}">${String(i+1).padStart(2,'0')}</span>
        <div style="flex:1;min-width:0">
          <div class="cv-entry-title">${esc(title(e))}</div>
          <div class="cv-entry-sub">${esc(sub(e))}${e.doi?` <span style="color:${T.blue}">\u00B7 ${esc(e.doi)}</span>`:''}${e.citations?` <span style="color:${T.mutedLight}">\u00B7 \u2726${e.citations}</span>`:''}${e.amount?` <span style="color:${T.green}">\u00B7 $${Number(e.amount).toLocaleString()}</span>`:''}</div>
        </div>
        ${b?`<span class="cv-chip" style="background:${b.c}22;color:${b.c};border:1px solid ${b.c}44">${esc(b.label)}</span>`:''}
        <div class="cv-row-acts">
          <button class="cv-btn cv-btn-outline" data-cv-edit="${e._id}" style="padding:3px 10px">Edit</button>
          <button class="cv-btn cv-btn-danger" data-cv-del="${e._id}" style="padding:3px 10px">Del</button>
        </div>
      </div>`;
    });
    rowsHTML += '</div>';
  }

  return `<div class="cv-fade-up">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:baseline;gap:12px">
        <h2 class="cv-h2" style="margin-bottom:0">${meta.label}</h2>
        <span style="font-size:10px;color:${T.muted};font-family:inherit">${entries.length} entries</span>
      </div>
      <button class="cv-btn cv-btn-gold" id="cv-add-entry">+ Add</button>
    </div>
    ${entries.length > 5 ? `<input class="cv-field" id="cv-entry-search" placeholder="Search\u2026" style="margin-bottom:12px">` : ''}
    ${rowsHTML}
  </div>`;
}

function wireEntryList(section, schema) {
  document.getElementById('cv-add-entry')?.addEventListener('click', () => {
    _editing = null; _showForm = true; renderCurrentSection();
  });
  document.querySelectorAll('[data-cv-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = (_data[section]||[]).find(e => e._id === btn.dataset.cvEdit);
      if (entry) { _editing = entry; _showForm = true; renderCurrentSection(); }
    });
  });
  document.querySelectorAll('[data-cv-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      const nd = { ..._data, [section]: _data[section].filter(e => e._id !== btn.dataset.cvDel) };
      upd(nd);
    });
  });
  document.getElementById('cv-entry-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.cv-entry-row').forEach(row => {
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ── Entry Form (generic) ──────────────────────────────────────── */
function renderEntryForm(schema, initial) {
  const form = initial || {};
  let doiHTML = '';
  if (schema.doiField) {
    doiHTML = `<div class="cv-doi-bar">
      <div class="cv-section-label" style="color:${T.gold};margin-bottom:8px">\u26A1 Auto-fill from DOI</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="cv-field" id="cv-doi-input" placeholder="e.g. 10.1038/nature12345" style="flex:1;min-width:180px">
        <button class="cv-btn cv-btn-gold" id="cv-doi-fetch">Fetch</button>
      </div>
      <div id="cv-doi-err" style="font-size:11px;color:${T.red};font-family:inherit;margin-top:6px;display:none"></div>
    </div>`;
  }
  let fieldsHTML = '';
  for (const f of schema.fields) {
    if (f.type === 'doi') continue;
    const val = esc(form[f.key] || '');
    let input;
    if (f.type === 'textarea') input = `<textarea class="cv-field" data-cv-form="${f.key}" rows="3">${val}</textarea>`;
    else if (f.type === 'select') input = `<select class="cv-field" data-cv-form="${f.key}">${(f.options||[]).map(o=>`<option value="${o}"${(form[f.key]||'')===o?' selected':''}>${o||'\u2014 select \u2014'}</option>`).join('')}</select>`;
    else if (f.type === 'checkbox') input = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" data-cv-form="${f.key}" ${form[f.key]?'checked':''} style="accent-color:${T.gold};width:14px;height:14px"><span style="font-size:11px;color:${T.mutedLight};font-family:inherit">Yes</span></label>`;
    else input = `<input type="${f.type==='number'?'number':f.type==='date'?'date':'text'}" class="cv-field" data-cv-form="${f.key}" value="${val}" placeholder="${f.hint||''}">`;
    fieldsHTML += `<div ${f.span===2?'class="cv-span-2"':''}>
      <label class="cv-form-label ${f.required?'required':''}">${f.l||f.label}${f.required?' *':''}</label>
      ${input}
    </div>`;
  }
  return `<div class="cv-fade-up cv-card" style="margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <div style="font-family:inherit;font-weight:700;font-size:20px;color:${T.cream}">${initial?._id ? 'Edit Entry' : 'New Entry'}</div>
      <button class="cv-btn cv-btn-outline" id="cv-form-cancel" style="padding:3px 10px;font-size:14px">\u2715</button>
    </div>
    ${doiHTML}
    <div class="cv-form-grid">${fieldsHTML}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap">
      <button class="cv-btn cv-btn-outline" id="cv-form-cancel2">Cancel</button>
      <button class="cv-btn cv-btn-gold" id="cv-form-save">Save Entry</button>
    </div>
  </div>`;
}

function wireEntryForm(schema) {
  const cancel = () => { _showForm = false; _editing = null; renderCurrentSection(); };
  document.getElementById('cv-form-cancel')?.addEventListener('click', cancel);
  document.getElementById('cv-form-cancel2')?.addEventListener('click', cancel);

  document.getElementById('cv-form-save')?.addEventListener('click', () => {
    const form = { ...(_editing || {}) };
    document.querySelectorAll('[data-cv-form]').forEach(el => {
      const k = el.dataset.cvForm;
      form[k] = el.type === 'checkbox' ? el.checked : el.value;
    });
    // Validate required
    const valid = schema.fields.filter(f=>f.required).every(f => form[f.key] && String(form[f.key]).trim());
    if (!valid) { showToast('Fill required fields', 'error'); return; }
    if (!form._id) form._id = uid();
    const list = _data[_sec] || [];
    const newList = _editing ? list.map(e => e._id === _editing._id ? form : e) : [...list, form];
    const nd = { ..._data, [_sec]: newList };
    _showForm = false; _editing = null;
    upd(nd);
    showToast(_editing ? 'Entry updated' : 'Entry added');
  });

  // DOI fetch
  document.getElementById('cv-doi-fetch')?.addEventListener('click', async () => {
    const input = document.getElementById('cv-doi-input');
    const errEl = document.getElementById('cv-doi-err');
    if (!input?.value.trim()) return;
    const btn = document.getElementById('cv-doi-fetch');
    btn.disabled = true; btn.textContent = 'Fetching\u2026'; errEl.style.display = 'none';
    try {
      const d = await fetchDOI(input.value);
      // Fill form fields
      Object.entries(d).forEach(([k,v]) => {
        const el = document.querySelector(`[data-cv-form="${k}"]`);
        if (el && v) el.value = v;
      });
      input.value = '';
    } catch {
      errEl.textContent = 'DOI not found \u2014 check format and retry';
      errEl.style.display = 'block';
    } finally { btn.disabled = false; btn.textContent = 'Fetch'; }
  });
}

/* ── Import Panel ──────────────────────────────────────────────── */
function renderImport() {
  return `<div class="cv-fade-up">
    <h2 class="cv-h2" style="margin-bottom:6px">Import</h2>
    <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:16px">Import from a CV PDF, BibTeX files, or paste BibTeX.</p>
    <div class="cv-tab-strip">
      <button class="cv-tab-btn active" data-cv-import-tab="pdf">PDF Upload</button>
      <button class="cv-tab-btn" data-cv-import-tab="bibfiles">BibTeX Files</button>
      <button class="cv-tab-btn" data-cv-import-tab="bibtex">Paste BibTeX</button>
    </div>
    <div id="cv-import-content">
      <!-- PDF tab default -->
      <div class="cv-card">
        <div class="cv-section-label" style="color:#86efac;margin-bottom:12px">Upload Document (PDF)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          <button class="cv-btn cv-import-dtype active" data-dtype="auto" style="background:${T.gold}18;border:1px solid ${T.gold};color:${T.gold}">Auto-detect</button>
          <button class="cv-btn cv-import-dtype" data-dtype="cp" style="border:1px solid ${T.border};color:${T.muted}">Current & Pending</button>
          <button class="cv-btn cv-import-dtype" data-dtype="biosketch" style="border:1px solid ${T.border};color:${T.muted}">Biographical Sketch</button>
        </div>
        <div class="cv-drop-zone" id="cv-pdf-drop">
          <input type="file" id="cv-pdf-input" accept=".pdf" style="display:none">
          <div style="font-size:22px;color:${T.muted};margin-bottom:6px">\u2399</div>
          <div style="font-size:12px;color:${T.mutedLight};font-family:inherit;margin-bottom:4px">Drop a PDF here or click to browse</div>
        </div>
        <div id="cv-pdf-results"></div>
      </div>
      <div class="cv-card" style="margin-top:12px">
        <div class="cv-section-label" style="color:#86efac;margin-bottom:8px">Or Paste Document Text</div>
        <textarea class="cv-field" id="cv-paste-text" rows="6" placeholder="Paste the full text of your PDF here\u2026" style="font-size:11px;margin-bottom:10px"></textarea>
        <button class="cv-btn cv-btn-gold" id="cv-paste-parse">Parse Pasted Text</button>
      </div>
    </div>
  </div>`;
}

function wireImport() {
  let docType = 'auto';
  let currentTab = 'pdf';

  // Tab switching
  document.querySelectorAll('[data-cv-import-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.cvImportTab;
      document.querySelectorAll('[data-cv-import-tab]').forEach(b => b.classList.toggle('active', b === btn));
      renderImportTab(currentTab, docType);
    });
  });

  // Doc type switching
  function wireDocTypes() {
    document.querySelectorAll('.cv-import-dtype').forEach(btn => {
      btn.addEventListener('click', () => {
        docType = btn.dataset.dtype;
        document.querySelectorAll('.cv-import-dtype').forEach(b => {
          const active = b === btn;
          b.style.background = active ? T.gold+'18' : 'transparent';
          b.style.borderColor = active ? T.gold : T.border;
          b.style.color = active ? T.gold : T.muted;
          b.classList.toggle('active', active);
        });
      });
    });
  }

  // PDF drop/file
  function wirePDFDrop() {
    const drop = document.getElementById('cv-pdf-drop');
    const input = document.getElementById('cv-pdf-input');
    if (!drop || !input) return;
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('active'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('active'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('active'); if (e.dataTransfer.files[0]) handlePDFText(e.dataTransfer.files[0]); });
    input.addEventListener('change', e => { if (e.target.files[0]) handlePDFText(e.target.files[0]); e.target.value = ''; });
  }

  async function handlePDFText(file) {
    try {
      const text = await new Promise((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Read fail')); r.readAsText(file);
      });
      const cleaned = text.replace(/[^\x20-\x7E\xA0-\xFF\n\r\t]/g, ' ').replace(/ {3,}/g, ' ').trim();
      if (!cleaned || cleaned.length < 50) { showToast('Could not extract text. Use Paste Text.', 'error'); return; }
      const result = parseDocumentText(cleaned, docType);
      showImportResults(result);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  // Paste parse
  document.getElementById('cv-paste-parse')?.addEventListener('click', () => {
    const text = document.getElementById('cv-paste-text')?.value?.trim();
    if (!text || text.length < 50) { showToast('Paste more text (50+ chars)', 'error'); return; }
    const result = parseDocumentText(text, docType);
    showImportResults(result);
  });

  function showImportResults(result) {
    const container = document.getElementById('cv-pdf-results')
      || document.getElementById('cv-bib-paste-results')
      || document.getElementById('cv-bib-results');
    if (!container) return;
    if (result.entries.length === 0) { showToast('No entries found in document', 'error'); return; }
    showToast('Parsed ' + result.entries.length + ' entries');
    let html = `<div class="cv-card" style="margin-top:12px">
      <div class="cv-section-label" style="color:#86efac;margin-bottom:12px">${result.entries.length} entries found</div>
      <div style="border:1px solid ${T.border};max-height:400px;overflow:auto;margin-bottom:14px">`;
    result.entries.forEach((e, i) => {
      const dupes = findDuplicates(e, _data);
      html += `<div class="cv-import-entry${dupes.length?' dupe':''}" data-import-idx="${i}">
        <input type="checkbox" ${dupes.length?'':'checked'} data-import-check="${i}">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:${T.cream};font-family:inherit">${esc(e.title||e.name||'Untitled')}</div>
          <div style="font-size:10px;color:${T.muted};font-family:inherit;margin-top:2px"><span style="color:${SM[e.section]?.color||T.muted}">${SECTION_LABELS[e.section]||e.section}</span> ${esc([e.authors||e.inventors||e.name||'',e.year||e.start_year||'',e.journal||e.conference||e.event||e.agency||e.organization||e.institution||''].filter(Boolean).join(' \u00B7 '))}</div>
          ${dupes.length?`<div style="font-size:9px;color:${T.red};font-family:inherit;margin-top:3px">DUPLICATE \u2014 matches in ${SECTION_LABELS[dupes[0].section]||dupes[0].section}</div>`:''}
        </div>
      </div>`;
    });
    html += `</div><button class="cv-btn cv-btn-gold" id="cv-import-go">Import Selected \u2192</button></div>`;
    container.innerHTML = html;

    document.getElementById('cv-import-go')?.addEventListener('click', () => {
      const toImport = [];
      document.querySelectorAll('[data-import-check]').forEach(cb => {
        if (cb.checked) {
          const idx = parseInt(cb.dataset.importCheck);
          if (result.entries[idx]) toImport.push(result.entries[idx]);
        }
      });
      if (toImport.length === 0) { showToast('Select entries to import', 'error'); return; }
      const nd = { ..._data };
      toImport.forEach(({ section, ...e }) => { if (nd[section]) nd[section] = [...nd[section], e]; });
      upd(nd);
      showToast('Imported ' + toImport.length + ' entries');
      container.innerHTML = '';
    });
  }

  // BibTeX file handling
  function renderImportTab(tab, dt) {
    const content = document.getElementById('cv-import-content');
    if (!content) return;
    if (tab === 'bibfiles') {
      content.innerHTML = `<div class="cv-card">
        <div class="cv-section-label" style="color:#86efac;margin-bottom:6px">Upload .bib Files</div>
        <div style="font-size:10px;color:${T.muted};font-family:inherit;margin-bottom:12px;line-height:1.6">Drop multiple .bib files. Sections auto-detected from filenames.</div>
        <div class="cv-drop-zone" id="cv-bib-drop">
          <input type="file" id="cv-bib-input" accept=".bib,.txt" multiple style="display:none">
          <div style="font-size:22px;color:${T.muted};margin-bottom:6px">\u25A4</div>
          <div style="font-size:12px;color:${T.mutedLight};font-family:inherit">Drop .bib files here or click to browse</div>
        </div>
        <div id="cv-bib-results"></div>
      </div>`;
      const drop = document.getElementById('cv-bib-drop');
      const input = document.getElementById('cv-bib-input');
      if (!drop || !input) return;
      drop.addEventListener('click', () => input.click());
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('active'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('active'));
      drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('active'); await handleBibFiles(e.dataTransfer.files); });
      input.addEventListener('change', async e => { if (e.target.files.length) await handleBibFiles(e.target.files); e.target.value = ''; });
    } else if (tab === 'bibtex') {
      content.innerHTML = `<div class="cv-card">
        <div class="cv-section-label" style="color:#86efac;margin-bottom:8px">BibTeX Import (paste)</div>
        <textarea class="cv-field" id="cv-bib-paste" rows="10" placeholder="@article{key2024,\n  author = {Smith, Jane},\n  title = {Amazing paper},\n  journal = {Nature},\n  year = {2024}\n}" style="font-size:11px;margin-bottom:10px"></textarea>
        <button class="cv-btn cv-btn-gold" id="cv-bib-parse">Parse BibTeX</button>
        <div id="cv-bib-paste-results"></div>
      </div>`;
      document.getElementById('cv-bib-parse')?.addEventListener('click', () => {
        const raw = document.getElementById('cv-bib-paste')?.value;
        if (!raw?.trim()) return;
        const entries = parseBibtex(raw);
        if (!entries.length) { showToast('No BibTeX entries found', 'error'); return; }
        showToast('Found ' + entries.length + ' entries');
        showImportResults({ profile: null, entries });
      });
    } else {
      // PDF tab - re-render
      content.innerHTML = renderImport().match(/<div id="cv-import-content">([\s\S]*?)<\/div>\s*<\/div>$/)?.[1] || '';
      // Simplified: just re-render the whole import panel
      const main = document.getElementById('cv-main');
      if (main) { main.innerHTML = renderImport(); wireImport(); }
    }
  }

  async function handleBibFiles(fileList) {
    const allEntries = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file.name.endsWith('.bib') && !file.name.endsWith('.txt')) continue;
      const text = await new Promise((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Read fail')); r.readAsText(file);
      });
      const detected = detectSectionFromFilename(file.name);
      const entries = parseBibtexWithContext(text, detected.section, detected.tag);
      allEntries.push(...entries);
    }
    if (!allEntries.length) { showToast('No entries found in .bib files', 'error'); return; }
    showToast('Parsed ' + allEntries.length + ' entries');
    showImportResults({ profile: null, entries: allEntries });
  }

  wireDocTypes();
  wirePDFDrop();
}

/* ── AI Assistant ──────────────────────────────────────────────── */
function renderAI() {
  const modes = {summary:'Summarize Abstract',impact:'Impact Statement',bio:'Research Bio',cover:'Cover Letter Para',keywords:'Extract Keywords'};
  let btns = '';
  for (const [k,v] of Object.entries(modes)) {
    btns += `<button class="cv-btn cv-ai-mode${k==='summary'?' active':''}" data-ai-mode="${k}" style="background:${k==='summary'?T.purple+'33':T.surface};border:1px solid ${k==='summary'?T.purple:T.border};color:${k==='summary'?T.cream:T.muted}">${v}</button>`;
  }
  return `<div class="cv-fade-up">
    <h2 class="cv-h2" style="margin-bottom:6px">AI Writing Assistant</h2>
    <div id="cv-ai-key-warn" style="background:${T.gold}0A;border:1px solid ${T.gold}33;padding:10px 14px;margin-bottom:14px;display:none;align-items:center;gap:8px">
      <span style="font-size:11px;color:${T.mutedLight};font-family:inherit;line-height:1.5">No API key configured. Add one in <strong style="color:${T.gold}">\u2699 Settings</strong>.</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">${btns}</div>
    <div class="cv-card" style="display:flex;flex-direction:column;gap:12px">
      <textarea class="cv-field" id="cv-ai-input" rows="7" placeholder="Paste abstract\u2026"></textarea>
      <button class="cv-btn cv-btn-gold" id="cv-ai-run" style="align-self:flex-start">Generate</button>
      <div id="cv-ai-result" style="display:none">
        <div class="cv-section-label" style="color:${T.purple};margin-bottom:8px">Result</div>
        <div id="cv-ai-output" style="background:${T.bg};border:1px solid ${T.border};padding:14px 16px;font-size:13px;color:${T.cream};font-family:inherit;line-height:1.8;white-space:pre-wrap"></div>
        <button class="cv-btn cv-btn-outline" id="cv-ai-copy" style="margin-top:8px">Copy</button>
      </div>
    </div>
  </div>`;
}

function wireAI() {
  let mode = 'summary';
  const prompts = {
    summary: t => 'Summarize this academic abstract in 2\u20133 clear sentences:\n\n' + t,
    impact: t => 'Write a 2\u20133 sentence broader impact statement for this work:\n\n' + t,
    bio: t => 'Write a professional 3rd-person academic bio (75\u2013100 words) based on:\n\n' + t,
    cover: t => 'Write one strong academic cover letter paragraph based on:\n\n' + t,
    keywords: t => 'Extract 8\u201312 academic keywords as a comma-separated list from:\n\n' + t,
  };

  // Check for API key
  const apiKey = _data?.profile?.anthropicKey || '';
  if (!apiKey) {
    const warn = document.getElementById('cv-ai-key-warn');
    if (warn) warn.style.display = 'flex';
  }

  document.querySelectorAll('.cv-ai-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.aiMode;
      document.querySelectorAll('.cv-ai-mode').forEach(b => {
        const active = b === btn;
        b.style.background = active ? T.purple+'33' : T.surface;
        b.style.borderColor = active ? T.purple : T.border;
        b.style.color = active ? T.cream : T.muted;
        b.classList.toggle('active', active);
      });
    });
  });

  document.getElementById('cv-ai-run')?.addEventListener('click', async () => {
    const input = document.getElementById('cv-ai-input')?.value?.trim();
    if (!input) return;
    const key = _data?.profile?.anthropicKey || '';
    const btn = document.getElementById('cv-ai-run');
    const resultDiv = document.getElementById('cv-ai-result');
    const output = document.getElementById('cv-ai-output');
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompts[mode](input) }] }),
      });
      const j = await res.json();
      if (j.error) { output.textContent = 'API Error: ' + j.error.message + (key ? '' : '\n\nTip: Go to \u2699 Settings to add your API key.'); }
      else { output.textContent = j.content?.map(b => b.text || '').join('') || 'No response.'; }
      resultDiv.style.display = 'block';
    } catch (e) { output.textContent = 'Error: ' + e.message; resultDiv.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Generate'; }
  });

  document.getElementById('cv-ai-copy')?.addEventListener('click', () => {
    const text = document.getElementById('cv-ai-output')?.textContent;
    if (text) navigator.clipboard.writeText(text).then(() => showToast('Copied'));
  });
}

/* ── CV Versions ───────────────────────────────────────────────── */
function renderVersions() {
  const versions = _data.cv_versions || [];
  let listHTML = '';
  if (versions.length === 0) {
    listHTML = `<div style="padding:28px 14px;color:${T.muted};font-family:inherit;font-size:11px;text-align:center">No versions yet.</div>`;
  } else {
    versions.forEach((v,i) => {
      listHTML += `<div class="cv-ver-item" data-cv-ver="${v._id}">
        <div style="font-size:12px;color:${T.mutedLight};font-family:inherit;margin-bottom:2px">${esc(v.name)}</div>
        <div style="font-size:9px;color:${T.muted};font-family:inherit">${new Date(v.created).toLocaleDateString()}</div>
      </div>`;
    });
  }
  return `<div class="cv-fade-up">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px;gap:10px;flex-wrap:wrap">
      <h2 class="cv-h2" style="margin-bottom:0">CV Versions</h2>
      <button class="cv-btn cv-btn-gold" id="cv-ver-new">+ New Version</button>
    </div>
    <div id="cv-ver-new-form" style="display:none" class="cv-card" style="margin-bottom:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="cv-field" id="cv-ver-name" placeholder="e.g. Tenure Review 2025" style="flex:1">
        <button class="cv-btn cv-btn-gold" id="cv-ver-create">Create</button>
      </div>
    </div>
    <div class="cv-ver-grid">
      <div class="cv-ver-list">${listHTML}</div>
      <div id="cv-ver-detail" style="background:${T.surface};border:1px solid ${T.border};display:flex;align-items:center;justify-content:center;color:${T.muted};font-family:inherit;font-size:11px">\u2190 Select a version</div>
    </div>
  </div>`;
}

function wireVersions() {
  document.getElementById('cv-ver-new')?.addEventListener('click', () => {
    const form = document.getElementById('cv-ver-new-form');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('cv-ver-create')?.addEventListener('click', () => {
    const name = document.getElementById('cv-ver-name')?.value?.trim();
    if (!name) return;
    const v = { _id: uid(), name, created: new Date().toISOString(), hiddenSections: [], hiddenEntries: {} };
    const nd = { ..._data, cv_versions: [...(_data.cv_versions||[]), v] };
    upd(nd);
    showToast('Version created');
  });
  document.querySelectorAll('[data-cv-ver]').forEach(el => {
    el.addEventListener('click', () => {
      const vId = el.dataset.cvVer;
      const ver = (_data.cv_versions||[]).find(v => v._id === vId);
      if (!ver) return;
      renderVersionDetail(ver);
      document.querySelectorAll('.cv-ver-item').forEach(e => e.classList.toggle('active', e.dataset.cvVer === vId));
    });
  });
}

function renderVersionDetail(ver) {
  const detail = document.getElementById('cv-ver-detail');
  if (!detail) return;
  let html = `<div style="padding:18px 20px;overflow:auto;height:100%">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div style="font-family:inherit;font-weight:700;font-size:17px;color:${T.cream}">${esc(ver.name)}</div>
      <button class="cv-btn cv-btn-danger" id="cv-ver-delete" data-ver-id="${ver._id}" style="padding:4px 12px">Delete</button>
    </div>`;
  for (const [k, label] of Object.entries(SECTION_LABELS)) {
    const hidden = (ver.hiddenSections || []).includes(k);
    const entries = _data[k] || [];
    const hiddenE = ver.hiddenEntries?.[k] || [];
    html += `<div style="margin-bottom:1px">
      <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:${hidden?T.bg:T.surfaceHover};border:1px solid ${T.border}">
        <input type="checkbox" ${!hidden?'checked':''} data-ver-sec="${k}" style="accent-color:${T.gold};width:13px;height:13px;cursor:pointer">
        <span style="flex:1;font-size:11px;color:${hidden?T.muted:T.cream};font-family:inherit">${label}</span>
        <span style="font-size:9px;color:${T.muted};font-family:inherit">${entries.length-hiddenE.length}/${entries.length}</span>
      </div>
      ${!hidden && entries.length > 0 ? `<div style="padding-left:22px;border-left:1px solid ${T.border}22;margin-left:12px">${
        entries.map(e => {
          const ih = hiddenE.includes(e._id);
          return `<div style="display:flex;align-items:center;gap:7px;padding:4px 10px;border-bottom:1px solid ${T.border}11">
            <input type="checkbox" ${!ih?'checked':''} data-ver-entry="${k}:${e._id}" style="accent-color:${T.gold};width:12px;height:12px;cursor:pointer">
            <span style="font-size:10px;color:${ih?T.muted:T.mutedLight};font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title||e.name||e.role||'Untitled')}${e.year?` <span style="color:${T.muted}">(${e.year})</span>`:''}</span>
          </div>`;
        }).join('')
      }</div>` : ''}
    </div>`;
  }
  html += '</div>';
  detail.innerHTML = html;

  // Wire section toggles
  document.querySelectorAll('[data-ver-sec]').forEach(cb => {
    cb.addEventListener('change', () => {
      const k = cb.dataset.verSec;
      const versions = (_data.cv_versions||[]).map(v => {
        if (v._id !== ver._id) return v;
        const hs = [...(v.hiddenSections||[])];
        if (cb.checked) { const idx = hs.indexOf(k); if (idx >= 0) hs.splice(idx, 1); }
        else if (!hs.includes(k)) hs.push(k);
        return { ...v, hiddenSections: hs };
      });
      upd({ ..._data, cv_versions: versions });
    });
  });
  // Wire entry toggles
  document.querySelectorAll('[data-ver-entry]').forEach(cb => {
    cb.addEventListener('change', () => {
      const [k, eId] = cb.dataset.verEntry.split(':');
      const versions = (_data.cv_versions||[]).map(v => {
        if (v._id !== ver._id) return v;
        const he = { ...v.hiddenEntries }; const arr = [...(he[k]||[])];
        if (cb.checked) { const idx = arr.indexOf(eId); if (idx >= 0) arr.splice(idx, 1); }
        else if (!arr.includes(eId)) arr.push(eId);
        he[k] = arr;
        return { ...v, hiddenEntries: he };
      });
      upd({ ..._data, cv_versions: versions });
    });
  });
  // Wire delete
  document.getElementById('cv-ver-delete')?.addEventListener('click', () => {
    if (!confirm('Delete this version?')) return;
    const nd = { ..._data, cv_versions: (_data.cv_versions||[]).filter(v => v._id !== ver._id) };
    upd(nd);
    showToast('Version deleted');
  });
}

/* ── Export & Share ─────────────────────────────────────────────── */
function renderExport() {
  const versions = _data.cv_versions || [];
  let verOpts = '<option value="__all__">Full CV \u2014 all entries</option>';
  versions.forEach(v => { verOpts += `<option value="${v._id}">${esc(v.name)}</option>`; });
  return `<div class="cv-fade-up">
    <h2 class="cv-h2" style="margin-bottom:6px">Export & Share</h2>
    <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:20px">PDF, LaTeX source, and BibTeX \u2014 all ready to use.</p>
    <div class="cv-card" style="margin-bottom:1px">
      <div class="cv-section-label" style="color:${T.muted};margin-bottom:8px">CV Version</div>
      <select class="cv-field" id="cv-export-ver" style="max-width:340px">${verOpts}</select>
    </div>
    <div class="cv-tab-strip">
      <button class="cv-tab-btn active" data-cv-export-tab="pdf">\u2399 PDF</button>
      <button class="cv-tab-btn" data-cv-export-tab="latex">\u2211 LaTeX</button>
      <button class="cv-tab-btn" data-cv-export-tab="bibtex">\u25A4 BibTeX</button>
      <button class="cv-tab-btn" data-cv-export-tab="text">\u2261 Plain Text</button>
    </div>
    <div id="cv-export-content">
      ${renderExportPDF()}
    </div>
  </div>`;
}

function renderExportPDF() {
  const TPLS = {classic:'Classic Academic',modern:'Modern Two-Column',nsf:'NSF Biosketch'};
  let html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">';
  for (const [k,name] of Object.entries(TPLS)) {
    html += `<div class="cv-export-tpl${k==='classic'?' active':''}" data-tpl="${k}" style="border:2px solid ${k==='classic'?T.gold:T.border};background:${k==='classic'?T.gold+'0A':T.surface};padding:14px 16px;cursor:pointer;transition:all .15s">
      <div style="font-size:13px;color:${k==='classic'?T.gold:T.cream};font-family:inherit;margin-bottom:5px">${name}</div>
    </div>`;
  }
  html += `</div><button class="cv-btn cv-btn-gold" id="cv-export-pdf-btn">\u2399 Open PDF Preview</button>`;
  html += `<div style="font-size:10px;color:${T.muted};font-family:inherit;line-height:1.7;margin-top:12px">Opens in a new window. Press <strong style="color:${T.cream}">Cmd+P / Ctrl+P</strong> then "Save as PDF".</div>`;
  return html;
}

function wireExport() {
  let pdfTemplate = 'classic';
  let currentTab = 'pdf';

  // Tab switching
  document.querySelectorAll('[data-cv-export-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.cvExportTab;
      document.querySelectorAll('[data-cv-export-tab]').forEach(b => b.classList.toggle('active', b === btn));
      const content = document.getElementById('cv-export-content');
      if (!content) return;
      if (currentTab === 'pdf') { content.innerHTML = renderExportPDF(); wirePDFExport(); }
      else if (currentTab === 'latex') { renderLatexExport(content); }
      else if (currentTab === 'bibtex') { renderBibtexExport(content); }
      else if (currentTab === 'text') { renderTextExport(content); }
    });
  });

  function getSelVer() {
    const v = document.getElementById('cv-export-ver')?.value;
    return v && v !== '__all__' ? (_data.cv_versions||[]).find(ver => ver._id === v) : null;
  }

  function wirePDFExport() {
    document.querySelectorAll('.cv-export-tpl').forEach(el => {
      el.addEventListener('click', () => {
        pdfTemplate = el.dataset.tpl;
        document.querySelectorAll('.cv-export-tpl').forEach(e => {
          const active = e === el;
          e.style.borderColor = active ? T.gold : T.border;
          e.style.background = active ? T.gold+'0A' : T.surface;
          e.classList.toggle('active', active);
        });
      });
    });
    document.getElementById('cv-export-pdf-btn')?.addEventListener('click', () => {
      const html = buildCVHTML(_data, getSelVer(), pdfTemplate);
      const w = window.open('', '_blank', 'width=860,height=1100');
      w.document.open(); w.document.write(html); w.document.close();
    });
  }

  function renderLatexExport(container) {
    const code = generateModernCV(_data, getSelVer());
    container.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button class="cv-btn cv-btn-gold" id="cv-copy-latex">Copy .tex Source</button>
      <button class="cv-btn cv-btn-outline" id="cv-dl-latex">Download .tex File</button>
    </div><div class="cv-latex-block">${esc(code)}</div>`;
    document.getElementById('cv-copy-latex')?.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => showToast('Copied'));
    });
    document.getElementById('cv-dl-latex')?.addEventListener('click', () => {
      const blob = new Blob([code], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'cv-' + (_data.profile.name||'cv').replace(/\s/g,'_').toLowerCase() + '.tex'; a.click();
    });
  }

  function renderBibtexExport(container) {
    const code = generateBibTeX(_data);
    container.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <button class="cv-btn cv-btn-gold" id="cv-copy-bib">Copy .bib</button>
      <button class="cv-btn cv-btn-outline" id="cv-dl-bib">Download .bib File</button>
    </div><div class="cv-latex-block">${esc(code) || '% No entries found.'}</div>`;
    document.getElementById('cv-copy-bib')?.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => showToast('Copied'));
    });
    document.getElementById('cv-dl-bib')?.addEventListener('click', () => {
      const blob = new Blob([code], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = (_data.profile.name||'cv').replace(/\s/g,'_').toLowerCase() + '.bib'; a.click();
    });
  }

  function renderTextExport(container) {
    const selVer = getSelVer();
    const lines = [_data.profile.name||'[Name]', [_data.profile.title,_data.profile.department,_data.profile.institution].filter(Boolean).join(' | '), [_data.profile.email,_data.profile.phone,_data.profile.website].filter(Boolean).join(' | '), _data.profile.bio ? '\n'+_data.profile.bio : null,
      ...Object.keys(SECTION_LABELS).filter(k => !selVer?.hiddenSections?.includes(k)).map(k => { let e = (_data[k]||[]).filter(x => !selVer?.hiddenEntries?.[k]?.includes(x._id)).sort((a,b)=>(b.year||0)-(a.year||0)); if (!e.length) return null; return `\n${'─'.repeat(56)}\n${SECTION_LABELS[k].toUpperCase()}\n${'─'.repeat(56)}\n${e.map((x,i)=>`${i+1}. ${x.title||x.name||x.role||''} (${x.year||x.date||''})`).join('\n')}`; })].filter(Boolean).join('\n');
    container.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="cv-btn cv-btn-gold" id="cv-copy-text">Copy Plain Text</button>
    </div><div style="font-size:11px;color:${T.muted};font-family:inherit;line-height:1.6">ATS-optimized plain text for application portals.</div>`;
    document.getElementById('cv-copy-text')?.addEventListener('click', () => {
      navigator.clipboard.writeText(lines).then(() => showToast('Copied'));
    });
  }

  wirePDFExport();
}

/* ── Citation Tracker ──────────────────────────────────────────── */
function renderCitations() {
  const meta = _data.citation_meta || {};
  const papersWithDOI = [..._data.journals, ..._data.conferences].filter(e => e.doi);
  const topCited = _data.journals.filter(j=>j.citations).sort((a,b)=>Number(b.citations)-Number(a.citations)).slice(0,5);
  const log = meta.log || [];
  let topHTML = '';
  topCited.forEach((e,i) => {
    topHTML += `<div style="display:flex;gap:12px;padding:9px 0;${i<topCited.length-1?'border-bottom:1px solid '+T.border:''}align-items:center">
      <div style="width:36px;height:36px;background:${T.gold}15;border:1px solid ${T.gold}33;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span style="font-family:inherit;font-weight:700;font-size:16px;color:${T.gold}">${e.citations}</span>
      </div>
      <div style="flex:1;min-width:0"><div style="font-size:12px;color:${T.cream};font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title)}</div><div style="font-size:10px;color:${T.muted};font-family:inherit">${esc(e.journal||'')} \u00B7 ${e.year||''}</div></div>
    </div>`;
  });
  let logHTML = '';
  if (log.length === 0) logHTML = `<div style="font-size:11px;color:${T.muted};font-family:inherit">No updates yet. Run an update to begin.</div>`;
  else log.forEach((l,i) => {
    logHTML += `<div style="padding:9px 12px;${i<log.length-1?'border-bottom:1px solid '+T.border:''}background:${T.surface};display:flex;gap:10px;align-items:center">
      <div style="flex:1;min-width:0"><div style="font-size:11px;color:${T.cream};font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.title||'')}</div><div style="font-size:9px;color:${T.muted};font-family:inherit;margin-top:2px">${new Date(l.ts).toLocaleDateString()}</div></div>
      <span style="font-size:12px;color:${T.muted};font-family:inherit">${l.old}</span>
      <span style="font-size:10px;color:${T.muted}">\u2192</span>
      <span style="font-size:13px;color:${l.delta>0?T.green:T.red};font-family:inherit;font-weight:700">${l.new}</span>
      <span class="cv-chip" style="background:${(l.delta>0?T.green:T.red)}22;color:${l.delta>0?T.green:T.red};border:1px solid ${(l.delta>0?T.green:T.red)}44">${l.delta>0?'+':''}${l.delta}</span>
    </div>`;
  });

  return `<div class="cv-fade-up">
    <h2 class="cv-h2">Citation Tracker</h2>
    <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:22px;line-height:1.6">Auto-fetch citation counts via CrossRef. ${papersWithDOI.length} papers eligible.</p>
    <div class="cv-card" style="margin-bottom:1px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><div class="cv-section-label" style="color:${T.muted};margin-bottom:4px">Last Updated</div><div style="font-size:12px;color:${meta.lastRun?T.cream:T.muted};font-family:inherit">${meta.lastRun?new Date(meta.lastRun).toLocaleString():'Never'}</div></div>
        <button class="cv-btn cv-btn-gold" id="cv-cit-run" ${papersWithDOI.length===0?'disabled':''}>&#9654; Run Now</button>
      </div>
      <div id="cv-cit-progress" style="display:none;margin-top:14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:10px;color:${T.muted};font-family:inherit">Fetching citation data\u2026</span>
          <span id="cv-cit-pct" style="font-size:10px;color:${T.gold};font-family:inherit">0%</span>
        </div>
        <div class="cv-bar-track"><div class="cv-bar-fill" id="cv-cit-bar" style="width:0%"></div></div>
      </div>
    </div>
    ${topCited.length?`<div class="cv-card" style="margin-bottom:1px"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Top Cited Papers</div>${topHTML}</div>`:''}
    <div class="cv-card"><div class="cv-section-label" style="color:${T.muted};margin-bottom:14px">Update Log</div>${log.length?`<div style="border:1px solid ${T.border}">${logHTML}</div>`:logHTML}</div>
  </div>`;
}

function wireCitations() {
  document.getElementById('cv-cit-run')?.addEventListener('click', async () => {
    const papersWithDOI = [..._data.journals, ..._data.conferences].filter(e => e.doi);
    if (!papersWithDOI.length) return;
    const btn = document.getElementById('cv-cit-run');
    const progress = document.getElementById('cv-cit-progress');
    const pct = document.getElementById('cv-cit-pct');
    const bar = document.getElementById('cv-cit-bar');
    btn.disabled = true; btn.textContent = 'Updating\u2026'; progress.style.display = 'block';
    const newLog = []; let updatedCount = 0;
    const nd = { ..._data, journals: [..._data.journals], conferences: [..._data.conferences] };
    for (let i = 0; i < papersWithDOI.length; i++) {
      const paper = papersWithDOI[i];
      const p = Math.round(((i+1)/papersWithDOI.length)*100);
      pct.textContent = p + '%'; bar.style.width = p + '%';
      try {
        const count = await fetchCitationCount(paper.doi);
        if (count !== null) {
          const oldCount = Number(paper.citations) || 0;
          const delta = count - oldCount;
          if (delta !== 0) {
            updatedCount++;
            newLog.push({ title:(paper.title||'').slice(0,60)+(paper.title?.length>60?'\u2026':''), old:oldCount, new:count, delta, doi:paper.doi, ts:new Date().toISOString() });
            const sec = _data.journals.find(j=>j._id===paper._id) ? 'journals' : 'conferences';
            nd[sec] = nd[sec].map(e => e._id === paper._id ? { ...e, citations: count } : e);
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 350));
    }
    const now = new Date().toISOString();
    const allLog = [...newLog, ...(_data.citation_meta?.log||[])].slice(0,50);
    nd.citation_meta = { lastRun: now, log: allLog, autoInterval: _data.citation_meta?.autoInterval || 'off' };
    upd(nd);
    showToast(updatedCount > 0 ? 'Updated ' + updatedCount + ' citation counts' : 'All counts are current');
  });
}

/* ── ORCID Sync ────────────────────────────────────────────────── */
function renderORCID() {
  return `<div class="cv-fade-up">
    <h2 class="cv-h2">ORCID Sync <span style="color:#86efac">\u2295</span></h2>
    <div class="cv-card" style="margin-bottom:1px">
      <div class="cv-section-label" style="color:#86efac;margin-bottom:10px">Your ORCID iD</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="cv-field" id="cv-orcid-input" value="${esc(_data.profile.orcid||'')}" placeholder="0000-0000-0000-0000" style="flex:1">
        <button class="cv-btn" id="cv-orcid-fetch" style="background:var(--accent,#5baed1);color:#031a16;font-weight:600">Fetch Works</button>
      </div>
    </div>
    <div id="cv-orcid-results"></div>
  </div>`;
}

function wireORCID() {
  document.getElementById('cv-orcid-fetch')?.addEventListener('click', async () => {
    const orcid = document.getElementById('cv-orcid-input')?.value?.trim();
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) { showToast('Enter valid ORCID', 'error'); return; }
    const btn = document.getElementById('cv-orcid-fetch');
    btn.disabled = true; btn.textContent = 'Fetching\u2026';
    try {
      const res = await fetch('https://pub.orcid.org/v3.0/' + orcid + '/works', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('API error ' + res.status);
      const j = await res.json();
      const works = (j.group||[]).flatMap(g => (g['work-summary']||[]).slice(0,1)).map(w => ({
        _id: uid(), title: w.title?.title?.value||'', year: w['publication-date']?.year?.value||'',
        type_raw: w.type||'', journal: w['journal-title']?.value||'',
        doi: (w['external-ids']?.['external-id']||[]).find(x => x['external-id-type']==='doi')?.['external-id-value']||''
      }));
      renderORCIDResults(works);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Fetch Works'; }
  });
}

function renderORCIDResults(works) {
  const container = document.getElementById('cv-orcid-results');
  if (!container) return;
  let html = `<div class="cv-fade-up cv-card" style="margin-top:1px">
    <div class="cv-section-label" style="color:#86efac;margin-bottom:12px">${works.length} Works Found</div>
    <div style="border:1px solid ${T.border};max-height:300px;overflow:auto;margin-bottom:14px">`;
  works.forEach((w,i) => {
    html += `<div style="display:flex;gap:10px;padding:10px 12px;${i<works.length-1?'border-bottom:1px solid '+T.border:''}background:${T.surface};align-items:flex-start">
      <input type="checkbox" checked data-orcid-idx="${i}" style="accent-color:#86efac;width:13px;height:13px;margin-top:2px;cursor:pointer;flex-shrink:0">
      <div style="flex:1;min-width:0"><div style="font-size:12px;color:${T.cream};font-family:inherit">${esc(w.title||'Untitled')}</div><div style="font-size:10px;color:${T.muted};font-family:inherit">${[w.journal,w.year].filter(Boolean).join(' \u00B7 ')}</div></div>
    </div>`;
  });
  html += `</div><button class="cv-btn" id="cv-orcid-import" style="background:var(--accent,#5baed1);color:#031a16;font-weight:600">Import Selected \u2192</button></div>`;
  container.innerHTML = html;

  document.getElementById('cv-orcid-import')?.addEventListener('click', () => {
    const toImport = [];
    document.querySelectorAll('[data-orcid-idx]').forEach(cb => {
      if (!cb.checked) return;
      const w = works[parseInt(cb.dataset.orcidIdx)];
      if (!w) return;
      const t = w.type_raw.toLowerCase();
      const base = { _id: uid(), title: w.title, year: w.year, doi: w.doi, authors: '', status: 'Published' };
      if (t.includes('conference')) toImport.push({ section:'conferences', ...base, conference: w.journal });
      else toImport.push({ section:'journals', ...base, journal: w.journal });
    });
    if (!toImport.length) return;
    const nd = { ..._data };
    toImport.forEach(({ section, ...e }) => { if (nd[section]) nd[section] = [...nd[section], e]; });
    upd(nd);
    showToast('Imported ' + toImport.length + ' works');
    container.innerHTML = '';
  });
}

/* ── Settings ──────────────────────────────────────────────────── */
function renderSettings() {
  const key = _data.profile?.anthropicKey || '';
  return `<div class="cv-fade-up">
    <h2 class="cv-h2" style="margin-bottom:6px">Settings</h2>
    <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:22px;line-height:1.7">Configure your API key for the AI Writing Assistant.</p>
    <div class="cv-card" style="margin-bottom:1px">
      <div class="cv-section-label" style="color:${T.purple};margin-bottom:12px">Anthropic API Key</div>
      <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:12px;line-height:1.7">Get a key at <span style="color:${T.gold}">console.anthropic.com</span>. Stored in your Firestore profile.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <input type="password" class="cv-field" id="cv-api-key" value="${esc(key)}" placeholder="sk-ant-api03-\u2026" style="flex:1;min-width:200px">
        <button class="cv-btn cv-btn-gold" id="cv-api-save">Save Key</button>
        ${key ? `<button class="cv-btn cv-btn-danger" id="cv-api-clear">Clear</button>` : ''}
      </div>
      ${key ? `<div style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${T.green};display:inline-block"></span><span style="font-size:10px;color:${T.green};font-family:inherit">API key saved</span></div>` : ''}
    </div>
    <div class="cv-card">
      <div class="cv-section-label" style="color:${T.muted};margin-bottom:12px">Data Backup</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="cv-btn cv-btn-outline" id="cv-backup-dl">\u2B07 Download Backup</button>
        <label class="cv-btn cv-btn-outline" style="cursor:pointer">\u2B06 Restore from Backup<input type="file" id="cv-backup-restore" accept=".json" style="display:none"></label>
      </div>
    </div>
    <div class="cv-card">
      <div class="cv-section-label" style="color:${T.accent};margin-bottom:12px">Profile Sync</div>
      <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:12px;line-height:1.7">Push all CV data (publications, patents, presentations, posters) to your public team profile. This updates citations, years, and metadata shown on the Team page.</p>
      <button class="cv-btn cv-btn-gold" id="cv-resync-profile">\u21BB Re-sync to Profile</button>
      <span id="cv-resync-status" style="font-size:10px;color:${T.muted};font-family:inherit;margin-left:8px"></span>
    </div>
    <div class="cv-card" style="border-color:rgba(185,28,28,.25)">
      <div class="cv-section-label" style="color:${T.red};margin-bottom:12px">Danger Zone</div>
      <p style="font-size:11px;color:${T.muted};font-family:inherit;margin-bottom:12px;line-height:1.7">Permanently delete <strong style="color:${T.red}">all</strong> CV data including profile, publications, grants, presentations, students, and all other entries. This cannot be undone.</p>
      <button class="cv-btn cv-btn-danger" id="cv-reset-all">\u26A0 Reset All Data</button>
    </div>
  </div>`;
}

function wireSettings() {
  document.getElementById('cv-api-save')?.addEventListener('click', () => {
    const key = document.getElementById('cv-api-key')?.value?.trim();
    const nd = { ..._data, profile: { ..._data.profile, anthropicKey: key } };
    upd(nd);
    showToast('API key saved');
  });
  document.getElementById('cv-api-clear')?.addEventListener('click', () => {
    const nd = { ..._data, profile: { ..._data.profile, anthropicKey: '' } };
    upd(nd);
    showToast('API key cleared');
  });
  document.getElementById('cv-backup-dl')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(_data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'cv-backup-' + new Date().toISOString().slice(0,10) + '.json'; a.click();
  });
  document.getElementById('cv-backup-restore')?.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        upd({ ...mkDefault(), ...imported });
        showToast('Backup restored');
      } catch { showToast('Invalid backup file', 'error'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('cv-resync-profile')?.addEventListener('click', async () => {
    const btn = document.getElementById('cv-resync-profile');
    const status = document.getElementById('cv-resync-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Syncing\u2026';
    try {
      await McgheeLab.DB.syncCVToProfile(McgheeLab.Auth.currentUser.uid, _data);
      if (status) status.textContent = '\u2713 Synced';
      if (status) status.style.color = T.green;
      showToast('CV data synced to profile');
    } catch (e) {
      if (status) status.textContent = 'Failed';
      if (status) status.style.color = T.red;
      showToast('Sync failed: ' + (e.message || e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById('cv-reset-all')?.addEventListener('click', () => {
    if (!confirm('Are you sure you want to delete ALL CV data? This cannot be undone.')) return;
    if (!confirm('This will permanently erase your profile, all publications, grants, presentations, students, awards, and every other entry. Continue?')) return;
    upd(mkDefault());
    _sec = 'dashboard';
    renderCurrentSection();
    showToast('All data has been reset');
  });
}

/* ══════════════════════════════════════════════════════════════════
   WIRE: MAIN SHELL (called by app.js after render)
   ══════════════════════════════════════════════════════════════════ */
async function wireCV() {
  const user = McgheeLab.Auth?.currentUser;
  const profile = McgheeLab.Auth?.currentProfile;
  if (!user || profile?.role === 'guest') {
    const main = document.getElementById('cv-main');
    if (main) main.innerHTML = `<div style="text-align:center;padding:60px 20px;color:${T.muted};font-family:inherit"><div style="font-size:48px;margin-bottom:16px">\u25C8</div><div style="font-size:14px;margin-bottom:8px">CV Builder</div><div style="font-size:11px">Sign in to build and manage your academic CV.</div></div>`;
    return;
  }

  // Load CV data from Firestore
  try {
    let data = await McgheeLab.DB.getCVData(user.uid);
    if (!data) {
      // Initialize with defaults, pre-populate from user profile
      data = mkDefault();
      if (profile) {
        data.profile.name = profile.name || '';
        data.profile.email = profile.email || '';
        data.profile.bio = profile.bio || '';
      }
    }
    setData({ ...mkDefault(), ...data });

    // If profile has associations but CV is empty, auto-import them
    if (profile) {
      if (profile.papers?.length && !_data.journals.length) {
        _data.journals = profile.papers.map(p => ({ _id: uid(), title: p.title||'', doi: (p.url||'').replace('https://doi.org/',''), authors: '', year: '', journal: '', status: 'Published' }));
      }
      if (profile.presentations?.length && !_data.presentations.length) {
        _data.presentations = profile.presentations.map(p => ({ _id: uid(), title: p.title||'', event: '', date: '', type: 'Contributed Talk' }));
      }
      if (profile.patents?.length && !_data.patents.length) {
        _data.patents = profile.patents.map(p => ({ _id: uid(), title: p.title||'', number: p.url||'', inventors: '', status: 'Granted' }));
      }
    }
  } catch (e) {
    console.error('Error loading CV data:', e);
    setData(mkDefault());
  }

  // Build nav
  const desktopNav = document.getElementById('cv-desktop-nav');
  const mobileNav = document.getElementById('cv-mobile-nav');
  const navHTML = buildNavHTML();
  if (desktopNav) desktopNav.innerHTML = navHTML;
  if (mobileNav) mobileNav.innerHTML = navHTML;

  // Wire nav clicks (event delegation)
  document.getElementById('cv-app')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-cv-sec]');
    if (btn) goTo(btn.dataset.cvSec);
  });

  // Mobile menu
  document.getElementById('cv-mobile-menu-btn')?.addEventListener('click', () => {
    document.getElementById('cv-mobile-overlay')?.classList.add('open');
    document.getElementById('cv-mobile-drawer')?.classList.add('open');
  });
  document.getElementById('cv-mobile-close-btn')?.addEventListener('click', () => {
    document.getElementById('cv-mobile-overlay')?.classList.remove('open');
    document.getElementById('cv-mobile-drawer')?.classList.remove('open');
  });
  document.getElementById('cv-mobile-overlay')?.addEventListener('click', () => {
    document.getElementById('cv-mobile-overlay')?.classList.remove('open');
    document.getElementById('cv-mobile-drawer')?.classList.remove('open');
  });

  // Render initial section
  _sec = 'dashboard';
  renderCurrentSection();
}

/* ══════════════════════════════════════════════════════════════════
   EXPORTS
   ══════════════════════════════════════════════════════════════════ */
McgheeLab.renderCV = renderCV;
McgheeLab.wireCV   = wireCV;
window.McgheeLab   = McgheeLab;

})();
