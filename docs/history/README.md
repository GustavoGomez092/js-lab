# Repository history notes

## 2026-09-14 privacy rewrite

Before this repository was first published, its history was rewritten with `git filter-repo --replace-text` to remove
machine-specific details that early spike logs had captured: a local user name, local volume and checkout paths, and a
temporary session folder. They were replaced with placeholders such as `~`, `<repo>`, `<volume>`, `<scratchpad>` and
`<user>`. File contents at the time of the rewrite were unchanged; only older commits were affected.

Every commit ID changed. Plans, checklists, reports and parity notes written before the rewrite cite the old IDs.
`2026-09-14-commit-map.txt` maps each old commit ID (left) to its new ID (right).
