import type { DatabaseSync } from 'node:sqlite';

export function installRunSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,task_id TEXT NOT NULL,previous_run_id TEXT,
      task_epoch INTEGER NOT NULL,managed INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('ISSUED','READY','RUNNING','FINISHED','SUPERSEDED')),
      intents_json TEXT NOT NULL,scopes_json TEXT NOT NULL,goal TEXT,input_json TEXT,
      runner_owner TEXT,runner_pid INTEGER,runner_identity TEXT,heartbeat_until INTEGER,
      evidence_json TEXT,verdict_json TEXT,next_launch_at INTEGER NOT NULL DEFAULT 0,
      launches INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
      FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
      FOREIGN KEY(previous_run_id) REFERENCES runs(id));
    CREATE TRIGGER IF NOT EXISTS run_plan_immutable BEFORE UPDATE OF tenant_id,task_id,previous_run_id,task_epoch,managed,intents_json,scopes_json,goal,input_json ON runs
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_PLAN'); END;
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),current_run_id TEXT NOT NULL REFERENCES runs(id),
      state TEXT NOT NULL CHECK(state IN ('ACTIVE','COMPLETED','BLOCKED')),
      binding_json TEXT NOT NULL,recovery_count INTEGER NOT NULL DEFAULT 0,max_recoveries INTEGER NOT NULL,
      deadline INTEGER NOT NULL,blocked_reason TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,run_id TEXT NOT NULL,
      type TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS model_campaigns (
      id TEXT PRIMARY KEY,request_limit INTEGER CHECK(request_limit IS NULL OR request_limit>0),
      used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=request_limit));
  `);
}
