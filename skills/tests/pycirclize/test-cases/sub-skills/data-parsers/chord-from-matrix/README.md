# Build a chord diagram and diagnose the delimiter trap

## User Persona
A user turning a local tabular matrix into a pyCirclize chord diagram who hit a real parser failure (wrong delimiter -> one malformed column). They also want to know about the from-to parser path and to sanity-check their environment. This is a data-parsers support + troubleshooting scenario, exercising the bundled `validate_matrix_and_radar.py` helper.

## Scenario Coverage
- Skill area: sub-skill `data-parsers`
- Capability: matrix/chord preparation, delimiter diagnosis, from-to parser semantics, bundled validation script
- Difficulty: troubleshooting
- Prompt file: `user_request.txt`
- Fixture: `fixtures/interaction.tsv` (tab-delimited 3x3 matrix A/B/C)
- Expected references/scripts: `sub-skills/data-parsers/SKILL.md`, `references/api-reference.md`, `references/data-formats.md`, `scripts/validate_matrix_and_radar.py`
- Trigger expectation: Matrix/table preparation and chord diagrams route to data-parsers; the wrong-delimiter symptom is explicitly covered in its references and shared troubleshooting.

## Expected Successful Behavior
- Explains that `Matrix(path)` reads with the given `delimiter` and `index_col=0`, so a comma delimiter on a TSV yields one column of compound labels; detect it via `matrix.dataframe.shape` / `row_names` / `col_names`.
- Builds the chord with `Matrix("interaction.tsv")` (tab default) and `Circos.chord_diagram(matrix, cmap=..., order=[...])`, or via `to_sectors()`/`to_links()` + `circos.link`.
- Explains `Matrix.parse_fromto_table` reads the first three columns by position (from, to, value) and makes a square matrix; notes zero/negative cells are skipped and labels come from retained rows.
- Suggests running `python scripts/validate_matrix_and_radar.py` as the local, no-network parser/export check.
- Keeps the whole workflow offline (no example-dataset download).

## Failure Signals
- Assumes `Matrix` auto-detects the delimiter or doesn't mention passing the correct one.
- Doesn't suggest inspecting `dataframe.shape`/`row_names` to detect the bad parse.
- Misdescribes from-to parsing (e.g. says it needs named columns, or aggregates duplicates silently).
- Proposes a network example dataset instead of a local fixture.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
