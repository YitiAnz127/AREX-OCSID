# ocsid examples

The current collection is chemistry-centered. Start with these live
repository-skill entries:

- [RDKit](../skills/repositories/repo-skills/rdkit/SKILL.md) for cheminformatics
  and molecular representations.
- [OpenMM](../skills/repositories/repo-skills/openmm/SKILL.md) for molecular
  simulation.
- [Quantum chemistry](../skills/repositories/repo-skills/quantum-chemistry/SKILL.md)
  for electronic-structure workflows.
- [Drug-target interaction](../skills/repositories/repo-skills/drug-dti/SKILL.md)
  for pharmaceutical discovery tasks.
- [AlphaFold](../skills/repositories/repo-skills/alphafold/SKILL.md) for protein
  structure workflows.

A typical Researcher request is:

```text
Compare two candidate ligands with an RDKit preprocessing workflow, validate
the molecular inputs, and record assumptions before proposing a docking or
free-energy calculation.
```

A typical Creator request is:

```text
Create and verify a repository skill for this computational-chemistry package,
including environment checks, input contracts, and a reproducible smoke test.
```

## Retained upstream demonstrations

The HTML exports and artifact bundles below are inherited AREX/DisCo
architecture demonstrations. They remain useful for studying session export,
Creator/Researcher orchestration, and evidence recording, but their
Hugging Face and vLLM/SGLang subjects are not part of the current chemistry
repository-skill router.

- [Repository-to-skill Creator session](creator/repo-to-skills/disco-creator-huggingface_hub.html)
- [Repository-to-skill artifact bundle](creator/repo-to-skills/artifacts/huggingface_hub/README.md)
- [Paper-to-skill starter configuration](creator/paper-to-skills/distiller-run-config.toml)
- [Researcher benchmark session](researcher/disco-researcher-vllm_sglang.html)
- [Researcher benchmark report](researcher/artifacts/vllm_sglang/REPORT.md)

These files are retained examples, not claims about the capabilities or
coverage of the current domain collection.

