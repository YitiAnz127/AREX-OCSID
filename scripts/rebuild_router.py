#!/usr/bin/env python3
"""Rebuild the arex-test repo-skills-router indexes + views, replicating the
official update_repo_skills_router.mjs logic (schema + digests) in Python.

Usage:
  python rebuild_router.py                  # read-only consistency check
  python rebuild_router.py --output-dir DIR # isolated generation
  python rebuild_router.py --write-live     # update live router and root index

Options:
  --confidence-mode legacy|strict   strict accepts a confidence only when it is a
                                    verified routing decision (--routing-entry) or an
                                    explicit metadata value; a prior index row is not
                                    accepted, because that row may itself be a default
  --source-index FILE               repository index whose recorded provenance is
                                    preserved (default: the live
                                    repo-skills/repository-index.jsonl)
  --source-assignments FILE         assignment index whose recorded confidence is
                                    preserved (default: the live
                                    references/index/assignments.jsonl)
  --routing-entry FILE              verified external classification handoff
                                    (jsonl); repeat for several skills. Mirrors
                                    update_repo_skills_router.mjs --routing-entry.

Both `--flag value` and `--flag=value` are accepted; unknown options are errors.
"""
import json, os, sys, hashlib, re, unicodedata

try:
    from .domain_common import load_json_file, parse_frontmatter, read_bytes
except ImportError:
    from domain_common import load_json_file, parse_frontmatter, read_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(ROOT, "skills", "repositories", "repo-skills")
ROUTER = os.path.join(ROOT, "skills", "repositories", "repo-skills-router")
IDX = os.path.join(ROUTER, "references", "index")
TAX_PATH = os.path.join(IDX, "taxonomy.json")

USAGE = (
    "usage: python rebuild_router.py [--output-dir DIR | --write-live] "
    "[--confidence-mode legacy|strict] [--source-index FILE] [--source-assignments FILE] "
    "[--routing-entry FILE ...]"
)

VALUE_OPTIONS = ("--output-dir", "--confidence-mode", "--source-index", "--source-assignments")
REPEATABLE_OPTIONS = ("--routing-entry",)
FLAG_OPTIONS = ("--write-live",)

def parse_args(argv):
    """Parse `--flag value` and `--flag=value`, and reject anything unknown.

    The previous hand-written parser looked for exact tokens, which had two bad
    consequences: `--confidence-mode=strict` (the form this script's own warning
    recommends) was silently ignored and the build ran in legacy mode, and a typo
    in any option was silently ignored too. Both are hard errors now.
    """
    values, flags, repeated = {}, set(), {}
    index = 0
    while index < len(argv):
        arg = argv[index]
        name, sep, inline = arg.partition("=")
        if sep and name in VALUE_OPTIONS:
            values[name] = inline
        elif sep and name in REPEATABLE_OPTIONS:
            repeated.setdefault(name, []).append(inline)
        elif arg in VALUE_OPTIONS:
            if index + 1 >= len(argv):
                raise SystemExit(f"{arg} requires a value\n{USAGE}")
            values[arg] = argv[index + 1]
            index += 1
        elif arg in REPEATABLE_OPTIONS:
            if index + 1 >= len(argv):
                raise SystemExit(f"{arg} requires a value\n{USAGE}")
            repeated.setdefault(arg, []).append(argv[index + 1])
            index += 1
        elif arg in FLAG_OPTIONS:
            flags.add(arg)
        elif arg.startswith("-"):
            raise SystemExit(f"unknown option: {name if sep else arg}\n{USAGE}")
        else:
            raise SystemExit(f"unknown argument: {arg}\n{USAGE}")
        index += 1
    return values, flags, repeated

ARG_VALUES, ARG_FLAGS, ARG_REPEATED = parse_args(sys.argv[1:])

WRITE_LIVE = "--write-live" in ARG_FLAGS
OUTPUT = ARG_VALUES.get("--output-dir")
if OUTPUT is not None:
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

CONFIDENCE_MODE = ARG_VALUES.get("--confidence-mode", "legacy")
if CONFIDENCE_MODE not in ("legacy", "strict"):
    raise SystemExit("--confidence-mode must be 'legacy' or 'strict'")
SOURCE_INDEX_PATH = os.path.abspath(ARG_VALUES["--source-index"]) if "--source-index" in ARG_VALUES else os.path.join(REPO, "repository-index.jsonl")
SOURCE_ASSIGNMENTS_PATH = os.path.abspath(ARG_VALUES["--source-assignments"]) if "--source-assignments" in ARG_VALUES else os.path.join(IDX, "assignments.jsonl")
ROUTING_ENTRY_PATHS = [os.path.abspath(path) for path in ARG_REPEATED.get("--routing-entry", [])]

# ---------------------------------------------------------------- utils
def slug(s):
    # Must match update_repo_skills_router.mjs slug(): NFKD normalize, lowercase,
    # collapse non-alphanumerics to '-', trim leading/trailing '-', fall back to
    # "item" on empty (empty slugs otherwise produce a broken page filename).
    normalized = unicodedata.normalize("NFKD", s)
    return re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-") or "item"

def markdown_escape(s):
    # Must match update_repo_skills_router.mjs markdownEscape() plus backtick
    # escaping: trim, then escape '|', newline->space, and backtick->'\`'.
    return s.strip().replace("|", "\\|").replace("\n", " ").replace("`", "\\`")

def stable_json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"

def stable_json_sorted(obj):
    # For build-metadata only: recursive key-sorted serialization, matching the
    # mjs stableJsonValue. The taxonomy and per-record jsonl keep insertion
    # order (compact), so they must NOT go through this function.
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

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

# ------------------------------------------------------- preserved provenance
def load_source_index(path):
    """Read the previously written central repository index, if any.

    The generated records carry no source commit of their own: `repo_id`, the
    description and the target root are all derived from the local tree. Anything
    this script cannot regenerate — the pinned source commit, the source skill
    root, aliases — must survive a rebuild, so known provenance is copied field by
    field from the index that is already on disk. Nothing is invented: a field the
    old index leaves null stays null and is counted as unpinned.
    """
    if not os.path.isfile(path):
        return {}
    records = {}
    with open(path, encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"failed to read source index {path}:{line_no}: {exc}") from exc
            if not isinstance(record, dict):
                raise SystemExit(f"failed to read source index {path}:{line_no}: expected a JSON object")
            key = record.get("skill_id")
            if isinstance(key, str) and key:
                records[key] = record
    return records

SOURCE_RECORDS = load_source_index(SOURCE_INDEX_PATH)
# Fields the generator cannot recompute from the local skill tree.
PROVENANCE_FIELDS = ("schema_version", "legacy_repo_id", "source_commit", "source_skill_root", "aliases")
preserved_provenance_count = [0]
preserved_commit_count = [0]
unpinned_record_count = [0]

# ------------------------------------------------------- preserved assignments
def load_source_assignments(path):
    """Read the previously written central assignment index, if any.

    `confidence` and `confidence_basis` are external routing decisions, and the v2
    runtime metadata fragment deliberately carries neither (see the maintenance
    contract). Rebuilding without reading the index that is already on disk would
    therefore silently drop every recorded decision back to the legacy default, so
    the prior row is the second source in the fallback chain, exactly as in the mjs
    writer (routing handoff -> prior index row).
    """
    if not os.path.isfile(path):
        return {}
    entries = {}
    with open(path, encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"failed to read source assignments {path}:{line_no}: {exc}") from exc
            if not isinstance(record, dict):
                raise SystemExit(f"failed to read source assignments {path}:{line_no}: expected a JSON object")
            key = (record.get("skill_id"), record.get("area"), record.get("family"))
            if all(isinstance(part, str) and part for part in key):
                entries[key] = record
    return entries

SOURCE_ASSIGNMENTS = load_source_assignments(SOURCE_ASSIGNMENTS_PATH)
preserved_confidence_count = [0]

# --------------------------------------------------------- routing handoff files
def load_routing_entries(paths):
    """Read verified external classification handoffs (`--routing-entry FILE`).

    Python twin of update_repo_skills_router.mjs readRoutingEntries(): the handoff is
    the production routing decision record, so it is what supplies assignment
    confidence/basis and the pinned source identity the runtime metadata omits. One
    entry per skill_id — a second entry for the same skill is an error instead of a
    silent last-writer-wins.
    """
    entries = {}
    sources = {}
    for path in paths:
        if not os.path.isfile(path):
            raise SystemExit(f"routing entry not found: {path}")
        with open(path, encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise SystemExit(f"failed to read routing entry {path}:{line_no}: {exc}") from exc
                if not isinstance(entry, dict):
                    raise SystemExit(f"failed to read routing entry {path}:{line_no}: expected a JSON object")
                skill_id = entry.get("skill_id")
                if not isinstance(skill_id, str) or not skill_id:
                    raise SystemExit(f"routing entry {path}:{line_no}: an entry needs a skill_id")
                if skill_id in entries:
                    raise SystemExit(f"duplicate routing handoff for skill {skill_id}")
                assignments = entry.get("assignments", [])
                if not isinstance(assignments, list):
                    raise SystemExit(f"routing entry {path}:{line_no}: assignments must be a list")
                for assignment in assignments:
                    if (not isinstance(assignment, dict)
                            or not isinstance(assignment.get("area"), str)
                            or not isinstance(assignment.get("family"), str)):
                        raise SystemExit(f"routing entry {path}:{line_no}: every assignment needs an area and a family")
                entries[skill_id] = entry
                sources[skill_id] = path
    return entries, sources

ROUTING_ENTRIES, ROUTING_ENTRY_SOURCES = load_routing_entries(ROUTING_ENTRY_PATHS)
routing_confidence_count = [0]

# A handoff is only trustworthy when it describes THIS build: one that names an
# unknown skill, another repository, or a different assignment set is rejected
# rather than applied to the nearest match (mirrors the mjs validation).
SKILL_BY_ID = {s["id"]: s for s in skills}
for _skill_id, _entry in ROUTING_ENTRIES.items():
    _skill = SKILL_BY_ID.get(_skill_id)
    if _skill is None:
        raise SystemExit(f"routing handoff {_skill_id} is not part of this router build")
    if _entry.get("repo_id") != _skill["repo_id"]:
        raise SystemExit(f"routing handoff repo_id does not match {_skill_id}")
    _handoff_pairs = {(a.get("area"), a.get("family")) for a in _entry.get("assignments", [])}
    _metadata_pairs = {(a.get("area"), a.get("family")) for a in _skill["assignments"]}
    if _handoff_pairs != _metadata_pairs:
        raise SystemExit(f"routing handoff assignments do not match {_skill_id} metadata")

def routing_assignment(skill_id, asg):
    handoff = ROUTING_ENTRIES.get(skill_id)
    if handoff is None:
        return None
    for candidate in handoff.get("assignments", []):
        if candidate.get("area") == asg.get("area") and candidate.get("family") == asg.get("family"):
            return candidate
    return None

def prior_assignment(skill_id, asg):
    return SOURCE_ASSIGNMENTS.get((skill_id, asg.get("area"), asg.get("family")))

# ------------------------------------------------------------ recorded provenance
PROVENANCE_BLOCK = re.compile(r"```json\r?\n([\s\S]*?)\r?\n```")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)

def first_text(*candidates):
    """First candidate that is a non-empty string, trimmed; nothing is invented."""
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None

def first_commit(*candidates):
    """First candidate that is a full 40-hex commit; anything else is not a commit.

    Mirrors the mjs writer: a partial or malformed value falls through to the next
    source instead of being recorded, because a non-hash would look pinned while
    proving nothing.
    """
    for candidate in candidates:
        if isinstance(candidate, str) and COMMIT_RE.match(candidate.strip()):
            return candidate.strip().lower()
    return None

def normalize_github_url(url):
    candidate = first_text(url)
    if candidate is None:
        return None
    candidate = candidate.rstrip("/")
    if candidate.lower().endswith(".git"):
        candidate = candidate[:-4].rstrip("/")
    return candidate if re.match(r"^https?://github\.com/[^/\s]+/[^/\s]+$", candidate) else None

def read_provenance(skill_id):
    """Read the first machine-readable block of references/repo-provenance.md.

    Mirrors update_repo_skills_router.mjs readProvenance(): the importer records
    repository.remote_url / repository.commit / generated_skill.root there, and a
    missing or unparsable block simply means "no provenance recorded" — never a
    fabricated commit.
    """
    path = os.path.join(REPO, skill_id, "references", "repo-provenance.md")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f"failed to read provenance at {path}: {exc}") from exc
    match = PROVENANCE_BLOCK.search(text)
    if match is None:
        return {}
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}

provenance_record_count = [0]
ignored_commit_count = [0]

# ---------------------------------------------------------------- repository records
def make_repository_records(skills):
    records = []
    for s in sorted(skills, key=lambda s:(s["repo_id"],s["id"])):
        prior = SOURCE_RECORDS.get(s["id"]) or {}
        handoff = ROUTING_ENTRIES.get(s["id"]) or {}
        provenance = read_provenance(s["id"])
        provenance_repository = provenance.get("repository") if isinstance(provenance.get("repository"), dict) else {}
        provenance_skill = provenance.get("generated_skill") if isinstance(provenance.get("generated_skill"), dict) else {}
        if provenance:
            provenance_record_count[0] += 1

        # Precedence mirrors makeRepositoryRecords() in the mjs writer:
        # routing handoff -> prior index row -> repo-provenance.md -> derived.
        recorded_url = first_text(handoff.get("source_url"), prior.get("source_url"), provenance_repository.get("remote_url"))
        source_url = normalize_github_url(recorded_url)
        if source_url is None:
            if recorded_url is not None:
                raise SystemExit(f"source_url for {s['id']} is not a GitHub repository URL: {recorded_url}")
            source_url = f"https://github.com/{s['repo_id']}"

        recorded_commit = first_text(handoff.get("source_commit"), prior.get("source_commit"), provenance_repository.get("commit"))
        commit = first_commit(handoff.get("source_commit"), prior.get("source_commit"), provenance_repository.get("commit"))
        if commit is None and recorded_commit is not None:
            # Recorded but not a full commit: dropped rather than rewritten, and
            # counted so "unpinned" is never silently presented as "pinned".
            ignored_commit_count[0] += 1

        record = {
            "schema_version":1, "repo_id":s["repo_id"],
            "legacy_repo_id":first_text(handoff.get("legacy_repo_id"), prior.get("legacy_repo_id")),
            "repo_name":s["repo_id"].split("/")[-1],
            "skill_id":s["id"], "source_url":source_url,
            "source_commit":commit,
            "source_skill_root":first_text(handoff.get("source_skill_root"), handoff.get("skill_root"), prior.get("source_skill_root"), provenance_skill.get("root")),
            "target_skill_root":f"repo-skills/{s['id']}",
            "aliases":sorted(prior["aliases"]) if isinstance(prior.get("aliases"), list) and all(isinstance(a, str) for a in prior["aliases"]) else [],
            "description":s["desc"],
        }
        # Known provenance is preserved, never regenerated and never invented.
        if prior:
            carried = sum(1 for field in PROVENANCE_FIELDS if field in prior)
            if carried:
                preserved_provenance_count[0] += 1
        if record["source_commit"]:
            preserved_commit_count[0] += 1
        else:
            unpinned_record_count[0] += 1
        records.append(record)
    return records

repo_records = make_repository_records(skills)

# ---------------------------------------------------------------- assignment records
tax_order={}; o=0
for a in tax["areas"]:
    for f in a["families"]:
        tax_order[f"{a['name']}\0{f['name']}"]=o; o+=1
VALID_CONFIDENCE = ("high", "medium", "low")
missing_confidence_count = [0]

def resolve_confidence(repo_id, skill_id, asg):
    """Return the assignment confidence for the central assignment index.

    Contract (mirrors update_repo_skills_router.mjs): confidence is external routing
    evidence and is never silently defaulted. Precedence is the routing handoff, then
    the prior assignment index row, then — for metadata written before the v2 contract
    split confidence out of the runtime graph — the metadata fragment itself. A value
    that is present but invalid is a hard error, because a typo must not be laundered
    into a counted warning. In `strict` mode a missing confidence aborts the build; in
    `legacy` mode it is still surfaced as a counted warning (never silent).
    """
    handoff_assignment = routing_assignment(skill_id, asg)
    recorded = handoff_assignment.get("confidence") if handoff_assignment is not None else None
    if recorded is not None:
        if recorded in VALID_CONFIDENCE:
            routing_confidence_count[0] += 1
            return recorded
        raise SystemExit(
            f"routing entry for {repo_id}/{skill_id} ({asg.get('area')}/{asg.get('family')}) has an invalid "
            f"confidence ({recorded!r}); must be one of high/medium/low."
        )
    prior = prior_assignment(skill_id, asg)
    recorded = prior.get("confidence") if prior is not None else None
    if recorded is not None:
        if recorded not in VALID_CONFIDENCE:
            raise SystemExit(
                f"assignment index {SOURCE_ASSIGNMENTS_PATH} records an invalid confidence "
                f"({recorded!r}) for {repo_id}/{skill_id} ({asg.get('area')}/{asg.get('family')}); "
                "must be one of high/medium/low."
            )
        if CONFIDENCE_MODE != "strict":
            # Legacy mode reproduces the index that is already on disk, so a recorded
            # decision is carried over instead of being replaced by the default. It is
            # NOT evidence: that row may itself have been written by the legacy default,
            # so `strict` deliberately refuses it and needs a routing entry.
            preserved_confidence_count[0] += 1
            return recorded
    val = asg.get("confidence")
    if CONFIDENCE_MODE != "strict" and val in VALID_CONFIDENCE:
        return val
    if CONFIDENCE_MODE == "strict":
        raise SystemExit(
            f"assignment for {repo_id} ({asg.get('area')}/{asg.get('family')}) has no recorded confidence; "
            "strict mode accepts only a verified routing decision (--routing-entry FILE) or an explicit "
            "metadata confidence, never a prior index row, which may itself be a legacy default. "
            "Reimport with explicit confidence and add the record to the central routing decision ledger."
        )
    missing_confidence_count[0] += 1
    return "high"

assign_records=[]
VALID_CONFIDENCE_BASIS = ("committed", "materialized-unpinned", "external-verified")
invalid_confidence_basis_count = [0]

def resolve_confidence_basis(repo_id, skill_id, asg):
    """Return the assignment confidence_basis for the central assignment index.

    BUG-P1-17: the official mjs writer propagates `confidence_basis` (schema
    schema-evolved in v40/v42) so provenance survives every generate/export.
    The Python rebuild must not silently drop it. It is OPTIONAL: omit it when
    the source carries none, and in `strict` mode reject an unknown value so
    the index never records a basis the consumers cannot parse. The routing
    handoff is consulted first, then the prior assignment row, then the metadata
    fragment (mirrors makeAssignmentRecords() in the mjs writer).
    """
    handoff_assignment = routing_assignment(skill_id, asg)
    val = handoff_assignment.get("confidence_basis") if handoff_assignment is not None else None
    if val is None:
        prior = prior_assignment(skill_id, asg)
        val = prior.get("confidence_basis") if prior is not None else None
    if val is None:
        val = asg.get("confidence_basis")
    if val is None:
        return None
    if val in VALID_CONFIDENCE_BASIS:
        return val
    if CONFIDENCE_MODE == "strict":
        raise SystemExit(
            f"assignment for {repo_id} has an invalid confidence_basis ({val!r}); "
            "must be one of committed/materialized-unpinned/external-verified. "
            "Reimport with a valid basis or drop the field."
        )
    invalid_confidence_basis_count[0] += 1
    return None

REPO_RECORD_BY_SKILL = {r["skill_id"]: r for r in repo_records}

for s in skills:
    for asg in s["assignments"]:
        repository_record = REPO_RECORD_BY_SKILL.get(s["id"]) or {}
        rec = {
            "repo_id":s["repo_id"],
            # The mjs writer takes this from the repository record it just built
            # (handoff -> prior), so a renamed legacy id stays attached to the skill.
            "legacy_repo_id":repository_record.get("legacy_repo_id"),
            "skill_id":s["id"],
            "area":asg["area"], "family":asg["family"],
            "confidence":resolve_confidence(s["repo_id"], s["id"], asg),
        }
        basis = resolve_confidence_basis(s["repo_id"], s["id"], asg)
        if basis is not None:
            rec["confidence_basis"] = basis
        assign_records.append(rec)
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
  ocsid-role: "operating"
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
files[os.path.join("references","index","build-metadata.json")] = stable_json_sorted({
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

if missing_confidence_count[0] > 0:
    print(
        f"warning: {missing_confidence_count[0]} assignment(s) carry no confidence anywhere "
        f"(no routing entry, no prior index row, no metadata) and were defaulted to 'high' in "
        f"legacy mode; record them in the central routing decision ledger and pass "
        f"--routing-entry FILE (or use --confidence-mode=strict to require explicit confidence)",
        file=sys.stderr,
    )

if invalid_confidence_basis_count[0] > 0:
    print(
        f"warning: {invalid_confidence_basis_count[0]} assignment(s) carry a non-empty "
        f"confidence_basis outside {{committed, materialized-unpinned, external-verified}} "
        f"and were dropped in legacy mode; use --confidence-mode=strict to require a valid basis",
        file=sys.stderr,
    )

# Provenance is reported on every run, in both modes: "router is current" says the
# structure reproduces, not that the sources are pinned, so the pinning status has to
# be visible instead of assumed.
print(
    f"provenance: {len(repo_records)} repository record(s), "
    f"{preserved_commit_count[0]} pinned to a source commit, "
    f"{unpinned_record_count[0]} unpinned (source_commit null), "
    f"{preserved_provenance_count[0]} carried over from {SOURCE_INDEX_PATH}, "
    f"{provenance_record_count[0]} with a repo-provenance.md block",
    file=sys.stderr,
)
print(
    f"confidence: {routing_confidence_count[0]} assignment(s) from routing entries, "
    f"{preserved_confidence_count[0]} preserved from {SOURCE_ASSIGNMENTS_PATH}, "
    f"{missing_confidence_count[0]} defaulted in legacy mode; "
    f"{len(ROUTING_ENTRIES)} handoff(s) supplied via {len(ROUTING_ENTRY_PATHS)} --routing-entry file(s)",
    file=sys.stderr,
)
if ignored_commit_count[0] > 0:
    print(
        f"warning: {ignored_commit_count[0]} repository record(s) carried a source_commit that is "
        f"not a full 40-hex commit; it was dropped rather than recorded, so the record stays unpinned",
        file=sys.stderr,
    )
if unpinned_record_count[0] > 0:
    print(
        f"warning: {unpinned_record_count[0]} repository record(s) have no pinned source_commit; "
        f"the rebuild preserves what the index already records but cannot recover a commit that "
        f"was never recorded",
        file=sys.stderr,
    )

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
