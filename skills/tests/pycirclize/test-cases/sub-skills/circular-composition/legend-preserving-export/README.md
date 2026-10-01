# Compose sectors and preserve a legend on export

## User Persona
A user who knows pyCirclize exists and wants a composed circular figure, but is shaky on the exact construction rules (tuple ranges, spaces, anti-clockwise sectors) and — the crux — the Matplotlib figure lifecycle needed to keep a legend on export. They ask a focused composition question, so the circular-composition sub-skill (not plot-primitives) is the right route.

## Scenario Coverage
- Skill area: sub-skill `circular-composition`
- Capability: Circos composition (tuple ranges, spaces, clockwise flags, global primitives, links) + plotfig/legend/savefig lifecycle
- Difficulty: basic
- Prompt file: `user_request.txt`
- Expected references/scripts: `sub-skills/circular-composition/SKILL.md`, `references/api-reference.md`, `references/workflows.md`
- Trigger expectation: General Circos layout, sectors, global links, legends, and export map to the circular-composition route.

## Expected Successful Behavior
- Builds `Circos({"A":10,"B":(100,130),"C":8}, start=..., end=..., space=[...], sector2clockwise={"C":False})` and notes that B's tuple endpoints are data coordinates, not global degrees, and A's size is 10.
- Uses `circos.get_sector()` / `get_group_sectors_deg_lim(["A","B"])` rather than assuming sector order.
- Adds `circos.axis`, `circos.line`, `circos.rect(..., deg_lim=group_limits)`, and `circos.link(("A",2,7),("B",120,110), direction=1, ...)` with x endpoints in each sector's own range.
- Correctly calls `fig = circos.plotfig()`, then `circos.ax.legend(...)`, then `fig.savefig(...)`; explains that `circos.savefig()` closes its internal figure and drops post-render legend edits.

## Failure Signals
- Routes to plot-primitives or data-parsers instead of circular-composition.
- Treats B's tuple (100,130) as a global degree range or as a size of 100.
- Misstates the space list length rule (n sectors -> n values when endspace=True).
- Calls legend after `circos.savefig()` (legend lost) or adds a legend before `plotfig()`.
- Claims `circos.ax` is available before `plotfig()`.

## Assertions (from assertions.json)
See `assertions.json` for the machine-graded checks.
