#!/usr/bin/env python3
"""
Import third-party chemistry / bio / molecular / pharma skill clusters into
arex-test as AREX-format repo-skills (repo-skill root + sub-skills/, aligned with
the rdkit / alphafold house style), then rebuild the router indexes.

Usage:
    python import_thirdparty.py --source-root DIR            # import
    python import_thirdparty.py --source-root DIR --dry-run  # preview

The source root may also be supplied through AREX_THIRD_PARTY_SKILLS_ROOT.

Router rebuild is a separate step (see rebuild_router.py).
"""
import json, os, sys, hashlib, re

try:
    from .domain_common import FrontmatterError, copy_companion_resources, load_json_file, parse_frontmatter, read_bytes
except ImportError:
    from domain_common import FrontmatterError, copy_companion_resources, load_json_file, parse_frontmatter, read_bytes

MAX_DESCRIPTION_LENGTH = 180  # Agent Skills description compatibility limit.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THIRD = os.environ.get("AREX_THIRD_PARTY_SKILLS_ROOT")
if "--source-root" in sys.argv:
    try:
        THIRD = sys.argv[sys.argv.index("--source-root") + 1]
    except IndexError as exc:
        raise SystemExit("--source-root requires a directory") from exc
if not THIRD:
    raise SystemExit(
        "third-party source root is required; pass --source-root DIR or set "
        "AREX_THIRD_PARTY_SKILLS_ROOT"
    )
THIRD = os.path.abspath(THIRD)
if not os.path.isdir(THIRD):
    raise SystemExit(f"third-party source root does not exist: {THIRD}")
REPO = os.path.join(ROOT, "skills", "repositories", "repo-skills")
ROUTER = os.path.join(ROOT, "skills", "repositories", "repo-skills-router")
IDX = os.path.join(ROUTER, "references", "index")
TAX_PATH = os.path.join(IDX, "taxonomy.json")

DRY = "--dry-run" in sys.argv

tax = load_json_file(TAX_PATH, "router taxonomy")
TAX_SHA = hashlib.sha256(read_bytes(TAX_PATH, "router taxonomy")).hexdigest()

def fam_valid(name): return any(f["name"] == name for a in tax["areas"] for f in a["families"])
def fam_area(name):
    for a in tax["areas"]:
        for f in a["families"]:
            if f["name"] == name: return a["name"]
    return None

def first_sentence(desc):
    s = desc.replace("\n", " ").strip()
    parts = re.split(r"(?<=[.!?])\s+", s)
    return (parts[0].strip() if parts else "Use this skill.")[:MAX_DESCRIPTION_LENGTH]

def norm_body_for_arex(body, skill_id):
    """Normalize source-local links that do not survive the AREX layout."""
    normalized = body.strip()
    if skill_id == "protein-design-setup":
        normalized = normalized.replace(
            "[Getting started](../../docs/getting-started.md)",
            "the setup steps below",
        )
    elif skill_id.startswith(("protein-design-", "boltzgen", "germinal", "ligandmpnn", "solublempnn")):
        normalized = normalized.replace(
            "../../docs/getting-started.md",
            "../protein-design-setup/SKILL.md",
        )
    return normalized

# --------------------------------------------------------- write helpers
def write_skill(skill_id, family, repo_id, repo_url, desc, src_body,
                license=None, sub_skills=None, source_root=""):
    d = os.path.join(REPO, skill_id)
    os.makedirs(os.path.join(d, "references"), exist_ok=True)
    fd = first_sentence(desc).replace('"', '&quot;')
    sub_skills_block = ''
    if sub_skills:
        sub_skills_block = '\n## Sub-skills\n\n' + '\n'.join(f'- `{s}`' for s in sub_skills) + '\n'
    smd = f"""---
name: {skill_id}
description: "{fd}"
disable-model-invocation: true
metadata:
  disco-role: operating
license: {license or "Unknown"}
---

# {skill_id} Repo Skill

Use this repo skill when a task involves {family.lower()} workflows through **{skill_id}**.

{norm_body_for_arex(src_body, skill_id)}

{sub_skills_block}
## Route Elsewhere

- For other domains, see the router area/family index.
"""
    open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8").write(smd)
    cap = f"""# {skill_id} — Capability Map

| Capability | Notes |
| --- | --- |
| Domain | {family} |
| Package / tool | `{skill_id}` |

## Prerequisites

See the SKILL.md body for install / run requirements.

## Boundary

- Imported as an AREX repo-skill under family `{family}`.
- Domain-specific safety and fallback rules are described in the skill body.
"""
    prov = f"""# {skill_id} — repo-provenance

## Summary
- **Skill**: `{skill_id}`
- **Family**: `{family}`
- **Origin**: third-party library `{repo_url or 'unknown'}`, source `{source_root or 'unknown'}`

## What changed on import
Frontmatter normalized to AREX repo-skill schema; references/ added; body retained from source; sub-skills restructured to AREX layout.

## Status
- Routable AREX repo-skill at `skills/repositories/repo-skills/{skill_id}/`.
"""
    open(os.path.join(d, "references", "capability-map.md"), "w", encoding="utf-8").write(cap)
    open(os.path.join(d, "references", "repo-provenance.md"), "w", encoding="utf-8").write(prov)
    meta = {"schema_version": "2.0", "repo_id": repo_id, "skill_id": skill_id,
            "taxonomy_sha256": TAX_SHA, "routing_status": "classified",
            "assignments": [{"area": fam_area(family), "family": family}]}
    open(os.path.join(d, "references", "repo-routing-metadata.json"), "w", encoding="utf-8").write(
        json.dumps(meta, ensure_ascii=False, indent=2))
    return d

# --------------------------------------------------------- sub-skill shrink
def flatten_subskill_id(rel): return "-".join(rel.split(os.sep)).strip("-_")

# --------------------------------------------------------- MAIN PLAN
# family must exist in taxonomy. skill_id must be unique vs repo-skills/.
PLAN = {
 # --- SciAgent-Skills (root: skills/) ---
 "SciAgent-Skills": {
   "genomics-bioinformatics": ("genomics-bioinformatics", "Genomics and Bioinformatics"),
   "structural-biology-drug-discovery": ("structural-biology-drug-discovery", "Protein Modeling"),
   "proteomics-protein-engineering": ("proteomics-protein-engineering", "Protein Modeling"),
   "systems-biology-multiomics": ("systems-biology-multiomics", "Genomics and Bioinformatics"),
   "cell-biology": ("cell-biology", "Genomics and Bioinformatics"),
   "molecular-biology": ("molecular-biology", "Genomics and Bioinformatics"),
   "biostatistics": ("biostatistics", "Genomics and Bioinformatics"),
   "lab-automation": ("lab-automation", "Genomics and Bioinformatics"),
   "scientific-computing": ("sciagent-scientific-computing", "Molecular Informatics"),
 },
 # --- computational-chemistry-agent-skills (root: itself) ---
 "computational-chemistry-agent-skills": {
   "quantum-chemistry": ("quantum-chemistry", "Quantum Chemistry"),
   "atomistic-workflows": ("atomistic-workflows", "Molecular Simulation"),
   "molecular-dynamics": ("molecular-dynamics", "Molecular Simulation"),
   "machine-learning-potentials": ("machine-learning-potentials", "Molecular Simulation"),
   "data-processing": ("compchem-data-processing", "Molecular Simulation"),
   "molecular-representation": ("molecular-representation", "Molecular Informatics"),
   "molecular-conformer": ("molecular-conformer", "Molecular Informatics"),
   "analysis": ("compchem-analysis", "Molecular Simulation"),
   "tools": ("compchem-tools", "Molecular Simulation"),
 },
 # --- DrugClaw (root: skills/) ---
 "DrugClaw": {
   "dti": ("drug-dti", "Drug Discovery and Development"),
   "drug_knowledgebase": ("drug-knowledgebase", "Drug Discovery and Development"),
   "drug_nlp": ("drug-nlp", "Drug Discovery and Development"),
   "drug_repurposing": ("drug-repurposing", "Drug Discovery and Development"),
   "adr": ("drug-adr", "Drug Discovery and Development"),
   "drug_ontology": ("drug-ontology", "Drug Discovery and Development"),
   "drug_toxicity": ("drug-toxicity", "Drug Discovery and Development"),
   "ddi": ("drug-ddi", "Drug Discovery and Development"),
   "drug_labeling": ("drug-labeling", "Drug Discovery and Development"),
   "drug_combination": ("drug-combination", "Drug Discovery and Development"),
   "drug_review": ("drug-review", "Drug Discovery and Development"),
   "drug_disease": ("drug-disease", "Drug Discovery and Development"),
   "drug_mechanism": ("drug-mechanism", "Drug Discovery and Development"),
   "drug_molecular_property": ("drug-molecular-property", "Drug Discovery and Development"),
   "pharmacogenomics": ("pharmacogenomics", "Drug Discovery and Development"),
 },
 # --- protein-design-skills: keep only NEW ones (dedup vs existing) ---
 "protein-design-skills": {
   "binder-design": ("binder-design", "Protein Modeling"),
   "binding-characterization": ("binding-characterization", "Protein Modeling"),
   "boltzgen": ("boltzgen", "Protein Modeling"),
   "campaign-manager": ("protein-campaign-manager", "Protein Modeling"),
   "cell-free-expression": ("cell-free-expression", "Protein Modeling"),
   "foldseek": ("foldseek", "Protein Modeling"),
   "germinal": ("germinal", "Protein Modeling"),
   "ipsae": ("ipsae", "Protein Modeling"),
   "ligandmpnn": ("ligandmpnn", "Protein Modeling"),
   "mosaic": ("mosaic", "Protein Modeling"),
   "pdb": ("pdb-structure", "Protein Modeling"),
   "protein-design-workflow": ("protein-design-workflow", "Protein Modeling"),
   "protein-qc": ("protein-qc", "Protein Modeling"),
   "setup": ("protein-design-setup", "Protein Modeling"),
   "solublempnn": ("solublempnn", "Protein Modeling"),
   "uniprot": ("uniprot", "Protein Modeling"),
 },
}

def lib_root(lib):
    p = os.path.join(THIRD, lib, "skills")
    return p if os.path.isdir(p) else os.path.join(THIRD, lib)

def main():
    if DRY:
        print("DRY RUN - would import:")
    created = []
    planned = 0
    errors = []
    for lib, clusters in PLAN.items():
        for src_cluster, (did, family) in clusters.items():
            if not fam_valid(family):
                errors.append(f"invalid family: {did} -> {family}")
                continue
            src = os.path.join(lib_root(lib), src_cluster)
            if not os.path.isdir(src):
                print(f"[MISSING] {lib}/{src_cluster}")
                continue
            existing = os.path.join(REPO, did, "SKILL.md")
            if not DRY and os.path.isfile(existing):
                print(f"  [SKIP dup] {did}")
                continue
            # root SKILL.md (if dir has its own) else synthesize
            root_md = os.path.join(src, "SKILL.md")
            try:
                if os.path.isfile(root_md):
                    fm, body = parse_frontmatter(root_md)
                    desc = fm.get("description") or f"Use {did} for {family.lower()} workflows."
                else:
                    fm, body = {}, f"Cluster of skills for {family.lower()} ({src_cluster})."
                    desc = f"Use {did} for {family.lower()} workflows: {src_cluster}."
            except FrontmatterError as exc:
                errors.append(str(exc))
                continue
            # collect sub-skills: every SKILL.md directly under src (recursively) except root
            subs = []
            for r, dirs, files in os.walk(src):
                if "SKILL.md" in files:
                    rel = os.path.relpath(r, src)
                    if rel == ".":
                        continue
                    subs.append((rel, os.path.join(r, "SKILL.md")))
            subs.sort()
            parsed_subs = []
            try:
                for rel, md in subs:
                    sfm, sbody = parse_frontmatter(md)
                    parsed_subs.append((rel, md, sfm, sbody))
            except FrontmatterError as exc:
                errors.append(str(exc))
                continue
            if DRY:
                print(f"  {did:32s} <- {lib}/{src_cluster:30s} {family:32s} subs={len(subs)}")
                planned += 1
                continue
            d = write_skill(did, family, f"{lib}/{src_cluster}", f"{lib}/{src_cluster}",
                            desc, body, license=fm.get("license"),
                            sub_skills=[flatten_subskill_id(s) for s,_ in subs],
                            source_root=f"{lib}/{src_cluster}")
            copy_companion_resources(src, d)
            # write sub-skills
            for rel, md, sfm, sbody in parsed_subs:
                subdir = os.path.join(d, "sub-skills", flatten_subskill_id(rel))
                os.makedirs(subdir, exist_ok=True)
                sdesc = sfm.get("description") or f"Sub-skill {flatten_subskill_id(rel)} for {did}."
                sfd = first_sentence(sdesc).replace('"', '&quot;')
                smd = f"""---
name: {flatten_subskill_id(rel)}
description: "{sfd}"
disable-model-invocation: true
metadata:
  disco-role: operating
---

# {flatten_subskill_id(rel)} — {did} sub-skill

{sbody}
"""
                open(os.path.join(subdir, "SKILL.md"), "w", encoding="utf-8").write(smd)
                copy_companion_resources(os.path.dirname(md), subdir)
            created.append(did)
    count = planned if DRY else len(created)
    print(f"\nDONE. {'Would import' if DRY else 'Imported'} {count} repo-skills.")
    if errors:
        print(f"\nERRORS ({len(errors)}):", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
