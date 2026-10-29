import Foundation
import GRDB

enum AppDatabase {
    static let fileName = "edgeever-ios.sqlite"

    static func makeShared() throws -> DatabaseQueue {
        let dir = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("EdgeEver", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent(fileName).path
        var config = Configuration()
        config.prepareDatabase { db in
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        let dbQueue = try DatabaseQueue(path: path, configuration: config)
        try dbQueue.writeWithoutTransaction { db in
            try db.execute(sql: "PRAGMA journal_mode = WAL")
        }
        try migrator.migrate(dbQueue)
        return dbQueue
    }

    /// In-memory queue for unit tests.
    static func makeEmpty() throws -> DatabaseQueue {
        let dbQueue = try DatabaseQueue()
        try migrator.migrate(dbQueue)
        return dbQueue
    }

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_mirror_outbox_drafts") { db in
            try db.execute(sql: """
                CREATE TABLE mobile_notebooks (
                  scope TEXT NOT NULL,
                  id TEXT NOT NULL,
                  name TEXT NOT NULL,
                  sort_order INTEGER NOT NULL,
                  data_json TEXT NOT NULL,
                  PRIMARY KEY (scope, id)
                );

                CREATE TABLE mobile_memos (
                  scope TEXT NOT NULL,
                  id TEXT NOT NULL,
                  notebook_id TEXT NOT NULL,
                  title TEXT NOT NULL,
                  content_text TEXT NOT NULL,
                  tags_text TEXT NOT NULL,
                  is_pinned INTEGER NOT NULL,
                  is_deleted INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  deleted_at TEXT,
                  data_json TEXT NOT NULL,
                  PRIMARY KEY (scope, id)
                );

                CREATE INDEX idx_mobile_memos_feed
                  ON mobile_memos(scope, is_deleted, updated_at DESC);
                CREATE INDEX idx_mobile_memos_notebook
                  ON mobile_memos(scope, notebook_id, is_deleted, updated_at DESC);

                CREATE TABLE mobile_sync_meta (
                  scope TEXT NOT NULL,
                  key TEXT NOT NULL,
                  value TEXT NOT NULL,
                  PRIMARY KEY (scope, key)
                );

                CREATE TABLE mobile_id_mappings (
                  scope TEXT NOT NULL,
                  temporary_id TEXT NOT NULL,
                  remote_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (scope, temporary_id)
                );

                CREATE TABLE mobile_sync_outbox (
                  scope TEXT NOT NULL,
                  id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  memo_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  last_error TEXT,
                  next_attempt_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  version INTEGER NOT NULL DEFAULT 1,
                  PRIMARY KEY (scope, id)
                );

                CREATE INDEX idx_mobile_outbox_flush
                  ON mobile_sync_outbox(scope, status, next_attempt_at, created_at);

                CREATE TABLE mobile_drafts (
                  scope TEXT NOT NULL,
                  draft_key TEXT NOT NULL,
                  title TEXT NOT NULL,
                  content_markdown TEXT NOT NULL,
                  content_json TEXT,
                  notebook_id TEXT NOT NULL,
                  tags_text TEXT NOT NULL,
                  expected_revision INTEGER,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (scope, draft_key)
                );
                """)
        }
        // Mirrored notebooks were stored before `Notebook.systemKind` was decoded, so
        // the Artifact Library looks like an ordinary notebook. Dropping the cursor
        // makes the next sync bootstrap again; local drafts and the outbox stay.
        migrator.registerMigration("v2_resync_notebook_system_kind") { db in
            try db.execute(sql: "DELETE FROM mobile_sync_meta WHERE key IN ('cursor', 'identity')")
        }
        return migrator
    }
}
