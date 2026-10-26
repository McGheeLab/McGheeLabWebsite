# Fonts for the paper builder's journal looks (V3.907)

These are the OpenType files the TeX distribution ships (Tectonic loads them
by file name when it compiles a paper), vendored here unchanged so the
Document view lays text out with the SAME glyph widths the PDF uses.
Loaded on demand by `rm/js/paper-look.js` (`@font-face`), never globally.

| files | family | licence |
|---|---|---|
| `texgyretermes-*`, `texgyreheros-*`, `texgyrepagella-*` | TeX Gyre Termes / Heros / Pagella (GUST e-foundry) — Pagella is the Palatino-metric face a grant look may use (V3.911) | GUST Font License (LPPL 1.3c-based; redistribution permitted) |
| `texgyreheroscn-*` | TeX Gyre Heros Condensed (GUST e-foundry) — the Helvetica Condensed metrics of PLOS's first-page sidebar (V3.921) | GUST Font License |
| `lmroman10-*`, `lmroman9-*`, `lmroman8-*`, `lmroman7-regular`, `lmsans10-*` | Latin Modern (GUST e-foundry) — the 9/8/7 pt optical sizes are what a class loading `lmodern` sets small text in (V3.909) | GUST Font License |
| `LibertinusSerif-*`, `LibertinusSans-*` | Libertinus (Philipp H. Poll, Khaled Hosny et al.) | SIL Open Font License 1.1 |
| `EBGaramond-*` | EB Garamond (Georg Duffner, Octavio Pardo) | SIL Open Font License 1.1 |
| `SourceSansPro-*` | Source Sans Pro (Adobe) | SIL Open Font License 1.1 |

GUST Font License: https://www.gust.org.pl/projects/e-foundry/licenses
SIL OFL 1.1: https://openfontlicense.org
