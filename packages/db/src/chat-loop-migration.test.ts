import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

test("expands existing fixed loops without losing their state", async () => {
  const database = new Database(":memory:")
  try {
    database.run(`
      CREATE TABLE chat_loops (
        id text PRIMARY KEY NOT NULL,
        session_id text NOT NULL,
        prompt text NOT NULL,
        interval_ms integer NOT NULL,
        status text NOT NULL,
        execution_policy text NOT NULL,
        next_run_at integer NOT NULL,
        last_run_at integer,
        run_count integer NOT NULL,
        max_runs integer,
        expires_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `)
    database.run(`
      INSERT INTO chat_loops VALUES (
        'loop-1', 'chat-1', 'Preserve me', 300000, 'ACTIVE',
        '{"mode":"ANALYSIS_ONLY"}', 2000, 1500, 3, 10, 9000, 1000, 1800
      )
    `)

    const migration = await Bun.file(new URL("../drizzle/0028_expand_chat_loop_schedules.sql", import.meta.url)).text()
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.run(statement)
    }

    expect(database.query(`
      SELECT id, prompt, uses_default_prompt, schedule, interval_ms, cron_expression,
             status, next_run_at, last_run_at, run_count, max_runs, expires_at
      FROM chat_loops
    `).get()).toEqual({
      id: "loop-1",
      prompt: "Preserve me",
      uses_default_prompt: 0,
      schedule: "INTERVAL",
      interval_ms: 300_000,
      cron_expression: null,
      status: "ACTIVE",
      next_run_at: 2_000,
      last_run_at: 1_500,
      run_count: 3,
      max_runs: 10,
      expires_at: 9_000,
    })
  } finally {
    database.close()
  }
})

test("removes dormant execution policy without losing automation or permission state", async () => {
  const database = new Database(":memory:")
  try {
    database.run(`
      CREATE TABLE chat_goals (
        session_id text PRIMARY KEY NOT NULL,
        objective text NOT NULL,
        execution_policy text NOT NULL
      )
    `)
    database.run(`
      CREATE TABLE chat_loops (
        id text PRIMARY KEY NOT NULL,
        prompt text NOT NULL,
        execution_policy text NOT NULL
      )
    `)
    database.run(`
      CREATE TABLE chat_permission_requests (
        id text PRIMARY KEY NOT NULL,
        scope text NOT NULL
      )
    `)
    database.run("INSERT INTO chat_goals VALUES ('chat-1', 'Manage position', '{\"mode\":\"ANALYSIS_ONLY\"}')")
    database.run("INSERT INTO chat_loops VALUES ('loop-1', 'Review position', '{\"mode\":\"ANALYSIS_ONLY\"}')")
    database.run("INSERT INTO chat_permission_requests VALUES ('permission-1', 'CHAT')")

    const migration = await Bun.file(new URL("../drizzle/0032_remove_execution_policy.sql", import.meta.url)).text()
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.run(statement)
    }

    expect(database.query("SELECT session_id, objective FROM chat_goals").get()).toEqual({
      session_id: "chat-1",
      objective: "Manage position",
    })
    expect(database.query("SELECT id, prompt FROM chat_loops").get()).toEqual({
      id: "loop-1",
      prompt: "Review position",
    })
    expect(database.query("SELECT id, scope FROM chat_permission_requests").get()).toEqual({
      id: "permission-1",
      scope: "SESSION",
    })
  } finally {
    database.close()
  }
})
