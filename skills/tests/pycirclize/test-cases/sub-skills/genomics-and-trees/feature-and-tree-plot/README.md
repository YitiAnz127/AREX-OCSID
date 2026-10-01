# Local GFF feature + GC + tree plot

## User Persona
A bioinformatics user comfortable with GFF/Newick who wants a biological circular plot built only from local files. They need the coordinate-convention handling, feature/GC track drawing, and TreeViz styling, and they explicitly demand an offline run. Level: intermediate-to-advanced genomics workflow.

## Scenario Coverage
- Skill area: sub-skill `genomics-and-trees`
- Capability: GFF parsing + 1-based->0-based feature conversion, feature/GC tracks, Newick tree init + TreeViz styling, network-boundary handling
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Fixtures: `fixtures/features.gff`, `fixtures/tree.nwk`
- Expected references/scripts: `sub-skills/genomics-and-trees/SKILL.md`, `references/api-reference.md`, `references/data-formats.md`, `references/troubleshooting.md`
- Trigger expectation: Biological coordinates (GFF/BED), features, GC tracks, and Newick trees route to genomics-and-trees.

## Expected Successful Behavior
- Parses `features.gff` with `pycirclize.parser.Gff` and converts GFF 1-based closed rows to Biopython 0-based half-open locations (`start - 1`, `end`) via `get_seqid2features` / `to_feature_location` semantics; emphasizes not re-subtracting one from a SeqFeature location.
- Draws the CDS feature on a track with `track.genomic_features(feature, plotstyle="arrow", fc=...)` and adds a GC-content fill computed via `gbk.calc_gc_content(seq=...)` / `calc_gc_skew(seq=...)` through `Track.fill_between`, using symmetric vmin/vmax for skew.
- Initializes a tree with `Circos.initialize_from_tree("tree.nwk")` (or the string form), then `tv.highlight(["A","B"], color=...)`, `tv.marker("C", ...)`, optionally `tv.show_confidence()`; inspects `tv.leaf_labels`/`tv.all_node_labels` before querying.
- Explains that `load_prokaryote_example_file`, `load_eukaryote_example_dataset`, and `fetch_genbank_by_accid` are network/caching helpers that must not run automatically in an offline run, and instead uses the local fixtures.

## Failure Signals
- Uses a network dataset helper to get the data instead of the local fixtures.
- Doesn't convert GFF 1-based to 0-based and either draws features shifted by one or subtracts one from an already-converted SeqFeature.
- Uses a GenBank API where a GFF parse is requested, or vice versa, without adaptation.
- Calls `tv` methods without first checking labels, or styles a clade that isn't present.
- Claims `Genbank`/`Gff` auto-download data.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
