---
name: tarkg
description: "Query canonical TarKG drug-target triplets."
disable-model-invocation: true
metadata:
  disco-role: operating
---

# tarkg — drug-dti sub-skill


# TarKG Query Skill

Query the canonical packaged TarKG TSV output.

## Data

- Path: `resources_metadata/dti/TarKG/tarkg.tsv`
- Columns: `drug`, `target`, `relation`, `disease`, `pathway`

## API

| Function | Input | Returns |
|---|---|---|
| `load_tarkg(path)` | TSV path | `list[dict]` |
| `query_entity(entity, rows, limit)` | single entity string | `dict` |
| `query_entities(entities, path, limit)` | list of entity strings | `list[dict]` |

`query_entity` returns keys used by `retrieve.py`: `matched`, `node_info`,
`outgoing_edges`, `incoming_edges`, `candidates`.

## Usage

Run `example.py` directly for demo queries against the canonical TSV.

