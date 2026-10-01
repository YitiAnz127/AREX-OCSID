# Chord diagram with caller-owned axis and preserved legend

## User Persona
A user pulling together more than one route: chord/matrix data preparation (data-parsers) and composition-level rendering into a caller-owned polar axis with a preserved legend (circular-composition). This is a cross-sub-skill integration case created after whole-skill integration.

## Scenario Coverage
- Skill area: integration (`data-parsers` + `circular-composition` + shared root rules)
- Capability: CSV matrix -> chord_diagram with cmap, plotfig(ax=polar_ax) rendering, legend preservation, PNG verification
- Difficulty: advanced
- Prompt file: `user_request.txt`
- Fixture: `fixtures/matrix.csv` (comma-delimited 2x2 matrix)
- Expected references/scripts: `sub-skills/data-parsers/SKILL.md` + `references/api-reference.md`, `sub-skills/circular-composition/SKILL.md` + `references/api-reference.md`, root `SKILL.md` cross-route rules
- Trigger expectation: Cross-workflow request combining matrix/chord input with composition-level axis/legend/export should route across data-parsers and circular-composition and follow the root cross-route operating rules.

## Expected Successful Behavior
- Loads `matrix.csv` with the data-parsers path: `Matrix("matrix.csv", delimiter=",")` (correct delimiter!) and builds `Circos.chord_diagram(matrix, cmap={...}, order=[...])`, using a cmap mapping for per-label colors.
- Renders into a caller-owned polar axes: `polar_ax = fig.add_subplot(..., projection="polar")`; `returned = circos.plotfig(ax=polar_ax)`.
- Adds legend through `circos.ax.legend(...)` and saves the returned Figure with `returned.savefig(...)`, explaining that `circos.savefig()` writes immediately and drops post-render legend edits.
- Verifies the PNG exists and is non-empty, and stays local (no network/dataset download).

## Failure Signals
- Uses the wrong delimiter (tab) for a comma-CSV, or forgets it, yielding a malformed single-column parse.
- Routes the whole task to a single sub-skill and ignores the chord/legend cross-route handoff.
- Calls `circos.savefig()` when a legend must be preserved, or adds the legend before `plotfig()`.
- Passes a Cartesian axis to `plotfig(ax=...)` instead of a polar one.
- Fetches a network example/dataset rather than the local fixture.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
