from __future__ import annotations

import json
import hashlib
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from scripts.domain_common import (
    FrontmatterError,
    copy_companion_resources,
    git_head_commit,
    parse_frontmatter,
)

ROOT = Path(__file__).resolve().parents[2]
REBUILD = ROOT / "scripts" / "rebuild_router.py"
IMPORT = ROOT / "scripts" / "import_thirdparty.py"
LIVE_INDEX = ROOT / "skills" / "repositories" / "repo-skills" / "repository-index.jsonl"
TAXONOMY = ROOT / "skills" / "repositories" / "repo-skills-router" / "references" / "index" / "taxonomy.json"


class DomainScriptTests(unittest.TestCase):
    def test_companion_resource_copy_preserves_supported_skill_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            for relative in ("references/guide.md", "scripts/run.py", "assets/schema.json", "agents/openai.yaml", "models/model.md"):
                path = source / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(relative, encoding="utf-8")
            (source / "SKILL.md").write_text("source skill", encoding="utf-8")

            copied = copy_companion_resources(source, target)

            self.assertEqual(set(copied), {"agents", "assets", "models", "references", "scripts"})
            self.assertTrue((target / "references" / "guide.md").is_file())
            self.assertTrue((target / "models" / "model.md").is_file())
            self.assertFalse((target / "SKILL.md").exists())

    def test_frontmatter_parser_handles_multiline_quoted_and_folded_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            quoted = Path(directory) / "quoted.md"
            quoted.write_text(
                '---\nname: example\ndescription: "A molecular workflow that\n  spans two lines."\nmetadata:\n  ocsid-role: operating\n---\n\n# Body\n',
                encoding="utf-8",
            )
            folded = Path(directory) / "folded.md"
            folded.write_text(
                "---\nname: folded\ndescription: >-\n  Analyze molecular structures\n  with explicit validation.\n---\n\n# Folded\n",
                encoding="utf-8",
            )

            quoted_metadata, quoted_body = parse_frontmatter(quoted)
            folded_metadata, _ = parse_frontmatter(folded)

        self.assertEqual(quoted_metadata["description"], "A molecular workflow that spans two lines.")
        self.assertIn("# Body", quoted_body)
        self.assertEqual(folded_metadata["description"], "Analyze molecular structures with explicit validation.")

    def test_frontmatter_parser_rejects_an_unterminated_quoted_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            skill = Path(directory) / "SKILL.md"
            skill.write_text('---\nname: broken\ndescription: "unterminated\n---\n', encoding="utf-8")
            with self.assertRaises(FrontmatterError):
                parse_frontmatter(skill)

    def test_generated_descriptions_do_not_retain_yaml_quote_delimiters(self) -> None:
        records = [json.loads(line) for line in LIVE_INDEX.read_text(encoding="utf-8").splitlines() if line]
        quoted = [record["skill_id"] for record in records if record["description"].startswith(('"', "'"))]
        self.assertEqual(quoted, [])

    def test_quantum_computing_scope_does_not_claim_quantum_chemistry(self) -> None:
        taxonomy = json.loads(TAXONOMY.read_text(encoding="utf-8"))
        family = next(
            family
            for area in taxonomy["areas"]
            for family in area["families"]
            if family["name"] == "Quantum Computing"
        )
        self.assertNotIn("quantum chemistry", family["scope"].lower())

    def test_output_dir_does_not_touch_live_repository_index(self) -> None:
        before = LIVE_INDEX.stat()
        time.sleep(0.01)
        with tempfile.TemporaryDirectory() as output_dir:
            result = subprocess.run(
                [sys.executable, str(REBUILD), "--output-dir", output_dir],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((Path(output_dir) / "references" / "index" / "taxonomy.json").is_file())
        self.assertEqual(LIVE_INDEX.stat().st_mtime_ns, before.st_mtime_ns)

    def test_build_metadata_uses_key_sorted_serialization_with_consistent_digests(self) -> None:
        """Locks the cross-language contract with update_repo_skills_router.mjs.

        build-metadata.json MUST serialize keys in sorted order (stable_json_sorted),
        matching the mjs stableJsonValue, and its two *_sha256 digests MUST be the
        sha256 of the exact repositories.jsonl / assignments.jsonl bytes written.
        This is what keeps the Python twin byte-identical to the upstream mjs so the
        two generators never report each other stale.

        Note: key sorting is meaningful here because build-metadata's source dict is
        written in non-sorted insertion order below (schema_version first, ...), so a
        plain insertion-order dump would differ from key-sorted.
        """
        with tempfile.TemporaryDirectory() as output_dir:
            result = subprocess.run(
                [sys.executable, str(REBUILD), "--output-dir", output_dir],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            index = Path(output_dir) / "references" / "index"
            metadata = json.loads((index / "build-metadata.json").read_text(encoding="utf-8"))

            # Keys must appear in sorted (code-point) order, like mjs stableJsonValue.
            keys = list(metadata.keys())
            self.assertEqual(keys, sorted(keys))

            # The declared digests must re-hash the actual written index files.
            repo_bytes = (index / "repositories.jsonl").read_bytes()
            assign_bytes = (index / "assignments.jsonl").read_bytes()
            self.assertEqual(metadata["repository_index_sha256"], "sha256:" + hashlib.sha256(repo_bytes).hexdigest())
            self.assertEqual(metadata["assignment_index_sha256"], "sha256:" + hashlib.sha256(assign_bytes).hexdigest())


    def test_import_dry_run_uses_explicit_source_root_and_reports_count(self) -> None:
        with tempfile.TemporaryDirectory() as source_dir:
            skill_dir = Path(source_dir) / "SciAgent-Skills" / "skills" / "genomics-bioinformatics"
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\nname: genomics-bioinformatics\ndescription: Test fixture.\n---\n\n# Fixture\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(IMPORT), "--source-root", source_dir, "--dry-run"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Would import 1 repo-skills", result.stdout)

    def test_import_rejects_a_missing_source_root(self) -> None:
        missing = ROOT / "does-not-exist-third-party-source"
        result = subprocess.run(
            [sys.executable, str(IMPORT), "--source-root", str(missing), "--dry-run"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("third-party source root does not exist", result.stderr)

    # ------------------------------------------------------------------ P2-01
    # router provenance + confidence evidence chain: the rebuild must not silently
    # ignore a strict request, must not drop recorded provenance (`repo-provenance.md`
    # and the prior index), must accept the verified routing handoff as evidence, and
    # must never let a legacy default pass itself off as recorded evidence.

    def run_rebuild(self, *args: str):
        return subprocess.run(
            [sys.executable, str(REBUILD), *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def recorded_provenance_commits(self) -> dict:
        """skill_id -> commit recorded in the skill's repo-provenance.md block."""
        fence = chr(96) * 3
        pattern = re.compile(fence + r"json\r?\n([\s\S]*?)\r?\n" + fence)
        commits = {}
        for path in sorted((ROOT / "skills" / "repositories" / "repo-skills").glob("*/references/repo-provenance.md")):
            match = pattern.search(path.read_text(encoding="utf-8"))
            if match is None:
                continue
            block = json.loads(match.group(1))
            commit = (block.get("repository") or {}).get("commit")
            if isinstance(commit, str):
                commits[path.parents[1].name] = commit
        return commits

    def live_records(self) -> list:
        return [json.loads(line) for line in LIVE_INDEX.read_text(encoding="utf-8").splitlines() if line]

    def generated_repositories(self, output_dir: Path) -> list:
        return [
            json.loads(line)
            for line in (output_dir / "references" / "index" / "repositories.jsonl").read_text(encoding="utf-8").splitlines()
            if line
        ]

    def generated_assignments(self, output_dir: Path) -> list:
        return [
            json.loads(line)
            for line in (output_dir / "references" / "index" / "assignments.jsonl").read_text(encoding="utf-8").splitlines()
            if line
        ]

    def test_rebuild_rejects_unknown_and_valueless_options(self) -> None:
        """Silently ignored options are how a strict build ran in legacy mode."""
        unknown = self.run_rebuild("--bogus")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown option: --bogus", unknown.stderr)
        self.assertIn("usage: python rebuild_router.py", unknown.stderr)

        valueless = self.run_rebuild("--confidence-mode")
        self.assertNotEqual(valueless.returncode, 0)
        self.assertIn("--confidence-mode requires a value", valueless.stderr)

        entry_valueless = self.run_rebuild("--routing-entry")
        self.assertNotEqual(entry_valueless.returncode, 0)
        self.assertIn("--routing-entry requires a value", entry_valueless.stderr)

        stray = self.run_rebuild("legacy")
        self.assertNotEqual(stray.returncode, 0)
        self.assertIn("unknown argument: legacy", stray.stderr)

    def test_equals_form_confidence_mode_is_honoured(self) -> None:
        """`--confidence-mode=strict` is the form the script's own warning suggests."""
        equals = self.run_rebuild("--confidence-mode=strict")
        self.assertNotEqual(equals.returncode, 0)
        self.assertIn("has no recorded confidence", equals.stderr)

        # The separated form must behave identically (one strict semantic, two spellings).
        spaced = self.run_rebuild("--confidence-mode", "strict")
        self.assertNotEqual(spaced.returncode, 0)
        self.assertIn("has no recorded confidence", spaced.stderr)

        # A legal value still works, and an illegal one is still refused by name.
        self.assertEqual(self.run_rebuild("--confidence-mode=legacy").returncode, 0)
        invalid = self.run_rebuild("--confidence-mode=loose")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("--confidence-mode must be 'legacy' or 'strict'", invalid.stderr)

    def test_strict_mode_refuses_a_prior_index_row_as_evidence(self) -> None:
        """The 127 live rows were themselves written by the legacy default, so strict
        must not accept them: only a verified routing decision is evidence."""
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "out"
            result = self.run_rebuild(
                "--output-dir",
                str(output_dir),
                "--confidence-mode=strict",
                "--source-assignments",
                str(ROOT / "skills" / "repositories" / "repo-skills-router" / "references" / "index" / "assignments.jsonl"),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("has no recorded confidence", result.stderr)
            self.assertIn("never a prior index row", result.stderr)
            self.assertIn("--routing-entry", result.stderr)

    def test_repo_provenance_commit_reaches_the_repository_index(self) -> None:
        """Report P2-01 item 5: the rebuild must consume the provenance data flow
        instead of writing source_commit=None while repo-provenance.md records it."""
        commits = self.recorded_provenance_commits()
        self.assertTrue(commits, "fixture precondition: some skills record a provenance commit")

        records = self.live_records()
        for record in records:  # strip every recorded commit from the prior index
            record["source_commit"] = None

        with tempfile.TemporaryDirectory() as directory:
            source_index = Path(directory) / "repository-index.jsonl"
            source_index.write_text(
                "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
                encoding="utf-8",
            )
            output_dir = Path(directory) / "out"
            result = self.run_rebuild("--output-dir", str(output_dir), "--source-index", str(source_index))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"{len(commits)} pinned to a source commit", result.stderr)
            generated = self.generated_repositories(output_dir)

        pinned = {record["skill_id"]: record["source_commit"] for record in generated if record["source_commit"]}
        self.assertEqual(pinned, commits)
        unpinned = [record for record in generated if record["skill_id"] not in commits]
        self.assertTrue(unpinned)
        self.assertTrue(all(record["source_commit"] is None for record in unpinned))

    def test_rebuild_preserves_recorded_provenance(self) -> None:
        """A rebuild must not erase provenance it cannot regenerate, and must not
        invent any: a record with no evidence anywhere stays unpinned."""
        records = self.live_records()
        target = records[0]
        target["source_commit"] = "0" * 40
        target["source_skill_root"] = "skills/fixture"
        target["aliases"] = ["fixture-alias"]

        with tempfile.TemporaryDirectory() as directory:
            source_index = Path(directory) / "repository-index.jsonl"
            source_index.write_text(
                "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
                encoding="utf-8",
            )
            output_dir = Path(directory) / "out"
            result = self.run_rebuild("--output-dir", str(output_dir), "--source-index", str(source_index))
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = self.generated_repositories(output_dir)

        preserved = next(record for record in generated if record["skill_id"] == target["skill_id"])
        self.assertEqual(preserved["source_commit"], "0" * 40)
        self.assertEqual(preserved["source_skill_root"], "skills/fixture")
        self.assertEqual(preserved["aliases"], ["fixture-alias"])
        # Unrecorded provenance is never fabricated, and the widened fixture value is
        # not leaked onto any other record.
        self.assertFalse(any(record["aliases"] == ["fixture-alias"] for record in generated if record is not preserved))
        self.assertFalse(any(record["source_commit"] == "0" * 40 for record in generated if record is not preserved))

    def test_a_malformed_recorded_commit_is_dropped_not_recorded(self) -> None:
        """A value that is not a full commit hash must not look pinned."""
        records = self.live_records()
        target = records[0]
        target["source_commit"] = "deadbeef"

        with tempfile.TemporaryDirectory() as directory:
            source_index = Path(directory) / "repository-index.jsonl"
            source_index.write_text(
                "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
                encoding="utf-8",
            )
            output_dir = Path(directory) / "out"
            result = self.run_rebuild("--output-dir", str(output_dir), "--source-index", str(source_index))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("not a full 40-hex commit", result.stderr)
            generated = self.generated_repositories(output_dir)

        dropped = next(record for record in generated if record["skill_id"] == target["skill_id"])
        self.assertIn(dropped["source_commit"], (None, self.recorded_provenance_commits().get(target["skill_id"])))
        self.assertNotEqual(dropped["source_commit"], "deadbeef")

    def test_source_assignments_confidence_is_preserved(self) -> None:
        """A recorded decision survives a rebuild; legacy mode must not re-default it."""
        with tempfile.TemporaryDirectory() as directory:
            baseline_dir = Path(directory) / "baseline"
            self.assertEqual(self.run_rebuild("--output-dir", str(baseline_dir)).returncode, 0)
            assignments = self.generated_assignments(baseline_dir)
            first = assignments[0]
            first["confidence"] = "medium"
            first["confidence_basis"] = "committed"

            source_assignments = Path(directory) / "assignments.jsonl"
            source_assignments.write_text(
                "\n".join(json.dumps(record, ensure_ascii=False) for record in assignments) + "\n",
                encoding="utf-8",
            )
            output_dir = Path(directory) / "out"
            result = self.run_rebuild("--output-dir", str(output_dir), "--source-assignments", str(source_assignments))
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = self.generated_assignments(output_dir)

        preserved = next(
            record
            for record in generated
            if (record["skill_id"], record["area"], record["family"]) == (first["skill_id"], first["area"], first["family"])
        )
        self.assertEqual(preserved["confidence"], "medium")
        self.assertEqual(preserved["confidence_basis"], "committed")

    def test_routing_entry_supplies_assignment_confidence(self) -> None:
        """The verified routing handoff is the evidence `strict` needs; without it
        strict can only abort, because the prior rows are not evidence."""
        with tempfile.TemporaryDirectory() as directory:
            legacy_dir = Path(directory) / "legacy"
            baseline = self.run_rebuild("--output-dir", str(legacy_dir))
            self.assertEqual(baseline.returncode, 0, baseline.stderr)
            assignments = self.generated_assignments(legacy_dir)
            first = assignments[0]

            # A partial handoff for one skill: the recorded decision wins.
            partial = Path(directory) / "partial-entry.jsonl"
            partial.write_text(
                json.dumps(
                    {
                        "skill_id": first["skill_id"],
                        "repo_id": first["repo_id"],
                        "assignments": [
                            {
                                "area": record["area"],
                                "family": record["family"],
                                "confidence": "low",
                                "confidence_basis": "external-verified",
                            }
                            for record in assignments
                            if record["skill_id"] == first["skill_id"]
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            partial_dir = Path(directory) / "partial"
            result = self.run_rebuild("--output-dir", str(partial_dir), "--routing-entry", str(partial))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("from routing entries", result.stderr)
            recorded = [
                record for record in self.generated_assignments(partial_dir) if record["skill_id"] == first["skill_id"]
            ]
            self.assertTrue(recorded)
            self.assertTrue(all(record["confidence"] == "low" for record in recorded))
            self.assertTrue(all(record["confidence_basis"] == "external-verified" for record in recorded))

            # A complete handoff satisfies strict and reproduces the legacy bytes.
            complete = Path(directory) / "complete-entry.jsonl"
            complete.write_text(
                "\n".join(
                    json.dumps(
                        {
                            "skill_id": skill_id,
                            "repo_id": next(record["repo_id"] for record in assignments if record["skill_id"] == skill_id),
                            "assignments": [
                                {"area": record["area"], "family": record["family"], "confidence": record["confidence"]}
                                for record in assignments
                                if record["skill_id"] == skill_id
                            ],
                        }
                    )
                    for skill_id in sorted({record["skill_id"] for record in assignments})
                )
                + "\n",
                encoding="utf-8",
            )
            strict_dir = Path(directory) / "strict"
            strict = self.run_rebuild(
                "--output-dir", str(strict_dir), "--confidence-mode=strict", "--routing-entry", str(complete)
            )
            self.assertEqual(strict.returncode, 0, strict.stderr)
            self.assertNotIn("carry no confidence", strict.stderr)
            self.assertEqual(
                (strict_dir / "references" / "index" / "assignments.jsonl").read_text(encoding="utf-8"),
                (legacy_dir / "references" / "index" / "assignments.jsonl").read_text(encoding="utf-8"),
            )

    def test_routing_entry_is_validated_against_this_build(self) -> None:
        """A handoff that describes another skill, repository, or assignment set is
        rejected instead of being applied to the nearest match."""
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "legacy"
            self.assertEqual(self.run_rebuild("--output-dir", str(output_dir)).returncode, 0)
            assignments = self.generated_assignments(output_dir)
            first = assignments[0]
            own = [
                {"area": record["area"], "family": record["family"], "confidence": "high"}
                for record in assignments
                if record["skill_id"] == first["skill_id"]
            ]

            def write(name: str, entry: dict) -> Path:
                path = Path(directory) / name
                path.write_text(json.dumps(entry) + "\n", encoding="utf-8")
                return path

            duplicate = Path(directory) / "duplicate.jsonl"
            duplicate.write_text(write("a.jsonl", {"skill_id": first["skill_id"], "repo_id": first["repo_id"], "assignments": own}).read_text(encoding="utf-8") * 2, encoding="utf-8")
            result = self.run_rebuild("--output-dir", str(Path(directory) / "d1"), "--routing-entry", str(duplicate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"duplicate routing handoff for skill {first['skill_id']}", result.stderr)

            unknown = write("unknown.jsonl", {"skill_id": "not-a-managed-skill", "repo_id": "x/y", "assignments": own})
            result = self.run_rebuild("--output-dir", str(Path(directory) / "d2"), "--routing-entry", str(unknown))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("is not part of this router build", result.stderr)

            wrong_repo = write("repo.jsonl", {"skill_id": first["skill_id"], "repo_id": "someone/else", "assignments": own})
            result = self.run_rebuild("--output-dir", str(Path(directory) / "d3"), "--routing-entry", str(wrong_repo))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("routing handoff repo_id does not match", result.stderr)

            wrong_set = write(
                "set.jsonl",
                {"skill_id": first["skill_id"], "repo_id": first["repo_id"], "assignments": own[:-1]},
            )
            result = self.run_rebuild("--output-dir", str(Path(directory) / "d4"), "--routing-entry", str(wrong_set))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("routing handoff assignments do not match", result.stderr)

            invalid = write(
                "invalid.jsonl",
                {
                    "skill_id": first["skill_id"],
                    "repo_id": first["repo_id"],
                    "assignments": [dict(own[0], confidence="certain"), *own[1:]],
                },
            )
            result = self.run_rebuild("--output-dir", str(Path(directory) / "d5"), "--routing-entry", str(invalid))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("has an invalid confidence", result.stderr)

    def test_import_records_the_source_commit_when_the_tree_is_git(self) -> None:
        """Provenance must be captured where it is known: a git source tree is pinned
        to a real commit, and a plain directory yields none rather than a guess."""
        with tempfile.TemporaryDirectory() as directory:
            plain = Path(directory) / "plain"
            plain.mkdir()
            self.assertIsNone(git_head_commit(str(plain)))
            self.assertIsNone(git_head_commit(""))
            self.assertIsNone(git_head_commit(str(Path(directory) / "does" / "not" / "exist")))

            checkout = Path(directory) / "checkout"
            checkout.mkdir()

            def git(*args: str):
                return subprocess.run(
                    [
                        "git", "-C", str(checkout),
                        "-c", "user.name=fixture", "-c", "user.email=fixture@example.com",
                        *args,
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )

            if git("init").returncode != 0:
                self.skipTest("git is not available")
            (checkout / "file.txt").write_text("fixture", encoding="utf-8")
            self.assertEqual(git("add", ".").returncode, 0)
            if git("commit", "-m", "fixture").returncode != 0:
                self.skipTest("git commit is unavailable in this environment")
            expected = git("rev-parse", "HEAD").stdout.strip().lower()
            self.assertRegex(expected, r"^[0-9a-f]{40}$")
            self.assertEqual(git_head_commit(str(checkout)), expected)
            # A path that does not exist yet resolves to the nearest real ancestor.
            self.assertEqual(git_head_commit(str(checkout / "missing" / "sub")), expected)

    def test_missing_routing_entry_is_an_error(self) -> None:
        result = self.run_rebuild("--routing-entry", str(ROOT / "does-not-exist-entry.jsonl"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("routing entry not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
