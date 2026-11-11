# Dispatch metrics

- `countTasks` is the number of tasks a dispatch sent, counted after the
  disabled tasks are filtered out.
- `record` adds one dispatch under its `outcome` label. The label is `sent`,
  `denied` or `failed`, and it is the outcome the send returned.
- A dispatch its caller cancelled is not a failure and is not recorded.
