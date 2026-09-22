# Local quality evaluation

Evaluation Sets are local, manually labeled pages that are never converted into Folder Examples for the same run. Folder identity is the exact Chrome bookmark node ID; `expectedFolderId` may equal `pendingFolderId` when the Pending Folder is the correct answer.

The committed synthetic file only demonstrates the schema. A real run must contain at least 100 Chinese and/or English pages:

```sh
JEV_API_KEY=... pnpm evaluate evaluation/datasets/my-local-set.json evaluation/results/metrics.json
```

The runner calls JEV directly and writes aggregate metrics only: Top-1, Top-3, Automatic Save Precision, and Automatic Save Coverage for Chinese, English, and the full set. Real labeled datasets and result files are ignored by Git.

Use the private-beta gate for a release candidate:

```sh
JEV_API_KEY=... pnpm evaluate:gate evaluation/datasets/my-local-set.json evaluation/results/private-beta-metrics.json
```

The command exits non-zero unless overall Top-1 is at least 80%, overall Top-3 is at least 95%, and Automatic Save Precision is at least 95%. Automatic Save Coverage is always reported but is not thresholded. A run with no Automatic Saves fails because its precision is unavailable.
