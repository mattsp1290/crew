import { Pool } from "pg";
import { writeSync } from "node:fs";
import { ConversationContentOutput } from "../../src/service/content-output.ts";

const [mode, encodedKey, name] = process.argv.slice(2);
const pool = new Pool({
  connectionString: process.env.BIRBCREW_TEST_DATABASE_URL,
  application_name: name,
});
let paused = false;
pool.on("connect", (client) => {
  const query = client.query.bind(client);
  client.query = (...args) => {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const work = query(...args);
    const freeze =
      mode === "before_commit"
        ? text?.startsWith("SELECT c.content_erasure_id,e.erased_at")
        : text === "COMMIT";
    if (!paused && freeze)
      return work.then((result) => {
        paused = true;
        writeSync(1, `FROZEN ${client.processID}\n`);
        process.kill(process.pid, "SIGSTOP");
        return result;
      });
    return work;
  };
});
try {
  await new ConversationContentOutput(pool).enqueue(
    JSON.parse(encodedKey),
    () => {
      writeSync(1, "ENQUEUED\n");
      return { backpressure: false };
    },
  );
} catch {
  writeSync(1, "CONNECTION_FAILED\n");
} finally {
  await pool.end();
}
