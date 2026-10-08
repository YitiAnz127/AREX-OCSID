# repo-provenance.md

## Summary
- **Skill**: `antechamber` (AmberTools)
- **Origin**: third-party skill library `computational-chemistry-agent-skills`, under `molecular-dynamics/antechamber/`
- **Imported into OCSID as a standard AREX repo-skill** → `skills/third-party-staging/antechamber/`

## Source
- Original flat `SKILL.md`: `computational-chemistry-agent-skills/molecular-dynamics/antechamber/SKILL.md`
- Library homepage: https://ambermd.org/antechamber/ac.html
- Upstream tool: AmberTools `antechamber` (https://ambermd.org/AmberTools.php)

## What was changed on import
- Frontmatter normalized to AREX repo-skill format: added `disable-model-invocation: true`, `metadata.ocsid-role: operating`.
- Added `references/` (route metadata, capability map) matching AREX repo-skill structure.
- Body rewritten to AREX routing style (`Route Here`, `Boundary / Not Here`, `Route Elsewhere`), content preserved.

## Current status
- **Staging** — not yet merged into `skills/repositories/repo-skills/`, not yet assigned in the main router taxonomy.
