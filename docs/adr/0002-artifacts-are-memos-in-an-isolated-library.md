# Artifacts reuse the memo entity, live in an isolated Artifact Library, and store HTML as resources

When adding "Agent Artifacts", we decided not to introduce a new entity: an artifact is a kind of memo marked by an envelope. The Artifact Library is a single system root notebook per workspace; its child notebooks are Artifact Folders, kept apart from the ordinary notebook tree, and artifacts and ordinary memos cannot be moved between them. The raw HTML is stored as a resource blob in object storage, while the memo body holds only the envelope and the extracted visible text for search. The body can only be replaced as a whole through a dedicated replace endpoint, and the server rejects ordinary body saves. Public sharing of artifacts is out of scope for the first release. This keeps tags, search, sync, trash, revision history, `#memo=` references, and MCP scopes working unchanged, leaves the sync protocol untouched, and avoids D1's per-row size limit.

## Considered Options

- **A separate artifacts entity**: cleanest semantics, but the sync change log only knows `notebook` and `memo`. Older web, Android, and iOS clients treat unknown entities as notebooks and delete them, while the desktop sidecar treats them as memos. Tags, search, trash, and the offline queue would also need a second implementation.
- **A type-filtered view with no root notebook**: no schema change, but Artifact Folders would mix with the notebook tree, so artifacts could not have their own tree on a par with Notebooks.
- **HTML base64-inlined in the body envelope**: simplest to build, but pages with inline images easily exceed D1's row size limit and slow down sync and revision history.
- **Public sharing in the first release**: running arbitrary scripts on a public domain needs a separate sandbox domain and abuse handling, which complicates both Cloudflare and Docker deployment, so it is left for a separate evaluation.

## Consequences

- Older clients show the Artifact Library as an ordinary notebook and artifacts as fallback text. The server rejects their edits, so data is not damaged.
- Artifacts are read-only inside EdgeEver and cannot be edited in place. Changing the content creates a new revision.
