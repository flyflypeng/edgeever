-- Agent Artifacts: each workspace may own one system root notebook, the
-- Artifact Library, created lazily on first use. Ordinary notebooks keep NULL.
-- Schema only: no workspace receives a library row here.
ALTER TABLE notebooks ADD COLUMN system_kind TEXT;

CREATE UNIQUE INDEX idx_notebooks_workspace_artifact_library
  ON notebooks(workspace_id)
  WHERE system_kind = 'artifact_library' AND is_deleted = 0;
