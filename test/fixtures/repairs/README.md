# Repair regression fixtures

These three frozen JSON fixtures support regression tests for source-event repairs.
Their passage text comes from L. Frank Baum's The Wonderful Wizard of Oz; the
surrounding JSON records BookRPG event identifiers, source coordinates and repair metadata.

The copies preserve the reviewed input bytes, including line breaks and source hashes.
They contain no live user accounts, credentials, deployment settings or saved game logs.
The original operational repair files remain separate and unchanged in development.

| Fixture | Regression case | SHA-256 |
| --- | --- | --- |
| oz-first-gulf.json | First gulf: passenger order and action boundaries | `3353eee95f993121df3c42a9f3cecb3fff7a0549336a006f6bc259de3c3d7f6c` |
| oz-second-gulf.json | Second gulf: bridge, threat and crossing order | `19c3a251465ef325994e28148f25ac50c0389cb1f0e70826d51aaf36bd6ef9bc` |
| wizard-oz-transitions.json | Cyclone and landing: continuity and source evidence | `4b39ef7b098aafc332a28f95bf649742dac14a728ad16314e20d464aa5127281` |

## Maintenance

Tests must read these local fixtures rather than reaching into private documentation
or operational patch directories. The existing public exporter already includes
test/fixtures; its directory allowlist does not need to be widened.

These are fixed regression inputs, not automatically synchronized copies of operational
patches. Review any fixture changes together with the affected assertions and update the
checksum above. Do not regenerate them from live logs or alter expected results merely
to make a failing test pass. Preserve source coordinates and source-hash consistency.

When updating the public snapshot, run the full test suite in the exported tree as well
as the development tree. This catches missing inputs outside the fixture directory.
