/* cv-schemas.js — shared CV section schemas.
 * Must stay in sync with the McGheeLabWebsite cv-builder.js SCHEMAS object
 * so entries created here are readable/editable on the public-site app and
 * vice-versa. The section keys + field keys are the Firestore contract.
 *
 * Document shape in Firestore: cvData/{uid} = {
 *   profile: {...},
 *   journals: [ { _id, ...fields } ],   // one array per section below
 *   conferences: [...], books: [...], patents: [...], presentations: [...],
 *   grants: [...], students: [...], awards: [...], service: [...],
 *   courses: [...], software: [...],
 *   updatedAt: <server timestamp>
 * }
 */

var CV_SECTION_KEYS = [
  'journals', 'conferences', 'books', 'patents', 'presentations',
  'grants', 'awards', 'service', 'students', 'courses', 'software',
];

var CV_SECTION_LABELS = {
  journals: 'Journal Papers',
  conferences: 'Conference Papers',
  books: 'Books & Chapters',
  patents: 'Patents',
  presentations: 'Presentations',
  grants: 'Grants & Funding',
  awards: 'Awards & Honors',
  service: 'Service & Editorial',
  students: 'Students Supervised',
  courses: 'Courses Taught',
  software: 'Software & Datasets',
};

var CV_SECTION_GROUPS = [
  { label: 'Overview',     keys: ['profile'] },
  { label: 'Publications', keys: ['journals', 'conferences', 'books'] },
  { label: 'Research',     keys: ['patents', 'grants', 'software'] },
  { label: 'Activities',   keys: ['presentations', 'awards', 'service'] },
  { label: 'Teaching',     keys: ['students', 'courses'] },
];

var CV_SECTION_LABELS_EXT = Object.assign({ profile: 'Profile' }, CV_SECTION_LABELS);

var CV_PROFILE_FIELDS = [
  { key: 'name',        label: 'Name',        type: 'text' },
  { key: 'title',       label: 'Title',       type: 'text' },
  { key: 'institution', label: 'Institution', type: 'text' },
  { key: 'department',  label: 'Department',  type: 'text' },
  { key: 'email',       label: 'Email',       type: 'text' },
  { key: 'phone',       label: 'Phone',       type: 'text' },
  { key: 'website',     label: 'Website',     type: 'text' },
  { key: 'orcid',       label: 'ORCID iD',    type: 'text', hint: '0000-0000-0000-0000' },
  { key: 'scholar',     label: 'Google Scholar', type: 'text' },
  { key: 'address',     label: 'Address',     type: 'text' },
  { key: 'bio',         label: 'Bio',         type: 'textarea' },
];

var CV_SCHEMAS = {
  journals: { fields: [
    { key:'title', label:'Title', type:'text', span:2, required:true },
    { key:'authors', label:'Authors', type:'text', span:2, required:true, hint:'Smith J, Doe A, ...' },
    { key:'journal', label:'Journal', type:'text', required:true },
    { key:'year', label:'Year', type:'number', required:true },
    { key:'doi', label:'DOI', type:'text', span:2 },
    { key:'volume', label:'Volume', type:'text' },
    { key:'issue', label:'Issue', type:'text' },
    { key:'pages', label:'Pages', type:'text' },
    { key:'impact_factor', label:'Impact Factor', type:'number' },
    { key:'quartile', label:'Quartile', type:'select', options:['','Q1','Q2','Q3','Q4'] },
    { key:'citations', label:'Citations', type:'number' },
    { key:'status', label:'Status', type:'select', options:['Published','In Press','Under Review','Submitted','In Preparation'] },
    { key:'abstract', label:'Abstract', type:'textarea', span:2 },
    { key:'keywords', label:'Keywords', type:'text', span:2, hint:'comma separated' },
  ]},
  conferences: { fields: [
    { key:'title', label:'Title', type:'text', span:2, required:true },
    { key:'authors', label:'Authors', type:'text', span:2, required:true },
    { key:'conference', label:'Conference', type:'text', required:true },
    { key:'year', label:'Year', type:'number', required:true },
    { key:'location', label:'Location', type:'text' },
    { key:'doi', label:'DOI', type:'text' },
    { key:'pages', label:'Pages', type:'text' },
    { key:'type', label:'Type', type:'select', options:['Oral','Poster','Invited Talk','Keynote','Workshop'] },
    { key:'status', label:'Status', type:'select', options:['Published','Accepted','Submitted'] },
    { key:'abstract', label:'Abstract', type:'textarea', span:2 },
  ]},
  books: { fields: [
    { key:'title', label:'Title', type:'text', span:2, required:true },
    { key:'authors', label:'Authors', type:'text', span:2 },
    { key:'editors', label:'Editors', type:'text', span:2 },
    { key:'role', label:'My Role', type:'select', options:['Author','Co-Author','Editor','Co-Editor','Chapter Author'] },
    { key:'chapter', label:'Chapter Title', type:'text', span:2 },
    { key:'publisher', label:'Publisher', type:'text', required:true },
    { key:'year', label:'Year', type:'number', required:true },
    { key:'edition', label:'Edition', type:'text' },
    { key:'isbn', label:'ISBN', type:'text' },
    { key:'pages', label:'Pages', type:'text' },
    { key:'doi', label:'DOI', type:'text' },
  ]},
  patents: { fields: [
    { key:'number', label:'Patent Number', type:'text', required:true },
    { key:'title', label:'Title', type:'text', span:2, required:true },
    { key:'inventors', label:'Inventors', type:'text', span:2, required:true },
    { key:'assignee', label:'Assignee', type:'text' },
    { key:'filing_date', label:'Filing Date', type:'date' },
    { key:'grant_date', label:'Grant Date', type:'date' },
    { key:'country', label:'Country', type:'text' },
    { key:'status', label:'Status', type:'select', options:['Granted','Pending','Published','Abandoned'] },
    { key:'description', label:'Description', type:'textarea', span:2 },
  ]},
  presentations: { fields: [
    { key:'title', label:'Title', type:'text', span:2, required:true },
    { key:'event', label:'Event / Venue', type:'text', required:true },
    { key:'location', label:'Location', type:'text' },
    { key:'date', label:'Date', type:'date', required:true },
    { key:'type', label:'Type', type:'select', options:['Invited Talk','Keynote','Contributed Talk','Seminar','Webinar','Panel','Workshop'] },
    { key:'audience', label:'Audience', type:'select', options:['International','National','Regional','Local','Institutional'] },
    { key:'slides_url', label:'Slides URL', type:'text', span:2 },
    { key:'notes', label:'Notes', type:'textarea', span:2 },
  ]},
  grants: { fields: [
    { key:'title', label:'Grant Title', type:'text', span:2, required:true },
    { key:'agency', label:'Agency', type:'text', required:true },
    { key:'role', label:'My Role', type:'select', options:['PI','Co-PI','Co-I','Collaborator','Consultant'] },
    { key:'amount', label:'Amount (USD)', type:'number' },
    { key:'start_date', label:'Start Date', type:'date' },
    { key:'end_date', label:'End Date', type:'date' },
    { key:'status', label:'Status', type:'select', options:['Active','Completed','Pending','Submitted','Not Funded'] },
    { key:'grant_id', label:'Grant ID', type:'text' },
    { key:'description', label:'Description', type:'textarea', span:2 },
  ]},
  students: { fields: [
    { key:'name', label:'Student Name', type:'text', required:true },
    { key:'degree', label:'Degree', type:'select', options:['BSc','MSc','PhD','PostDoc','Visiting Researcher'] },
    { key:'thesis_title', label:'Thesis / Project', type:'text', span:2 },
    { key:'start_year', label:'Start Year', type:'number', required:true },
    { key:'end_year', label:'End Year', type:'number' },
    { key:'status', label:'Status', type:'select', options:['Current','Graduated','Withdrawn'] },
    { key:'current_position', label:'Current Position', type:'text', span:2 },
    { key:'co_supervisor', label:'Co-Supervisor', type:'text' },
    { key:'notes', label:'Notes', type:'textarea', span:2 },
  ]},
  awards: { fields: [
    { key:'title', label:'Award Title', type:'text', span:2, required:true },
    { key:'awarding_body', label:'Awarding Body', type:'text', required:true },
    { key:'year', label:'Year', type:'number', required:true },
    { key:'category', label:'Category', type:'select', options:['Research','Teaching','Service','Fellowship','Prize','Recognition','Other'] },
    { key:'description', label:'Description', type:'textarea', span:2 },
  ]},
  service: { fields: [
    { key:'role', label:'Role', type:'text', required:true },
    { key:'organization', label:'Organization', type:'text', required:true },
    { key:'type', label:'Type', type:'select', options:['Journal Editor','Associate Editor','Reviewer','Editorial Board','Committee','Program Chair','Organizing Committee','Advisory Board','Department','University','Professional Society','Other'] },
    { key:'start_year', label:'Start Year', type:'number' },
    { key:'end_year', label:'End Year', type:'number' },
    { key:'ongoing', label:'Ongoing', type:'checkbox' },
    { key:'description', label:'Notes', type:'textarea', span:2 },
  ]},
  courses: { fields: [
    { key:'name', label:'Course Name', type:'text', required:true },
    { key:'code', label:'Code', type:'text' },
    { key:'level', label:'Level', type:'select', options:['Undergraduate','Postgraduate','PhD','Executive'] },
    { key:'role', label:'Role', type:'select', options:['Instructor','Co-Instructor','Guest Lecturer','Teaching Assistant'] },
    { key:'semester', label:'Semester', type:'select', options:['Fall','Spring','Summer','Full Year'] },
    { key:'year', label:'Year', type:'number' },
    { key:'enrollment', label:'Enrollment', type:'number' },
    { key:'institution', label:'Institution', type:'text' },
    { key:'description', label:'Description', type:'textarea', span:2 },
  ]},
  software: { fields: [
    { key:'name', label:'Name', type:'text', required:true },
    { key:'description', label:'Description', type:'text', span:2 },
    { key:'type', label:'Type', type:'select', options:['Software','Dataset','Algorithm','Library','Tool','Other'] },
    { key:'url', label:'URL / Repo', type:'text', span:2 },
    { key:'doi', label:'DOI', type:'text' },
    { key:'language', label:'Language', type:'text' },
    { key:'license', label:'License', type:'text' },
    { key:'year', label:'Year', type:'number' },
  ]},
};

/* Primary display fields for the list view (title + meta). */
var CV_DISPLAY = {
  journals:      { title: 'title',        meta: ['authors', 'journal'], year: 'year' },
  conferences:   { title: 'title',        meta: ['authors', 'conference'], year: 'year' },
  books:         { title: 'title',        meta: ['authors', 'publisher'], year: 'year' },
  patents:       { title: 'title',        meta: ['number', 'inventors'], year: null },
  presentations: { title: 'title',        meta: ['event', 'location'], year: 'date' },
  grants:        { title: 'title',        meta: ['agency', 'role'], year: 'start_date' },
  awards:        { title: 'title',        meta: ['awarding_body', 'category'], year: 'year' },
  service:       { title: 'role',         meta: ['organization', 'type'], year: 'start_year' },
  students:      { title: 'name',         meta: ['degree', 'thesis_title'], year: 'start_year' },
  courses:       { title: 'name',         meta: ['code', 'institution'], year: 'year' },
  software:      { title: 'name',         meta: ['type', 'language'], year: 'year' },
};

/* Short id generator — matches McGheeLabWebsite cv-builder.js uid(). */
function cvUid() { return Math.random().toString(36).slice(2, 9); }

/* Strip HTML/XML tags and common LaTeX/Markdown markup from a stored field.
 * CrossRef, ORCID, BibTeX, and legacy website data all leak formatting into
 * titles and authors (e.g. "<i>In-Situ</i>", "**bold**", "\\textit{foo}").
 * We render CVs as plain text, so scrub at display time.
 *
 * Also decodes a handful of common HTML entities — &amp; &lt; &gt; &quot;
 * &#39; &nbsp; — so "Smith &amp; Jones" renders as "Smith & Jones".
 */
function cvCleanText(s) {
  if (s == null) return '';
  var str = String(s);
  return str
    .replace(/<[^>]+>/g, '')                          // HTML/XML tags
    .replace(/\\text(?:bf|it|sc|rm|sf|tt)\{([^}]*)\}/g, '$1')   // LaTeX font cmds
    .replace(/\\emph\{([^}]*)\}/g, '$1')
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\url\{([^}]*)\}/g, '$1')
    .replace(/[{}]/g, '')                             // stray LaTeX braces
    .replace(/\*\*([^*]+)\*\*/g, '$1')                // Markdown bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')       // Markdown italic
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* CVStore — shared Firestore helper usable from any RM page. Writes go to
 * cvData/{current user's uid}, which is the same document the website's
 * cv-builder edits. Both apps read and write the same arrays keyed by _id. */
var CVStore = {
  /* Append a new entry to the given section and return its _id. */
  appendEntry: async function (sectionKey, partial) {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      throw new Error('Not signed in. Sign in from Settings first.');
    }
    if (!CV_SCHEMAS[sectionKey]) throw new Error('Unknown CV section: ' + sectionKey);
    var uid = firebridge.getUser().uid;
    var doc = await firebridge.getDoc('cvData', uid);
    doc = doc || {};
    var list = Array.isArray(doc[sectionKey]) ? doc[sectionKey] : [];
    var entry = Object.assign({ _id: cvUid() }, partial || {});
    list.push(entry);
    var payload = {};
    payload[sectionKey] = list;
    await firebridge.setDoc('cvData', uid, payload, true);
    return entry._id;
  },
};

