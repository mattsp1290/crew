import { withServices } from "./member-services.mts";
await withServices({ label: "text-member-erasure" }, async (s) => {
  await s.startTemporal();
  await s.execute(process.execPath, [
    "--test",
    "tests/service/content-erasure.test.ts",
    "tests/service/text-member-gateway.test.ts",
  ]);
});
console.log(
  "Text member erasure proof passed with PostgreSQL, Temporal and fake engines.",
);
