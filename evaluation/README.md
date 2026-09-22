# Local quality evaluation

Evaluation Sets are local, manually labeled pages that are never converted into Folder Examples for the same run. Folder identity is the exact Chrome bookmark node ID; `expectedFolderId` may equal `pendingFolderId` when the Pending Folder is the correct answer.

The committed synthetic file only demonstrates the schema. A real run must contain at least 100 Chinese and/or English pages:

```sh
JEV_API_KEY=... pnpm evaluate evaluation/datasets/my-local-set.json evaluation/results/metrics.json
```

The runner calls JEV directly and writes aggregate metrics only: Top-1, Top-3, Automatic Save Precision, and Automatic Save Coverage for Chinese, English, and the full set. Real labeled datasets and result files are ignored by Git.
