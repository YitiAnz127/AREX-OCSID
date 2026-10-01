# Build a track with a shared value scale

## User Persona
A user who has already created a `Circos`+`Sector` (composition handled) and now needs track-local drawing. They know the object hierarchy exists but need the concrete Sector/Track primitives, the shared-scale rule, and the coordinate-model cautions. This is the plot-primitives route, not circular-composition.

## Scenario Coverage
- Skill area: sub-skill `plot-primitives`
- Capability: Track primitives (line/scatter/fill_between), shared vmin/vmax, grid/ticks, x_to_rad semantics
- Difficulty: intermediate
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/plot-primitives/SKILL.md`, `references/api-reference.md`, `references/workflows.md`
- Trigger expectation: An existing Circos needing Sector/Track drawing, annotations, ticks, and numeric data routes to plot-primitives.

## Expected Successful Behavior
- Adds a track via `sector.add_track((70,100), r_pad_ratio=0.1, name="signal")` and explains padding maps data into `r_plot_lim`.
- Draws `track.line`, `track.scatter`, and `track.fill_between` all with the same explicit `vmin=0, vmax=1` so identical values sit at the same radius; explains an omitted `vmax` is inferred per-call and breaks comparability.
- Adds `track.grid(y_grid_num=4, x_grid_interval=5)` and `track.xticks_by_interval(...)`, `track.yticks([...], vmin=0, vmax=1)`.
- Keeps x in 1..19 (the sector range) and explains `x_to_rad()` is only for inspection/custom integration, not for pre-converting public primitive arguments.

## Failure Signals
- Routes to circular-composition or data-parsers for the drawing.
- Passes radian values to `Track.line`, or uses `x_to_rad` to "convert" inputs to public methods.
- Omits the explicit shared vmin/vmax, or lets the agent claim omitted vmax is fine.
- Uses an x coordinate outside the sector's 1..19 range without justification.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
