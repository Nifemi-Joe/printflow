import pg from "pg";
import { migrateUp, migrationStatus } from "./migrator.js";

const command = process.argv[2] ?? "up";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (command === "up") {
    const ran = await migrateUp(client);
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "database is up to date");
  } else if (command === "status") {
    for (const m of await migrationStatus(client)) console.log(`${m.applied ? "applied" : "PENDING"}  ${m.name}`);
  } else {
    console.error(`unknown command "${command}" (use up | status)`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
