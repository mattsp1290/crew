import type { Pool, PoolClient } from "pg";

export async function transaction<T>(pool: Pool, begin: readonly string[], body: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let failed = false;
  try {
    for (const statement of begin) await db.query(statement);
    const result = await body(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    failed = true;
    try { await db.query("ROLLBACK"); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], "Transaction and rollback failed", { cause: error }); }
    throw error;
  } finally {
    db.release(failed);
  }
}
