#!/usr/bin/env python3
"""Rebuild the arex-test repo-skills-router indexes + views, replicating the
official update_repo_skills_router.mjs logic (schema + digests) in Python.

Usage:
  python rebuild_router.py                  # read-only consistency check
  python rebuild_router.py --output-dir DIR # isolated generation
  python rebuild_router.py --write-live     # update live router and root index
"""
import json, os, sys, hashlib, re

try:
    from .domain_common import load_json_file, parse_frontmatter, read_bytes
except ImportError:
    from domain_common import load_json_file, parse_frontmatter, read_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(ROOT, "skills", "repositories", "repo-skills")
ROUTER = os.path.join(ROOT, "skills", "repositories", "repo-skills-router")
IDX = os.path.join(ROUTER, "references", "index")
TAX_PATH = os.path.join(IDX, "taxonomy.json")

WRITE_LIVE = "--write-live" in sys.argv
OUTPUT = None
if "--output-dir" in sys.argv:
    try:
        OUTPUT = sys.argv[sys.argv.index("--output-dir") + 1]
    except IndexError as exc:
        raise SystemExit("--output-dir requires a directory") from exc
    # os.path.abspath("") is the current working directory, which is truthy, so an
    # empty value used to disable the check and write SKILL.md, references/areas/*
    # and references/index/* straight into the invocation directory — normally the
    # repository root — instead of an isolated directory.
    if not OUTPUT.strip():
        raise SystemExit("--output-dir requires a non-empty directory")
    OUTPUT = os.path.abspath(OUTPUT)
if WRITE_LIVE and OUTPUT:
    raise SystemExit("use either --write-live or --output-dir, not both")
CHECK = not WRITE_LIVE and OUTPUT is None

# ---------------------------------------------------------------- utils
def slug(s):
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()

def markdown_escape(s):
    return s.replace("|", "\\|").replace("\n", " ").replace("`", "\\`")

def stable_json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"

tax = load_json_file(TAX_PATH, "router taxonomy")
TAX_SHA = hashlib.sha256(read_bytes(TAX_PATH, "router taxonomy")).hexdigest()

# ---------------------------------------------------------------- collect skills
skills=[]
for d in sorted(os.listdir(REPO)):
    dp=os.path.join(REPO,d)
    if not os.path.isdir(dp): continue
    md_path=os.path.join(dp,"references","repo-routing-metadata.json")
    sk_path=os.path.join(dp,"SKILL.md")
    if not os.path.isfile(md_path) or not os.path.isfile(sk_path): continue
    md=load_json_file(md_path, f"routing metadata for {d}")
    if md.get("routing_status")!="classified": continue
    fm, _ = parse_frontmatter(sk_path)
    skills.append({"id":d, "repo_id":md["repo_id"], "desc":fm.get("description",""),
                   "assignments":md.get("assignments",[])})
skills.sort(key=lambda s:(s["repo_id"], s["id"]))

# ---------------------------------------------------------------- repository records
def make_repository_records(skills):
    return [{
        "schema_version":1, "repo_id":s["repo_id"],
        "legacy_repo_id":None, "repo_name":s["repo_id"].split("/")[-1],
        "skill_id":s["id"], "source_url":f"https://github.com/{s['repo_id']}",
        "source_commit":None, "source_skill_root":None,
        "target_skill_root":f"repo-skills/{s['id']}", "aliases":[],
        "description":s["desc"],
    } for s in sorted(skills, key=lambda s:(s["repo_id"],s["id"]))]

repo_records = make_repository_records(skills)

# ---------------------------------------------------------------- assignment records
tax_order={}; o=0
for a in tax["areas"]:
    for f in a["families"]:
        tax_order[f"{a['name']}\0{f['name']}"]=o; o+=1
assign_records=[]
for s in skills:
    for asg in s["assignments"]:
        assign_records.append({
            "repo_id":s["repo_id"], "legacy_repo_id":None, "skill_id":s["id"],
            "area":asg["area"], "family":asg["family"], "confidence":asg.get("confidence","high"),
        })
assign_records.sort(key=lambda r:(tax_order.get(f"{r['area']}\0{r['family']}",999), r["repo_id"], r["skill_id"]))

# ---------------------------------------------------------------- digests
def digest(records):
    joined = "\n".join(json.dumps(r, ensure_ascii=False, separators=(",",":")) for r in records) + "\n"
    return "sha256:"+hashlib.sha256(joined.encode("utf-8")).hexdigest()

repo_digest = digest(repo_records)
assign_digest = digest(assign_records)

# ---------------------------------------------------------------- views
class M:  # family map
    def __init__(self): self.b={}
    def get(self,k): return self.b.get(k) or M._e()
    @staticmethod
    def _e(): 
        x=type("", (), {})(); x.skills=[]; return x

fam_map={}
for a in tax["areas"]:
    for f in a["families"]:
        fam_map[f"{a['name']}\0{f['name']}"]=[]  # list of skills
for s in skills:
    for asg in s["assignments"]:
        fam_map.setdefault(f"{asg['area']}\0{asg['family']}", []).append(s)
for k in fam_map: fam_map[k].sort(key=lambda s:(s["repo_id"],s["id"]))

ROUTER_DESCRIPTION = 'Routes substantive ML, AI, data, scientific-computing, and software-engineering requests to the smallest useful set of managed repository skills. Invoke proactively when a request names or implies a package, framework, model family, dataset, modality, workflow, backend, deployment target, evaluation method, or implementation approach that may benefit from repository guidance, even if no repository is named. Narrow progressively from area to family to repository root: inspect only the one or two most likely area pages; compare candidates by capability, task surface, model/data format, training versus inference versus evaluation intent, runtime constraints, and root-skill description; then open only the selected root and relevant sub-skills, references, or scripts. Select multiple repositories only when each adds a distinct capability. Do not load the whole collection, treat dependencies or incidental integrations as capabilities, choose by name alone, or force a match when no exact taxonomy family applies.'

def render_root_v2(disabled=True):
    populated=[a for a in tax["areas"] if any(fam_map.get(f"{a['name']}\0{f['name']}") for f in a["families"])]
    rows=[]
    for a in populated:
        pop=[f for f in a["families"] if fam_map.get(f"{a['name']}\0{f['name']}")]
        mem=sum(len(fam_map.get(f"{a['name']}\0{f['name']}",[])) for f in pop)
        rows.append(f"| [{markdown_escape(a['name'])}](references/areas/{slug(a['name'])}.md) | {len(pop)} | {mem} |")
    # decode the escaped backslashes used when writing this constant
    desc = ROUTER_DESCRIPTION.replace('\\"', '"')
    fm=f"""---
name: "repo-skills-router"
description: "{markdown_escape(desc)}"
metadata:
  disco-role: "operating"
---
"""
    return (fm + "# Repo Skills Router\n\n"
        "Use this router for substantive requests where a managed repository skill may provide implementation guidance. It is a progressive-disclosure index, not a replacement for the selected repository skill.\n\n"
        "## Routing procedure\n\n"
        "1. Identify the user's dominant capability, workflow, data/model format, and runtime intent.\n"
        "2. Read only the one or two most likely area pages below.\n"
        "3. Compare the relevant family pages, especially when training, inference, evaluation, deployment, or similarly named repositories overlap.\n"
        "4. Open the selected repository root at `../repo-skills/<skill-id>/SKILL.md`, then read only its relevant sub-skills, references, and scripts.\n"
        "5. If no exact family fits, do not force a repository match; continue with the general task context or report that the managed collection has no exact route.\n\n"
        "A repository may appear in several families. Choose the smallest set of repository roots that directly covers the request, and do not load every candidate listed on a family page.\n\n"
        "## Area quick map\n\n| Area | Populated families | Repository memberships | Area page |\n| --- | ---: | ---: | --- |\n" + "\n".join(rows) + "\n\n"
        "## Maintenance\n\nThe machine-readable files under `references/index/` are the generated routing source of truth. Do not hand-edit area or family pages. For import, refresh, extension, or taxonomy changes, read [references/maintenance.md](references/maintenance.md) and use the verified importer/updater transaction.\n")

def render_area(a):
    rows=[]
    for f in a["families"]:
        skills_in=fam_map.get(f"{a['name']}\0{f['name']}")
        if not skills_in: continue
        rows.append(f"| [{markdown_escape(f['name'])}](../families/{slug(a['name'])}/{slug(f['name'])}.md) | {markdown_escape(f['scope'])} | {len(skills_in)} |")
    default_scope = 'Use this area for ' + a['name'].lower() + ' tasks.'
    area_scope = a['scope'] or default_scope
    body = "# " + a['name'] + "\n\n" + area_scope
    body += "\n\nRead a family page only after confirming that the family scope matches the user's actual capability.\n\n"
    body += "| Family | Scope | Repositories |\n| --- | --- | ---: |\n" + "\n".join(rows) + "\n"
    return body

def render_family(a, f, skills_in):
    rows=[f"| [`{s['id']}`](../../../../repo-skills/{s['id']}/SKILL.md) | `{markdown_escape(s['repo_id'])}` | {markdown_escape(s['desc'])} |" for s in skills_in]
    return f"# {a['name']} -> {f['name']}\n\n{f['scope']}\n\nChoose a repository below only when its description, package/repository identity, task surface, and runtime intent match the request. If several candidates overlap, prefer the one whose root skill directly covers the requested workflow; then inspect its internal navigation rather than loading all candidates.\n\n| Repo skill | Repository | Skill description |\n| --- | --- | --- |\n" + "\n".join(rows) + "\n"

def render_maintenance(skills):
    mem=sum(len(v) for v in fam_map.values())
    return (f"# Router maintenance\n\nThis router is generated from the fixed area -> family taxonomy and the v2 `references/repo-routing-metadata.json` fragment attached to each repository skill. The compact fragment contains only identity, taxonomy hash, status, and exact assignments. Full classification evidence belongs in the external production routing decision artifact, not in the runtime skill graph.\n\n"
        "## Import contract\n\n1. Finish and independently verify the generated repository skill.\n2. Classify it against the exact taxonomy using repository evidence plus the generated skill as navigation context.\n3. Write the external routing decision with assignment-specific rationale, evidence, and assignment-level confidence (`high`, `medium`, or `low`).\n4. Write the minimal v2 metadata fragment only after the decision is made; confidence remains in the central assignment index and is not copied into runtime metadata.\n5. Run the verified importer/updater under the shared lock so the skill, metadata, indexes, and router are updated together.\n\n"
        f"## Current generated scope\n\n- Areas in taxonomy: {len(tax['areas'])}\n- Routable repository skills: {len(skills)}\n- Taxonomy memberships: {mem}\n")

# ---------------------------------------------------------------- write
target = OUTPUT or ROUTER
files = {}
files["SKILL.md"] = render_root_v2(True)
for a in tax["areas"]:
    if any(fam_map.get(f"{a['name']}\0{f['name']}") for f in a["families"]):
        files[os.path.join("references","areas",f"{slug(a['name'])}.md")] = render_area(a)
    for f in a["families"]:
        skills_in=fam_map.get(f"{a['name']}\0{f['name']}")
        if skills_in:
            d=os.path.join("references","families",slug(a['name']))
            files[os.path.join(d,f"{slug(f['name'])}.md")] = render_family(a,f,skills_in)
files[os.path.join("references","index","taxonomy.json")] = stable_json(tax)
def ndjson(records):
    return "\n".join(json.dumps(r,ensure_ascii=False,separators=(",",":")) for r in records)+"\n"
repositories_content = ndjson(repo_records)
assignments_content = ndjson(assign_records)
files[os.path.join("references","index","repositories.jsonl")] = repositories_content
files[os.path.join("references","index","assignments.jsonl")] = assignments_content
# digests MUST be sha256 of the exact bytes that will be written to disk
repo_file_digest = "sha256:"+hashlib.sha256(repositories_content.encode("utf-8")).hexdigest()
assign_file_digest = "sha256:"+hashlib.sha256(assignments_content.encode("utf-8")).hexdigest()
files[os.path.join("references","index","build-metadata.json")] = stable_json({
    "schema_version":1, "area_count":len(tax["areas"]), "assignment_count":len(assign_records),
    "repository_count":len(repo_records),
    "family_count":sum(len(a["families"]) for a in tax["areas"]),
    "non_empty_family_count":sum(1 for v in fam_map.values() if v),
    "taxonomy_sha256":TAX_SHA, "repository_index_sha256":repo_file_digest,
    "assignment_index_sha256":assign_file_digest, "source_router_run_id":"router-chem-subset-20260906T000000Z",
})
files[os.path.join("references","maintenance.md")] = render_maintenance(skills)

repo_idx = os.path.join(REPO, "repository-index.jsonl")

def content_matches(path, expected):
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            return handle.read() == expected
    except FileNotFoundError:
        return False
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f"failed to compare generated file at {path}: {exc}") from exc

if CHECK:
    mismatches = []
    for rel, content in files.items():
        path = os.path.join(ROUTER, rel)
        if not content_matches(path, content):
            mismatches.append(rel.replace(os.sep, "/"))
    if not content_matches(repo_idx, repositories_content):
        mismatches.append("../repo-skills/repository-index.jsonl")
    if mismatches:
        print("Router is stale:")
        for rel in mismatches:
            print(f"  {rel}")
        raise SystemExit(1)
    print(f"Router is current: skills={len(skills)} assignments={len(assign_records)}")
else:
    wrote = 0
    for rel, content in files.items():
        path = os.path.join(target, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        wrote += 1
    print(f"Wrote {wrote} files to {target}")
    print(f"skills={len(skills)} assignments={len(assign_records)} repo_records={len(repo_records)}")
    print(f"repo_file_digest={repo_file_digest[:18]} assign_file_digest={assign_file_digest[:18]}")

    if WRITE_LIVE:
        with open(repo_idx, "w", encoding="utf-8", newline="") as fh:
            fh.write(repositories_content)
        print(f"synced repo-skills/repository-index.jsonl ({len(repo_records)} records)")
