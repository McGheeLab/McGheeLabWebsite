"""Download an open-access PDF for each resolved paper. Cascade:
1) PMC Article Datasets on AWS (pmc-oa-opendata) by PMCID
2) OpenAlex locations with a pdf_url (repositories, publisher OA)
3) bioRxiv/medRxiv preprint (api.biorxiv.org 'pubs' lookup by published DOI)
Every file is checked to be a real PDF (%PDF magic, opens in PyMuPDF, >1 page)."""
import json, sys, os, re, time, hashlib, xml.etree.ElementTree as ET
import requests, pymupdf
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 McGheeLab-litreview'}
S = requests.Session(); S.headers.update(UA)
OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)

def ok_pdf(b):
    if not b or b[:4] != b'%PDF': return False
    try:
        d = pymupdf.open(stream=b, filetype='pdf'); n = d.page_count; t = ''.join(d[i].get_text() for i in range(min(2, n)))
        return n >= 2 and len(t) > 500
    except Exception: return False

def get(url, **kw):
    try:
        r = S.get(url, timeout=60, allow_redirects=True, **kw)
        return r if r.status_code == 200 else None
    except Exception: return None

def pmc(pmcid):
    r = get('https://pmc-oa-opendata.s3.amazonaws.com/?list-type=2&prefix=metadata/%s.' % pmcid)
    if not r: return None, None
    keys = re.findall(r'<Key>(metadata/%s\.\d+\.json)</Key>' % pmcid, r.text)
    for k in sorted(keys, key=lambda s: -int(re.search(r'\.(\d+)\.json', s).group(1))):
        m = get('https://pmc-oa-opendata.s3.amazonaws.com/' + k)
        if not m: continue
        j = m.json(); u = (j.get('pdf_url') or '').split('?')[0].replace('s3://pmc-oa-opendata/', 'https://pmc-oa-opendata.s3.amazonaws.com/')
        if not u: continue
        p = get(u)
        if p and ok_pdf(p.content): return p.content, 'pmc-aws:' + u
    return None, None

def openalex(doi):
    r = get('https://api.openalex.org/works/doi:' + doi)
    if not r: return None, None
    j = r.json(); urls = []
    for l in [j.get('best_oa_location')] + (j.get('locations') or []):
        if l and l.get('pdf_url') and l['pdf_url'] not in urls: urls.append(l['pdf_url'])
    for u in urls:
        p = get(u)
        if p and ok_pdf(p.content): return p.content, 'openalex:' + u
    return None, None

def biorxiv(doi):
    for srv in ('biorxiv', 'medrxiv'):
        r = get('https://api.biorxiv.org/pubs/%s/%s' % (srv, doi))
        if not r: continue
        col = (r.json().get('collection') or [])
        for c in col:
            pd = c.get('preprint_doi')
            if not pd: continue
            d = get('https://api.biorxiv.org/details/%s/%s' % (srv, pd))
            v = max([int(x.get('version', 1)) for x in (d.json().get('collection') if d else [])] or [1])
            for u in ('https://www.%s.org/content/%sv%d.full.pdf' % (srv, pd, v),):
                p = get(u)
                if p and ok_pdf(p.content): return p.content, 'preprint:' + u
    return None, None

papers = json.load(open(sys.argv[1]))
log = []
for p in papers:
    if not p.get('found'): continue
    doi = (p.get('doi') or '').lower(); key = re.sub(r'[^a-z0-9]+', '_', doi)[:80] or ('pmid_' + str(p.get('pmid')))
    fn = os.path.join(OUT, key + '.pdf')
    if os.path.exists(fn) and ok_pdf(open(fn, 'rb').read()):
        log.append({'doi': doi, 'file': fn, 'via': 'cached'}); print('cached', doi); continue
    b = via = None
    if p.get('pmcid'): b, via = pmc(p['pmcid'])
    if not b and doi: b, via = openalex(doi)
    if not b and doi: b, via = biorxiv(doi)
    if b:
        open(fn, 'wb').write(b); log.append({'doi': doi, 'file': fn, 'via': via, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}); print('OK ', doi, via[:90], len(b))
    else:
        log.append({'doi': doi, 'file': None, 'via': None}); print('-- ', doi, 'no OA pdf found')
    time.sleep(0.3)
json.dump(log, open(os.path.join(OUT, '_fetchlog.json'), 'w'), indent=1)
