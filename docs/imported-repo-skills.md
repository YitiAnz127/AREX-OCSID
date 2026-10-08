# Central repository index

This page reflects all 109 records in the current central repository index; it is not limited to third-party imports.

38 of the 109 records are pinned to a recorded `source_commit` — all of them `retained AREX` roots whose `references/repo-provenance.md` came from a git checkout. The other 71 (22 `retained AREX` and all 49 `third-party-derived` roots) have no recorded commit: they were materialized from a local snapshot, so the index states their identity and routing but cannot pin the exact upstream revision. Rows without a commit therefore remain an identity and routing inventory rather than a commit-pinned provenance manifest.

Rows marked `third-party-derived` are the 49 roots created from the four source groups configured in `scripts/import_thirdparty.py`. Their logical repository IDs keep routing identities unique and are not guaranteed to be upstream GitHub locations.

`Unknown` and `NOASSERTION` are both unresolved license states. `NOASSERTION`
means no usable SPDX conclusion was asserted; neither value confirms permission
to redistribute the corresponding skill content.

| Skill | Origin class | Repository identity | Declared license | Source commit |
| --- | --- | --- | --- | --- |
| [`aizynthfinder`](../skills/repositories/repo-skills/aizynthfinder/SKILL.md) | retained AREX | `MolecularAI/aizynthfinder` | MIT | `21ff546d5f22331b078390a2f12dc04defc3f39c` |
| [`alphafold`](../skills/repositories/repo-skills/alphafold/SKILL.md) | retained AREX | `google-deepmind/alphafold` | Apache 2.0 | `c77e5d2a8961d1a353632c462914ff0a32a950f6` |
| [`alphafold2`](../skills/repositories/repo-skills/alphafold2/SKILL.md) | retained AREX | `lucidrains/alphafold2` | MIT | `931466e487e1be87d1182b17ed4ecfac9e70948d` |
| [`alphafold3`](../skills/repositories/repo-skills/alphafold3/SKILL.md) | retained AREX | `google-deepmind/alphafold3` | Apache 2.0 | not recorded |
| [`alphafold3-pytorch`](../skills/repositories/repo-skills/alphafold3-pytorch/SKILL.md) | retained AREX | `lucidrains/alphafold3-pytorch` | MIT | `a52ca288977ed1fc1565dded0a8b434d3dc5201d` |
| [`anndata`](../skills/repositories/repo-skills/anndata/SKILL.md) | retained AREX | `scverse/anndata` | BSD 3-Clause | `e176a68de95e72d66ccb0061d301dffc0e349f8c` |
| [`atomistic-workflows`](../skills/repositories/repo-skills/atomistic-workflows/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/atomistic-workflows` | Unknown | not recorded |
| [`bindcraft`](../skills/repositories/repo-skills/bindcraft/SKILL.md) | retained AREX | `martinpacesa/BindCraft` | MIT | `efb5bfeb8b4b1a5944256f979c34e0c8e6a82d9d` |
| [`binder-design`](../skills/repositories/repo-skills/binder-design/SKILL.md) | third-party-derived | `protein-design-skills/binder-design` | Unknown | not recorded |
| [`binding-characterization`](../skills/repositories/repo-skills/binding-characterization/SKILL.md) | third-party-derived | `protein-design-skills/binding-characterization` | Unknown | not recorded |
| [`biopython`](../skills/repositories/repo-skills/biopython/SKILL.md) | retained AREX | `biopython/biopython` | NOASSERTION | `c9489604d1d9607602ca9199a3852c1219ed330f` |
| [`biostatistics`](../skills/repositories/repo-skills/biostatistics/SKILL.md) | third-party-derived | `SciAgent-Skills/biostatistics` | Unknown | not recorded |
| [`biotite`](../skills/repositories/repo-skills/biotite/SKILL.md) | retained AREX | `biotite-dev/biotite` | BSD 3-Clause | `641afc49d68e4a548c2bad8409b405a14e38a3a6` |
| [`boltz`](../skills/repositories/repo-skills/boltz/SKILL.md) | retained AREX | `jwohlwend/boltz` | MIT | not recorded |
| [`boltzgen`](../skills/repositories/repo-skills/boltzgen/SKILL.md) | third-party-derived | `protein-design-skills/boltzgen` | Unknown | not recorded |
| [`cell-biology`](../skills/repositories/repo-skills/cell-biology/SKILL.md) | third-party-derived | `SciAgent-Skills/cell-biology` | Unknown | not recorded |
| [`cell-free-expression`](../skills/repositories/repo-skills/cell-free-expression/SKILL.md) | third-party-derived | `protein-design-skills/cell-free-expression` | Unknown | not recorded |
| [`celltypist`](../skills/repositories/repo-skills/celltypist/SKILL.md) | retained AREX | `Teichlab/celltypist` | MIT | `fe357564a6625d3b1732a022fd39f18e55696e80` |
| [`chai-lab`](../skills/repositories/repo-skills/chai-lab/SKILL.md) | retained AREX | `chaidiscovery/chai-lab` | Apache 2.0 | not recorded |
| [`chemprop`](../skills/repositories/repo-skills/chemprop/SKILL.md) | retained AREX | `chemprop/chemprop` | NOASSERTION | not recorded |
| [`clawbio`](../skills/repositories/repo-skills/clawbio/SKILL.md) | retained AREX | `ClawBio/ClawBio` | NOASSERTION | `866be13215ed2b2eb0b712372b9fe8d3f1d664d1` |
| [`colabfold`](../skills/repositories/repo-skills/colabfold/SKILL.md) | retained AREX | `sokrypton/ColabFold` | MIT | `e809493da50dfa66fcbf0057ec17f5fdedecf8c6` |
| [`compchem-analysis`](../skills/repositories/repo-skills/compchem-analysis/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/analysis` | Unknown | not recorded |
| [`compchem-data-processing`](../skills/repositories/repo-skills/compchem-data-processing/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/data-processing` | Unknown | not recorded |
| [`compchem-tools`](../skills/repositories/repo-skills/compchem-tools/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/tools` | Unknown | not recorded |
| [`coronavirus`](../skills/repositories/repo-skills/coronavirus/SKILL.md) | retained AREX | `FoldingAtHome/coronavirus` | CC BY 4.0 | not recorded |
| [`datamol`](../skills/repositories/repo-skills/datamol/SKILL.md) | retained AREX | `datamol-io/datamol` | Apache 2.0 | `409c5772736350441a676204c6c4cdb89a075225` |
| [`deepchem`](../skills/repositories/repo-skills/deepchem/SKILL.md) | retained AREX | `deepchem/deepchem` | MIT | not recorded |
| [`deepmd-kit`](../skills/repositories/repo-skills/deepmd-kit/SKILL.md) | retained AREX | `deepmodeling/deepmd-kit` | LGPL 3.0 | not recorded |
| [`deepvariant`](../skills/repositories/repo-skills/deepvariant/SKILL.md) | retained AREX | `google/deepvariant` | BSD 3-Clause | `45f2627504c59785ea2b88d0256a2ec347bce7b4` |
| [`dgl-lifesci`](../skills/repositories/repo-skills/dgl-lifesci/SKILL.md) | retained AREX | `awslabs/dgl-lifesci` | Apache 2.0 | `be8bc71d29ecf34a9dab7c7bd47c08f3383d9be0` |
| [`diffdock`](../skills/repositories/repo-skills/diffdock/SKILL.md) | retained AREX | `gcorso/DiffDock` | MIT | `85c49b60d3e0b0182a59ee43a34a6d7036981284` |
| [`dive-into-graphs`](../skills/repositories/repo-skills/dive-into-graphs/SKILL.md) | retained AREX | `divelab/DIG` | GPL 3.0 | not recorded |
| [`drug-adr`](../skills/repositories/repo-skills/drug-adr/SKILL.md) | third-party-derived | `DrugClaw/adr` | Unknown | not recorded |
| [`drug-combination`](../skills/repositories/repo-skills/drug-combination/SKILL.md) | third-party-derived | `DrugClaw/drug_combination` | Unknown | not recorded |
| [`drug-ddi`](../skills/repositories/repo-skills/drug-ddi/SKILL.md) | third-party-derived | `DrugClaw/ddi` | Unknown | not recorded |
| [`drug-disease`](../skills/repositories/repo-skills/drug-disease/SKILL.md) | third-party-derived | `DrugClaw/drug_disease` | Unknown | not recorded |
| [`drug-dti`](../skills/repositories/repo-skills/drug-dti/SKILL.md) | third-party-derived | `DrugClaw/dti` | Unknown | not recorded |
| [`drug-knowledgebase`](../skills/repositories/repo-skills/drug-knowledgebase/SKILL.md) | third-party-derived | `DrugClaw/drug_knowledgebase` | Unknown | not recorded |
| [`drug-labeling`](../skills/repositories/repo-skills/drug-labeling/SKILL.md) | third-party-derived | `DrugClaw/drug_labeling` | Unknown | not recorded |
| [`drug-mechanism`](../skills/repositories/repo-skills/drug-mechanism/SKILL.md) | third-party-derived | `DrugClaw/drug_mechanism` | Unknown | not recorded |
| [`drug-molecular-property`](../skills/repositories/repo-skills/drug-molecular-property/SKILL.md) | third-party-derived | `DrugClaw/drug_molecular_property` | Unknown | not recorded |
| [`drug-nlp`](../skills/repositories/repo-skills/drug-nlp/SKILL.md) | third-party-derived | `DrugClaw/drug_nlp` | Unknown | not recorded |
| [`drug-ontology`](../skills/repositories/repo-skills/drug-ontology/SKILL.md) | third-party-derived | `DrugClaw/drug_ontology` | Unknown | not recorded |
| [`drug-repurposing`](../skills/repositories/repo-skills/drug-repurposing/SKILL.md) | third-party-derived | `DrugClaw/drug_repurposing` | Unknown | not recorded |
| [`drug-review`](../skills/repositories/repo-skills/drug-review/SKILL.md) | third-party-derived | `DrugClaw/drug_review` | Unknown | not recorded |
| [`drug-toxicity`](../skills/repositories/repo-skills/drug-toxicity/SKILL.md) | third-party-derived | `DrugClaw/drug_toxicity` | Unknown | not recorded |
| [`esm`](../skills/repositories/repo-skills/esm/SKILL.md) | retained AREX | `facebookresearch/esm` | MIT | not recorded |
| [`foldseek`](../skills/repositories/repo-skills/foldseek/SKILL.md) | third-party-derived | `protein-design-skills/foldseek` | Unknown | not recorded |
| [`genomics-bioinformatics`](../skills/repositories/repo-skills/genomics-bioinformatics/SKILL.md) | third-party-derived | `SciAgent-Skills/genomics-bioinformatics` | Unknown | not recorded |
| [`germinal`](../skills/repositories/repo-skills/germinal/SKILL.md) | third-party-derived | `protein-design-skills/germinal` | Unknown | not recorded |
| [`gget`](../skills/repositories/repo-skills/gget/SKILL.md) | retained AREX | `scverse/gget` | BSD 2-Clause | `8006088f831b145b95f13b5cdb4823ad95cb740b` |
| [`graphormer`](../skills/repositories/repo-skills/graphormer/SKILL.md) | retained AREX | `microsoft/Graphormer` | MIT | not recorded |
| [`hail`](../skills/repositories/repo-skills/hail/SKILL.md) | retained AREX | `hail-is/hail` | MIT | `1458d959ca4b23ce784dffff7dae69e7dbb5ab22` |
| [`ipsae`](../skills/repositories/repo-skills/ipsae/SKILL.md) | third-party-derived | `protein-design-skills/ipsae` | Unknown | not recorded |
| [`lab-automation`](../skills/repositories/repo-skills/lab-automation/SKILL.md) | third-party-derived | `SciAgent-Skills/lab-automation` | Unknown | not recorded |
| [`ligandmpnn`](../skills/repositories/repo-skills/ligandmpnn/SKILL.md) | third-party-derived | `protein-design-skills/ligandmpnn` | Unknown | not recorded |
| [`machine-learning-potentials`](../skills/repositories/repo-skills/machine-learning-potentials/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/machine-learning-potentials` | Unknown | not recorded |
| [`mattergen`](../skills/repositories/repo-skills/mattergen/SKILL.md) | retained AREX | `microsoft/mattergen` | MIT | `ac9ddd406171138c3f037d06b9b53fedbbb1c536` |
| [`mdanalysis`](../skills/repositories/repo-skills/mdanalysis/SKILL.md) | retained AREX | `MDAnalysis/mdanalysis` | NOASSERTION | not recorded |
| [`medical-research-skills`](../skills/repositories/repo-skills/medical-research-skills/SKILL.md) | retained AREX | `aipoch/medical-research-skills` | MIT | `f5ef65b9bea79b6dd9553f52f95b0d08f7d64d26` |
| [`molecular-biology`](../skills/repositories/repo-skills/molecular-biology/SKILL.md) | third-party-derived | `SciAgent-Skills/molecular-biology` | Unknown | not recorded |
| [`molecular-conformer`](../skills/repositories/repo-skills/molecular-conformer/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/molecular-conformer` | Unknown | not recorded |
| [`molecular-dynamics`](../skills/repositories/repo-skills/molecular-dynamics/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/molecular-dynamics` | Unknown | not recorded |
| [`molecular-representation`](../skills/repositories/repo-skills/molecular-representation/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/molecular-representation` | Unknown | not recorded |
| [`molecularnodes`](../skills/repositories/repo-skills/molecularnodes/SKILL.md) | retained AREX | `BradyAJohnston/MolecularNodes` | NOASSERTION | not recorded |
| [`mosaic`](../skills/repositories/repo-skills/mosaic/SKILL.md) | third-party-derived | `protein-design-skills/mosaic` | Unknown | not recorded |
| [`ncbi-genome-download`](../skills/repositories/repo-skills/ncbi-genome-download/SKILL.md) | retained AREX | `kblin/ncbi-genome-download` | Apache 2.0 | `50480c7ef12b3468aaa65b1d14cc81fabdb3a5fa` |
| [`omega-fold`](../skills/repositories/repo-skills/omega-fold/SKILL.md) | retained AREX | `HeliXonProtein/OmegaFold` | Apache 2.0 | not recorded |
| [`omicverse`](../skills/repositories/repo-skills/omicverse/SKILL.md) | retained AREX | `omicverse/omicverse` | GPL 3.0 | not recorded |
| [`openfe`](../skills/repositories/repo-skills/openfe/SKILL.md) | retained AREX | `OpenFreeEnergy/openfe` | MIT | `ab86c842d20c85ea231bbe7ec224582daa56c113` |
| [`openfermion`](../skills/repositories/repo-skills/openfermion/SKILL.md) | retained AREX | `quantumlib/OpenFermion` | Apache 2.0 | `b9609ba8b1548eb6d9ba5e1c8a8eac5b271457df` |
| [`openff-toolkit`](../skills/repositories/repo-skills/openff-toolkit/SKILL.md) | retained AREX | `openforcefield/openff-toolkit` | MIT | `120f71473a4b87cb314bd7acc706ce7e9ffdeda4` |
| [`openfold`](../skills/repositories/repo-skills/openfold/SKILL.md) | retained AREX | `aqlaboratory/openfold` | Apache 2.0 | `be2ec1841f16c966c65ae0e7599ebbadc725757d` |
| [`openmm`](../skills/repositories/repo-skills/openmm/SKILL.md) | retained AREX | `openmm/openmm` | MIT, GPL, LGPL | not recorded |
| [`paddlehelix`](../skills/repositories/repo-skills/paddlehelix/SKILL.md) | retained AREX | `PaddlePaddle/PaddleHelix` | NOASSERTION | `8e3991ab1209134b148b05d44e784a43eaa4484d` |
| [`pdb-structure`](../skills/repositories/repo-skills/pdb-structure/SKILL.md) | third-party-derived | `protein-design-skills/pdb` | Unknown | not recorded |
| [`pharmacogenomics`](../skills/repositories/repo-skills/pharmacogenomics/SKILL.md) | third-party-derived | `DrugClaw/pharmacogenomics` | Unknown | not recorded |
| [`prolif`](../skills/repositories/repo-skills/prolif/SKILL.md) | retained AREX | `chemosim-lab/ProLIF` | Apache 2.0 | not recorded |
| [`protein-campaign-manager`](../skills/repositories/repo-skills/protein-campaign-manager/SKILL.md) | third-party-derived | `protein-design-skills/campaign-manager` | Unknown | not recorded |
| [`protein-design-setup`](../skills/repositories/repo-skills/protein-design-setup/SKILL.md) | third-party-derived | `protein-design-skills/setup` | Unknown | not recorded |
| [`protein-design-workflow`](../skills/repositories/repo-skills/protein-design-workflow/SKILL.md) | third-party-derived | `protein-design-skills/protein-design-workflow` | Unknown | not recorded |
| [`protein-mpnn`](../skills/repositories/repo-skills/protein-mpnn/SKILL.md) | retained AREX | `dauparas/ProteinMPNN` | MIT | not recorded |
| [`protein-qc`](../skills/repositories/repo-skills/protein-qc/SKILL.md) | third-party-derived | `protein-design-skills/protein-qc` | Unknown | not recorded |
| [`protenix`](../skills/repositories/repo-skills/protenix/SKILL.md) | retained AREX | `bytedance/Protenix` | Apache 2.0 | not recorded |
| [`proteomics-protein-engineering`](../skills/repositories/repo-skills/proteomics-protein-engineering/SKILL.md) | third-party-derived | `SciAgent-Skills/proteomics-protein-engineering` | Unknown | not recorded |
| [`pycirclize`](../skills/repositories/repo-skills/pycirclize/SKILL.md) | retained AREX | `moshi4/pyCirclize` | MIT | `5a0f36111a4bbfab3e3d765e7365a1108f891dcb` |
| [`pydeseq2`](../skills/repositories/repo-skills/pydeseq2/SKILL.md) | retained AREX | `scverse/PyDESeq2` | MIT | `8c0d057684a144e409f55ea989b0f8a1322288f8` |
| [`pyhealth`](../skills/repositories/repo-skills/pyhealth/SKILL.md) | retained AREX | `sunlabuiuc/PyHealth` | NOASSERTION | `0a75f99dba1fb96d6d9876790edecf252fd0d2f4` |
| [`pymatgen`](../skills/repositories/repo-skills/pymatgen/SKILL.md) | retained AREX | `materialsproject/pymatgen` | NOASSERTION | `78ca4b1115c6bf20e0e8107e591d11021b83b44a` |
| [`pysam`](../skills/repositories/repo-skills/pysam/SKILL.md) | retained AREX | `pysam-developers/pysam` | MIT | `30542fae25dad67e8d80e4057b6957984c3f258d` |
| [`pyscenic`](../skills/repositories/repo-skills/pyscenic/SKILL.md) | retained AREX | `aertslab/pySCENIC` | GPL 3.0 | `06bafba412792f6efa5a552a23bb221cc3bdea1b` |
| [`quantum-chemistry`](../skills/repositories/repo-skills/quantum-chemistry/SKILL.md) | third-party-derived | `computational-chemistry-agent-skills/quantum-chemistry` | Unknown | not recorded |
| [`rdkit`](../skills/repositories/repo-skills/rdkit/SKILL.md) | retained AREX | `rdkit/rdkit` | BSD 3-Clause | not recorded |
| [`reinvent4`](../skills/repositories/repo-skills/reinvent4/SKILL.md) | retained AREX | `MolecularAI/REINVENT4` | Apache 2.0 | `04de385d33f95e97f3960b5c4184a0c0bd3ad7f8` |
| [`rfdiffusion`](../skills/repositories/repo-skills/rfdiffusion/SKILL.md) | retained AREX | `RosettaCommons/RFdiffusion` | NOASSERTION | `2d0c003df46b9db41d119321f15403dec3716cd9` |
| [`sa-prot`](../skills/repositories/repo-skills/sa-prot/SKILL.md) | retained AREX | `westlake-repl/SaProt` | MIT | `e91e4858b55944523f1f8d385f7b96a0d3d34c1d` |
| [`scanpy`](../skills/repositories/repo-skills/scanpy/SKILL.md) | retained AREX | `scverse/scanpy` | BSD 3-Clause | `39f12414fea9cea9439a3d9f665d1e17636092a9` |
| [`schnetpack`](../skills/repositories/repo-skills/schnetpack/SKILL.md) | retained AREX | `atomistic-machine-learning/schnetpack` | NOASSERTION | not recorded |
| [`sciagent-scientific-computing`](../skills/repositories/repo-skills/sciagent-scientific-computing/SKILL.md) | third-party-derived | `SciAgent-Skills/scientific-computing` | Unknown | not recorded |
| [`scientific-agent-skills`](../skills/repositories/repo-skills/scientific-agent-skills/SKILL.md) | retained AREX | `K-Dense-AI/scientific-agent-skills` | MIT | `d661d27ef4ddad5b9287bdd84887ace27e2320b8` |
| [`scikit-bio`](../skills/repositories/repo-skills/scikit-bio/SKILL.md) | retained AREX | `scikit-bio/scikit-bio` | BSD 3-Clause | `71520dab98e0e7a482a196c65cb4d4c7bc8efdf5` |
| [`scvi-tools`](../skills/repositories/repo-skills/scvi-tools/SKILL.md) | retained AREX | `scverse/scvi-tools` | BSD 3-Clause | not recorded |
| [`solublempnn`](../skills/repositories/repo-skills/solublempnn/SKILL.md) | third-party-derived | `protein-design-skills/solublempnn` | Unknown | not recorded |
| [`squidpy`](../skills/repositories/repo-skills/squidpy/SKILL.md) | retained AREX | `scverse/squidpy` | BSD 3-Clause | not recorded |
| [`structural-biology-drug-discovery`](../skills/repositories/repo-skills/structural-biology-drug-discovery/SKILL.md) | third-party-derived | `SciAgent-Skills/structural-biology-drug-discovery` | Unknown | not recorded |
| [`systems-biology-multiomics`](../skills/repositories/repo-skills/systems-biology-multiomics/SKILL.md) | third-party-derived | `SciAgent-Skills/systems-biology-multiomics` | Unknown | not recorded |
| [`torchdrug`](../skills/repositories/repo-skills/torchdrug/SKILL.md) | retained AREX | `DeepGraphLearning/torchdrug` | Apache 2.0 | `6066fbd82360abb5f270cba1eca560af01b8cc90` |
| [`uniprot`](../skills/repositories/repo-skills/uniprot/SKILL.md) | third-party-derived | `protein-design-skills/uniprot` | Unknown | not recorded |
