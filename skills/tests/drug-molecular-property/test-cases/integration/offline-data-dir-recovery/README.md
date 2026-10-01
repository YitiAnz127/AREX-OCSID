# Recover an offline GDSC data directory

## User Persona
A bioinformatics scientist running GDSC queries on an HPC compute node with no
internet. They know `openpyxl` is installed and that auto-download exists, but
their environment cannot reach the FTP/CDN endpoints on first run, so the data
directory stays empty and queries error out.

## Scenario Coverage
- Skill area: integration — troubleshooting across the `gdsc` sub-skill's data
  setup (auto-download + manual `wget` fallback) and root routing
- Capability: data-directory setup and offline manual download recovery
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/gdsc/SKILL.md` (File Layout, Download
  & Query, manual wget fallback)
- Trigger expectation: The prompt describes a first-run auto-download failure
  and an empty data directory — the exact documented failure mode in the gdsc
  SKILL.md (auto-download fails on a compute node). It is cross-cutting because
  recovery requires the file-layout location (default `DATA_DIR`), the manual
  `wget` fallback commands, and the root skill's context about the project data
  location.

## Expected Successful Behavior
- Explains that the default `DATA_DIR` is
  `resources_metadata/drug_molecular_property/GDSC` and that it can be
  overridden with the `GDSC_DATA_DIR` environment variable.
- Gives the three manual-download `wget` URLs from SKILL.md:
  `screened_compounds_rel_8.4.csv`, `GDSC1_fitted_dose_response_27Oct23.xlsx`,
  and `GDSC2_fitted_dose_response_27Oct23.xlsx`.
- Notes that the script auto-downloads on first run when the data directory is
  empty, and that `mod.download_gdsc_data()` can also trigger the download
  programmatically once internet is available.
- Describes what `query_gdsc` returns while the directory is empty
  (`{"error": "..."}`) and confirms it resolves after files are present.

## Failure Signals
- Suggests installing openpyxl again even though the user already has it.
- Gives no concrete `wget` URLs for the three files.
- Points at an invented data path instead of the documented `DATA_DIR` /
  `GDSC_DATA_DIR` override.
- Tells the user to edit source files under the original DrugClaw checkout.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
