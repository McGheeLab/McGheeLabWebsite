#!/usr/bin/env python3
"""build_bundle.py — validate + zip a McGhee Lab RM paper bundle.

Takes a working directory that contains a hand-authored ``paper.json`` (and,
optionally, an ``assets/`` dir, ``paper.md``, ``refs.bib``, ``comments.json``)
and produces a ``<slug>.paperbundle.zip`` that imports faithfully via the
"📥 Import paper" button on mcgheelab.com/rm/pages/paper-builder.html.

The RM importer (rm/js/paper-import-engine.js) silently *coerces* malformed
input — an unknown block kind becomes a plain paragraph, a bad table drops its
cells — so problems are invisible until after upload. This script front-loads
those checks and refuses to build on hard errors.

Usage:
    python3 build_bundle.py <workdir> [-o OUT.zip] [--slug SLUG]
                            [--gen-md] [--strict] [--validate-only]

    <workdir>         dir containing paper.json (+ assets/, etc.)
    -o / --output     output zip path (default: <slug>.paperbundle.zip in cwd)
    --slug            override the derived slug (kebab-case)
    --gen-md          (re)generate a readable paper.md from the manifest
    --strict          treat warnings as errors
    --validate-only   validate and report; do not write the zip

Exit codes: 0 ok · 1 validation failed · 2 bad invocation.
"""
import argparse
import json
import os
import re
import sys
import zipfile

# ── Closed vocabularies (mirror rm/js/paper-schemas.js) ──────────────────────
SECTION_KINDS = {
    "abstract", "keywords", "introduction", "background", "methods", "results",
    "discussion", "conclusions", "acknowledgements", "references",
    "cover_letter", "suggested_reviewers", "rebuttal",
    "project_summary", "specific_aims", "research_strategy", "biosketch",
    "facilities", "budget", "budget_justification", "current_pending",
    "collaborators_coa", "synergistic_activities", "data_management_plan",
    "mentoring_plan", "resource_sharing", "vertebrate_animals", "human_subjects",
    "select_agents", "letters_of_support", "pecase_statement", "custom",
}
GRANT_ATTACHED_KINDS = {
    "project_summary", "specific_aims", "research_strategy", "biosketch",
    "facilities", "budget", "budget_justification", "current_pending",
    "collaborators_coa", "synergistic_activities", "data_management_plan",
    "mentoring_plan", "resource_sharing", "vertebrate_animals", "human_subjects",
    "select_agents", "letters_of_support", "pecase_statement",
}
BLOCK_KINDS = {"paragraph", "subheading", "equation", "figure", "table", "list"}
PAPER_TYPES = {"journal", "grant", "editorial", "book-chapter"}
TEMPLATE_IDS = {
    "mebp-journal", "nih-r01", "nih-r21", "nsf-standard", "nsf-career", "blank",
}
NUMERIC_MARKER = re.compile(r"\[(\s*\d[\d\s,–-]*)\]")

errors = []    # hard problems — always block the build
warnings = []  # importer tolerates/coerces these, but flag them


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def slugify(text):
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "paper").lower()).strip("-")
    return (s[:60] or "paper")


# ── Validators ───────────────────────────────────────────────────────────────
def is_ytext(v):
    return isinstance(v, dict) and v.get("__ytype") == "text" and "value" in v


def is_ymap(v):
    return isinstance(v, dict) and v.get("__ytype") == "map" and isinstance(v.get("entries"), dict)


def scan_numeric_markers(text, nrefs, where):
    """Find the largest [N] referenced; warn if it exceeds the reference list."""
    for m in NUMERIC_MARKER.finditer(str(text or "")):
        inner = m.group(1)
        for part in inner.split(","):
            part = part.strip()
            rng = re.split(r"\s*[–-]\s*", part)
            nums = []
            if len(rng) == 2 and rng[0].isdigit() and rng[1].isdigit():
                nums = [int(rng[0]), int(rng[1])]
            elif part.isdigit():
                nums = [int(part)]
            for n in nums:
                if nrefs == 0:
                    warn(f"{where}: numeric citation marker '[{inner.strip()}]' but the bundle has no references[] — it will render literally.")
                    return
                if n > nrefs:
                    warn(f"{where}: numeric marker [{n}] is out of range (only {nrefs} references[]).")


def validate_block(blk, sec_label, idx, storage_paths, nrefs):
    where = f"section '{sec_label}' block #{idx}"
    if not isinstance(blk, dict):
        err(f"{where}: block is not an object.")
        return
    kind = blk.get("kind", "paragraph")
    if kind not in BLOCK_KINDS:
        warn(f"{where}: unknown block kind '{kind}' → importer coerces to 'paragraph'.")
    attrs = blk.get("attrs") or {}
    if not isinstance(attrs, dict):
        err(f"{where}: attrs must be an object.")
        attrs = {}
    body = blk.get("body", "")
    scan_numeric_markers(body, nrefs, where)

    if kind == "subheading":
        if attrs.get("level") not in (2, 3):
            warn(f"{where}: subheading attrs.level should be 2 or 3 (got {attrs.get('level')!r}); defaults to 2.")
        if not str(body).strip():
            warn(f"{where}: subheading has empty body (the heading text).")
    elif kind == "list":
        if attrs.get("list_type") not in ("bullet", "number"):
            warn(f"{where}: list attrs.list_type should be 'bullet' or 'number' (got {attrs.get('list_type')!r}); defaults to bullet.")
    elif kind == "equation":
        if not str(body).strip():
            warn(f"{where}: equation has empty body (the LaTeX).")
    elif kind == "figure":
        sp = attrs.get("storage_path")
        if sp:
            storage_paths.append((sp, where))
        else:
            warn(f"{where}: figure has no attrs.storage_path — it imports as an empty figure to fill in later.")
        subs = attrs.get("subfigures")
        if subs is not None and not isinstance(subs, list):
            err(f"{where}: figure attrs.subfigures must be an array of {{id,label}}.")
        # composed panels
        pj = attrs.get("panels_json")
        if pj:
            try:
                for p in (json.loads(pj) or []):
                    if isinstance(p, dict) and p.get("storage_path"):
                        storage_paths.append((p["storage_path"], where + " (panel)"))
            except Exception:
                warn(f"{where}: attrs.panels_json is not valid JSON.")
    elif kind == "table":
        rows, cols = attrs.get("rows"), attrs.get("cols")
        if not isinstance(rows, int) or not isinstance(cols, int) or rows < 1 or cols < 1:
            err(f"{where}: table needs integer attrs.rows and attrs.cols >= 1.")
        cells = attrs.get("cells")
        if not is_ymap(cells):
            err(f"{where}: table attrs.cells must be {{\"__ytype\":\"map\",\"entries\":{{...}}}} (cells were dropped otherwise).")
        else:
            for key, cell in cells["entries"].items():
                if not re.match(r"^\d+-\d+$", str(key)):
                    err(f"{where}: table cell key '{key}' must be 'row-col' (0-indexed).")
                elif isinstance(rows, int) and isinstance(cols, int):
                    r, c = map(int, str(key).split("-"))
                    if r >= rows or c >= cols:
                        warn(f"{where}: table cell '{key}' is outside {rows}x{cols}.")
                if not is_ytext(cell):
                    err(f"{where}: table cell '{key}' must be {{\"__ytype\":\"text\",\"value\":\"...\"}}.")
        cap = attrs.get("caption")
        if cap is not None and not is_ytext(cap):
            err(f"{where}: table attrs.caption must be {{\"__ytype\":\"text\",\"value\":\"...\"}}.")


def validate_manifest(m, workdir):
    if not isinstance(m, dict):
        err("paper.json is not a JSON object.")
        return None
    # tree.sections — the one hard requirement the importer enforces.
    tree = m.get("tree")
    if not isinstance(tree, dict) or not isinstance(tree.get("sections"), list):
        err("manifest.tree.sections must be an array — the importer rejects the bundle otherwise.")
        return None

    if m.get("bundle_version") != 1:
        warn(f"bundle_version should be 1 (got {m.get('bundle_version')!r}).")

    title = ((m.get("paper") or {}).get("title")
             or (tree.get("meta") or {}).get("title"))
    if not title:
        warn("no title found (paper.title / tree.meta.title) — the paper imports as 'Imported paper'.")

    # paper meta
    pt = (m.get("paper") or {}).get("paper_type", "journal")
    if pt not in PAPER_TYPES:
        warn(f"paper.paper_type '{pt}' is not one of {sorted(PAPER_TYPES)}; importer coerces to 'journal'.")

    # config
    cfg = m.get("config")
    if not isinstance(cfg, dict):
        warn("no manifest.config — the paper imports with default template 'mebp-journal'. Add config.templateId to control formatting.")
    else:
        tid = cfg.get("templateId")
        if tid and tid not in TEMPLATE_IDS:
            warn(f"config.templateId '{tid}' is not a known built-in template ({sorted(TEMPLATE_IDS)}); the compiler may fall back.")
        if cfg.get("paperType") and cfg["paperType"] not in PAPER_TYPES:
            warn(f"config.paperType '{cfg['paperType']}' is invalid; coerced to 'journal'.")

    # references
    refs = m.get("references") or []
    if not isinstance(refs, list):
        err("manifest.references must be an array.")
        refs = []
    nrefs = len(refs)
    for i, r in enumerate(refs):
        if not isinstance(r, dict):
            err(f"references[{i}] is not an object."); continue
        if not (r.get("title") or r.get("doi") or r.get("arxiv_id") or r.get("pmid")):
            warn(f"references[{i}] has no title/doi/arxiv_id/pmid — its citation key will be poor.")
        au = r.get("authors")
        if au is not None and not isinstance(au, list):
            err(f"references[{i}].authors must be an array of {{family,given}}.")

    # sections + blocks
    storage_paths = []
    seen_ids = set()
    grant_secs = 0
    for si, sec in enumerate(tree["sections"]):
        if not isinstance(sec, dict):
            err(f"tree.sections[{si}] is not an object."); continue
        label = sec.get("label") or sec.get("kind") or f"#{si}"
        kind = sec.get("kind", "custom")
        if kind not in SECTION_KINDS:
            warn(f"section '{label}': unknown kind '{kind}' → importer coerces to 'custom'.")
        if kind in GRANT_ATTACHED_KINDS:
            grant_secs += 1
        sid = sec.get("id")
        if sid:
            if sid in seen_ids:
                err(f"duplicate section/block id '{sid}' — ids must be unique (comments re-bind by id).")
            seen_ids.add(sid)
        else:
            warn(f"section '{label}' has no id — one is generated, but stable ids help comment re-binding.")
        if sec.get("uploaded_file") and (sec["uploaded_file"] or {}).get("storage_path"):
            storage_paths.append((sec["uploaded_file"]["storage_path"], f"section '{label}' uploaded_file"))
        kids = sec.get("children")
        if not isinstance(kids, list):
            err(f"section '{label}': children must be an array."); continue
        for bi, blk in enumerate(kids):
            bid = isinstance(blk, dict) and blk.get("id")
            if bid:
                if bid in seen_ids:
                    err(f"duplicate block id '{bid}'.")
                seen_ids.add(bid)
            validate_block(blk, label, bi, storage_paths, nrefs)

    if pt == "grant" and grant_secs == 0 and not m.get("grant_docs"):
        warn("paper_type is 'grant' but no grant attached-doc sections or grant_docs[] found.")

    # graphical abstract
    ga = (cfg or {}).get("graphicalAbstract") if isinstance(cfg, dict) else None
    if ga and ga.get("storage_path"):
        storage_paths.append((ga["storage_path"], "config.graphicalAbstract"))

    # grant_docs
    for gi, g in enumerate(m.get("grant_docs") or []):
        if not isinstance(g, dict):
            err(f"grant_docs[{gi}] is not an object."); continue
        if g.get("kind") not in GRANT_ATTACHED_KINDS:
            warn(f"grant_docs[{gi}].kind '{g.get('kind')}' is not a grant attached-doc kind; it may be ignored.")
        sp = (g.get("asset") or {}).get("storage_path_original") or g.get("storage_path_original")
        if sp:
            storage_paths.append((sp, f"grant_docs[{gi}]"))
        else:
            warn(f"grant_docs[{gi}] has no storage_path_original — its PDF cannot be located.")

    # assets ↔ storage-path linkage
    assets = m.get("assets") or []
    if not isinstance(assets, list):
        err("manifest.assets must be an array."); assets = []
    by_orig = {}
    for ai, a in enumerate(assets):
        if not isinstance(a, dict):
            err(f"assets[{ai}] is not an object."); continue
        for k in ("hash", "ext", "storage_path_original", "relpath"):
            if not a.get(k):
                err(f"assets[{ai}] missing '{k}'.")
        rel = a.get("relpath", "")
        exp = f"assets/{a.get('hash')}.{a.get('ext')}"
        if rel and rel != exp:
            warn(f"assets[{ai}].relpath '{rel}' != expected '{exp}'.")
        if rel and not os.path.isfile(os.path.join(workdir, rel)):
            err(f"assets[{ai}] file '{rel}' not found in {workdir} — the image bytes must be present in the bundle.")
        if a.get("storage_path_original"):
            by_orig[a["storage_path_original"]] = a
    for sp, where in storage_paths:
        if sp not in by_orig:
            warn(f"{where}: storage_path '{sp}' has no matching assets[] entry — the image will be blank after import.")

    # comments.json (optional file, read separately below in build)
    return {"title": title or "Imported paper", "seen_ids": seen_ids, "nrefs": nrefs}


def validate_comments(workdir, seen_ids):
    path = os.path.join(workdir, "comments.json")
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            comments = json.load(f)
    except Exception as e:
        err(f"comments.json does not parse: {e}"); return
    if not isinstance(comments, list):
        err("comments.json must be a JSON array."); return
    for i, c in enumerate(comments):
        if not isinstance(c, dict):
            err(f"comments[{i}] is not an object."); continue
        bid = c.get("blockId")
        if not bid:
            warn(f"comments[{i}] has no blockId — it cannot anchor to a block.")
        elif bid not in seen_ids:
            warn(f"comments[{i}] blockId '{bid}' matches no section/block id in the tree.")


# ── paper.md generation (optional, readable companion; not parsed on import) ──
def gen_markdown(m):
    out, tree = [], m.get("tree", {})
    out.append("# " + str((m.get("paper") or {}).get("title") or (tree.get("meta") or {}).get("title") or "Untitled paper"))
    out.append("")
    for sec in tree.get("sections", []):
        out.append("## " + str(sec.get("label") or sec.get("kind") or ""))
        out.append("")
        for b in sec.get("children", []):
            kind, body = b.get("kind"), b.get("body", "")
            attrs = b.get("attrs") or {}
            if kind == "subheading":
                out.append(("#### " if attrs.get("level") == 3 else "### ") + str(body)); out.append("")
            elif kind == "figure":
                out.append(f"![{str(body).replace(chr(10), ' ')}]({attrs.get('storage_path', '')})"); out.append("")
            elif kind == "equation":
                out.append("$$" + str(body) + "$$"); out.append("")
            elif kind == "list":
                num = attrs.get("list_type") == "number"
                for i, line in enumerate(str(body).split("\n")):
                    if line.strip():
                        out.append((f"{i + 1}. " if num else "- ") + line.strip())
                out.append("")
            elif kind == "table":
                out.append("*(table — see paper.json for cell data)*"); out.append("")
            else:
                out.append(str(body)); out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Validate + zip an RM paper bundle.")
    ap.add_argument("workdir", help="dir containing paper.json (+ assets/, etc.)")
    ap.add_argument("-o", "--output", help="output zip path")
    ap.add_argument("--slug", help="override the derived slug")
    ap.add_argument("--gen-md", action="store_true", help="(re)generate paper.md from the manifest")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    ap.add_argument("--validate-only", action="store_true", help="validate only; do not write the zip")
    args = ap.parse_args()

    workdir = os.path.abspath(args.workdir)
    manifest_path = os.path.join(workdir, "paper.json")
    if not os.path.isfile(manifest_path):
        print(f"error: {manifest_path} not found", file=sys.stderr)
        sys.exit(2)
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:
        print(f"error: paper.json does not parse: {e}", file=sys.stderr)
        sys.exit(1)

    info = validate_manifest(manifest, workdir)
    if info:
        validate_comments(workdir, info["seen_ids"])

    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")

    fatal = bool(errors) or (args.strict and bool(warnings))
    print(f"\n{len(errors)} error(s), {len(warnings)} warning(s).")
    if fatal:
        print("Build blocked. Fix the errors above" + (" (or drop --strict)." if args.strict and not errors else "."))
        sys.exit(1)
    if not info:
        sys.exit(1)

    # optional paper.md (re)generation — runs even with --validate-only so you
    # can preview the readable companion before committing to a build.
    if args.gen_md:
        with open(os.path.join(workdir, "paper.md"), "w", encoding="utf-8") as f:
            f.write(gen_markdown(manifest))
        print("Wrote paper.md.")

    if args.validate_only:
        print("Validation passed (no zip written; --validate-only).")
        sys.exit(0)

    slug = args.slug or slugify(info["title"])
    out_path = args.output or os.path.join(os.getcwd(), f"{slug}.paperbundle.zip")

    include = ["paper.json", "paper.md", "refs.bib", "comments.json"]
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in include:
            p = os.path.join(workdir, name)
            if os.path.isfile(p):
                z.write(p, name)
        adir = os.path.join(workdir, "assets")
        if os.path.isdir(adir):
            for fn in sorted(os.listdir(adir)):
                fp = os.path.join(adir, fn)
                if os.path.isfile(fp):
                    z.write(fp, f"assets/{fn}")

    size_kb = os.path.getsize(out_path) / 1024.0
    print(f"Wrote {out_path} ({size_kb:.0f} KB).")
    print("Upload it via '📥 Import paper' on mcgheelab.com/rm/pages/paper-builder.html.")


if __name__ == "__main__":
    main()
