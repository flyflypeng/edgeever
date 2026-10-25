# Jot is a card view of the Inbox that reuses the memo entity

When adopting the memos-style card stream, we decided not to introduce a separate "short memo" entity: every card in Jot is an existing memo, Jot shows only memos in the Inbox itself (not its child notebooks), quick capture always saves to the Inbox, and moving a memo out of the Inbox counts as triaging it. This keeps resources, tags, search, sync, revision history, and trash working unchanged with no new tables, and gives Jot a clear meaning: the entry point for ideas awaiting triage rather than another ordering of every memo. Review is exempt and covers the whole workspace.

## Considered Options

- **A separate short-memo entity (the memos approach)**: cleanest semantics, but resources, tags, search, sync, and the offline queue would all need a second implementation, plus a card-to-memo conversion flow.
- **Jot shows the whole workspace**: matches memos, but long documents would bury short captures and Jot would lose its role as the triage entry point.
