# Pinned Deskhand contract

`contract-v0.11-draft/` contains 303 exact upstream files from commit
`b8f17ae931f0eaab3d6237720de5ae4f60d8c957`. `pin.json` enumerates this
subset with byte counts, SHA-256 digests and Git blob IDs. Its
`sourcesSha256` hashes the JSON serialization of the sorted source entries. It includes the
complete schema tree, contract, license, upstream README, Python checker and
its requirements. The README and checker sources supply provenance. Crew's
qualification command runs no Python.

Run `node scripts/vendor-deskhand-contract.mjs /path/to/local/deskhand --check`
from the repository root to compare the complete subset with exact commit
blobs. Omit `--check` to reproduce the files and manifest from that same
commit. The tool never resolves a tag or fetches a remote.

`approval-source.json` preserves the owner issue snapshot.
`approved-amendments.json` records the four amendments approved on
2026-11-14. Upstream pending-approval prose remains unchanged. The pinned
contract resolves the issue's broad call-ID wording. Lease remains an effect
for authority but never accepts `operation_id`.

Run `npm run test:deskhand` with the repository's Node and dependency pins.
The development-only checker verifies the pin, all 297 schema-tree JSON
files, local references, asserted formats, longest-stem example selection,
positive and negative instances, embedded schema examples, wire envelopes,
selected tool schemas, paired IDs, text and structured equality, image block
shape and the six ordered tool bundles. It prints counts and hashes of the
pin and derived example case table. Run
`node scripts/check-deskhand-contract.mjs --cases` to print that table. Validation cannot coerce values, insert
defaults, remove members or fetch a schema.

The contract has two illustrative JSON blocks with `...` and text
placeholders. Those blocks qualify envelope shape only, matching their
upstream use. They cannot qualify selected tool arguments or results. The
elided screenshot image validates block shape only. No image byte integrity,
full upstream prose-checker parity, type inference, client transport, desktop
capability or upstream v1.0 acceptance is claimed.
