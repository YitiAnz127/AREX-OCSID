# pycirclize — Usability Test Cases

Index of usability test cases for the generated `pycirclize` repo skill
(pyCirclize 1.10.1). The skill has a root route plus four sub-skills
(`circular-composition`, `plot-primitives`, `data-parsers`,
`genomics-and-trees`), each with references and bundled smoke/validation
scripts, plus a shared root `scripts/check_environment.py`.

## Case list

| Case | Area | User role | Scenario | Capability | Difficulty | Test emphasis |
|---|---|---|---|---|---|---|
| `sub-skills/circular-composition/legend-preserving-export` | circular-composition | general user | Compose sectors (tuple range, spaces, anti-clockwise), group band, directed link; preserve a legend via plotfig/ax/savefig | Circos composition + figure lifecycle | basic | route discovery + workflow depth |
| `sub-skills/plot-primitives/shared-scale-track` | plot-primitives | track builder | Add a padded track with line/scatter/fill on a shared vmin/vmax; grid/ticks; x_to_rad semantics | Track primitives + shared value scale | intermediate | workflow depth + support workflow |
| `sub-skills/data-parsers/chord-from-matrix` | data-parsers | tabular user | Diagnose wrong-delimiter trap, build chord from TSV, from-to parser semantics, run bundled validation script | matrix/chord prep + delimiter diagnosis | troubleshooting | troubleshooting clarity + bundled-script executability |
| `sub-skills/genomics-and-trees/feature-and-tree-plot` | genomics-and-trees | bioinformatics | Parse GFF (1-based->0-based), feature arrow + GC fill tracks, Newick TreeViz highlight/marker, avoid network helpers | biological feature/GC/tree plotting | intermediate | support-workflow discoverability + offline boundary |
| `root/environment-routing-diagnosis` | root | setup user | Diagnose import failure + blank PNG, choose Agg, route composition/chord, run check_environment.py | environment check + route dispatch | troubleshooting | route discovery + troubleshooting clarity |
| `integration/chord-with-legend-export` | integration | advanced user | CSV -> chord_diagram with cmap, call plotfig(ax=polar), preserve legend, verify PNG | chord + polar-axis + legend export | advanced | workflow depth + integration |

## Coverage note vs root and sub-skills

- **root** is exercised by `root/environment-routing-diagnosis` (install/smoke
  check, route-by-task dispatch, cross-route operating rules).
- **circular-composition** covered by one basic case (legend-preserving export).
- **plot-primitives** covered by one intermediate case (shared-scale track).
- **data-parsers** covered by one troubleshooting case (chord-from-matrix).
- **genomics-and-trees** covered by one intermediate case (feature-and-tree-plot).
- **integration** covered by one advanced case (chord-with-legend-export).

### Coverage gap note
The `radar_chart` factory and `StackedBarTable` paths are not given a dedicated
case; the `chord-from-matrix` case exercises `Matrix` and references
`parse_fromto_table`, and the bundled `validate_matrix_and_radar.py` covers
radar/stacked internally. Radar/stacked-bar are low-severity gaps given the
same parser/data-formats root and the script anchor. The cytoband track path is
covered only implicitly through genomics work; `genomic_features` and GC are
covered. If tighter coverage is required, add a `sub-skills/data-parsers/radar-from-table` case and a `sub-skills/genomics-and-trees/cytoband-track` case.

## Difficult-case coverage

- **Per-sub-skill difficult synthetic cases:**
  - `data-parsers` — `sub-skills/data-parsers/chord-from-matrix` (extends
    parser/data-formats evidence with a real wrong-delimiter failure signal and
    a local fixture beyond the bundled script).
  - `genomics-and-trees` — `sub-skills/genomics-and-trees/feature-and-tree-plot`
    (extends the smoke fixture pattern with explicit GFF coordinate-conversion
    reasoning and the network-helper boundary).
  - `plot-primitives` — `sub-skills/plot-primitives/shared-scale-track`
    (extends api-reference with a forced shared-scale decision that the smoke
    script implies but does not explain).
  - `circular-composition` — `sub-skills/circular-composition/legend-preserving-export`
    (extends workflows #5 with a deliberate legend-preservation failure trap).
- **Integrated difficult cases:**
  - `integration/chord-with-legend-export` — crosses `data-parsers` + `circular-composition`.
    Synthesized: adapted from the matrix example shape (data-parsers
    reference) combined with the polar-axis/legend lifecycle (circular-composition
    workflows), because no single original repo test spans both; the synthetic
    nature is why the case deliberately forces the cross-route handoff.
- **Original repo-native cases:** the bundled smoke/validation scripts
  (`circos_smoke.py`, `plot_primitives_smoke.py`, `validate_matrix_and_radar.py`,
  `genomics_tree_smoke.py`, `check_environment.py`) are the native evidence
  anchors; synthetic cases complement rather than replace them.

## Assertion coverage

- Cases with `assertions.json`: 6 of 6 (all cases).
- Capabilities with native repo evidence anchoring at least one assertion:
  Circos construction (tuple ranges/spaces/clockwise), get_sector /
  get_group_sectors_deg_lim, axis/text/line/rect/link global primitives,
  plotfig/ax/savefig lifecycle, Track.add_track + r_pad_ratio, shared
  vmin/vmax, grid/xticks/yticks, x_to_rad semantics, Matrix delimiter +
  index_col=0, to_sectors/to_links, parse_fromto_table column-position
  semantics, chord_diagram cmap, GFF 1-based->0-based conversion,
  genomic_features, calc_gc_content/skew, initialize_from_tree + TreeViz
  highlight/marker, network-helper boundary, check_environment.py, Agg backend,
  ModuleNotFoundError remedy.
- Capabilities covered only by synthetic assertions: none — every assertion is
  anchored to real skill reference/script text.
- Capabilities lacking assertions: radar_chart / StackedBarTable get no
  dedicated case (noted as a coverage gap above); they are still referenced by
  the bundled script anchor.
- Cases with fixtures: 
  - `sub-skills/data-parsers/chord-from-matrix/fixtures/interaction.tsv` (tab-delimited 3x3) — tests that the agent preserves the correct delimiter and diagnoses a comma-difference.
  - `sub-skills/genomics-and-trees/feature-and-tree-plot/fixtures/features.gff` and `fixtures/tree.nwk` — small local biological inputs so the case stays offline.
  - `integration/chord-with-legend-export/fixtures/matrix.csv` (comma-delimited 2x2) — tests correct-delimiter + chord + legend export end-to-end.
