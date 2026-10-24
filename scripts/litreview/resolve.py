import json, sys, urllib.parse, urllib.request
out = []
for line in open(sys.argv[1]):
    t = line.strip()
    if not t: continue
    q = 'TITLE:"%s"' % t.replace('"', '')
    url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=3&query=' + urllib.parse.quote(q)
    try:
        d = json.load(urllib.request.urlopen(url, timeout=30))
        rs = [r for r in d['resultList']['result'] if r.get('source') in ('MED', 'PPR', 'PMC')]
    except Exception as e:
        rs = []; print('ERR', t, e, file=sys.stderr)
    if not rs:
        out.append({'q': t, 'found': False}); print('NOTFOUND |', t); continue
    # prefer the peer-reviewed record over a preprint
    rs.sort(key=lambda r: (r.get('source') == 'PPR', -int(r.get('citedByCount') or 0)))
    r = rs[0]
    rec = {'q': t, 'found': True, 'title': r.get('title'), 'doi': r.get('doi'), 'pmid': r.get('pmid'), 'pmcid': r.get('pmcid'),
           'year': r.get('pubYear'), 'journal': (r.get('journalInfo') or {}).get('journal', {}).get('title') or r.get('bookOrReportDetails', {}).get('publisher'),
           'authors': r.get('authorString'), 'oa': r.get('isOpenAccess'), 'source': r.get('source'), 'cited': r.get('citedByCount'),
           'abstract': r.get('abstractText'), 'authorList': [{'family': a.get('lastName') or a.get('collectiveName') or '', 'given': a.get('firstName') or ''} for a in (r.get('authorList') or {}).get('author', [])],
           'volume': (r.get('journalInfo') or {}).get('volume'), 'issue': (r.get('journalInfo') or {}).get('issue'), 'pages': r.get('pageInfo'),
           'journalIso': ((r.get('journalInfo') or {}).get('journal') or {}).get('isoabbreviation'), 'issn': ((r.get('journalInfo') or {}).get('journal') or {}).get('issn')}
    out.append(rec)
    print('%s | %s | %s | %s | %s | oa=%s | %s' % (rec['year'], rec['doi'], rec['pmid'], rec['pmcid'], (rec['journal'] or '')[:30], rec['oa'], rec['title'][:70]))
json.dump(out, open(sys.argv[2], 'w'), indent=1)
