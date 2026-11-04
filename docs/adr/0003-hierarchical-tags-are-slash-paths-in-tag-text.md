# Hierarchical tags are `/` paths in the tag text, emoji are part of the text, and there is no tag entity

When adding hierarchical tags and the sidebar Tag Tree, we decided not to change the storage model. A tag stays a string in the memo's tag array, levels are expressed by `/` inside the tag text, and the client builds the Tag Tree from those strings on the fly. Emoji are written directly into the tag text, and the tree shows an emoji at the start of a level as that node's icon; spellings that differ only in letter case or whitespace form one node. On write, a shared normalization function tidies the path (trimming each level and dropping empty levels); the server and the web input both use it, and existing data is not backfilled. Renaming or removing a node makes the client expand the subtree into several existing exact renames or deletes, so the backend gains no new write path. This needs no migration and no new sync entity, and older Android and iOS clients keep treating `a/b` as an ordinary tag, so the data stays compatible.

## Considered Options

- **A separate tag entity or tag metadata table** (with parent, icon, color, and order, similar to flomo's tag icons): it would allow per-tag icons and manual ordering, but needs a new table, a migration, and a sync entity; web, the desktop sidecar, Android, iOS, and MCP would all need changes, and older clients would meet an entity they do not know.
- **Changing the existing `tag` query parameter to include descendants**: fewer changes, but Android and iOS would return descendants online and exact matches offline, and the semantics of MCP and the public notebook site would change as a side effect. So only optional parameters such as `tagAny` are added and the old semantics stay.
- **A server-side subtree rename endpoint**: a single request would be atomic, but the merge rules would have to be written three times (API, web local mirror, Rust sidecar), plus a new offline queue action type.
- **Normalizing only in the web input**: no change to server writes and no cross-version verification, but irregular paths written by MCP and mobile clients would stay in the data.

## Consequences

- Renaming a parent tag rewrites the tag strings of every memo in its subtree. The cascade is a series of exact operations, not atomic; if it fails midway, the tree shows the partial state, and running it again converges.
- Changing an icon is a rename.
- Tags exist only on memos: a path no memo uses does not appear in the tree, and an empty tag cannot be created in advance.
- Normalization applies only to written values. Existing tags are still looked up by their original text; otherwise old spellings such as `a / b` could not be renamed or deleted.
