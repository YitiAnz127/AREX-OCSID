from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from scripts.domain_common import FrontmatterError, copy_companion_resources, parse_frontmatter

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
                '---\nname: example\ndescription: "A molecular workflow that\n  spans two lines."\nmetadata:\n  disco-role: operating\n---\n\n# Body\n',
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


if __name__ == "__main__":
    unittest.main()
