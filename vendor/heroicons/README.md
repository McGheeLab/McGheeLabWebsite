heroicons 2.2.0
https://github.com/tailwindlabs/heroicons
MIT — see LICENSE

Upstream, unmodified: 24/outline, 24/solid (optimized/).
Ours: custom/ — the gap icons Heroicons does not ship. Never mix the two,
so a version bump is a clean replace of 24/.

NOT shipped to the browser. scripts/gen-icons.mjs reads these and writes
rm/js/icons.js, which is the only file that reaches the site or the phone
bundle. Kept OUTSIDE rm/ on purpose: OurlabMobile/scripts/sync-rm.mjs
rsyncs all of rm/, and these ~650 source SVGs have no business in the app.
