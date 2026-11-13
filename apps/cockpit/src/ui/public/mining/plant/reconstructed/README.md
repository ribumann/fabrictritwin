# Reconstructed plant assets

These are a local, receipt-checked copy of the D01 scene publication at
`https://red-wave-0c7bb6c0f.4.azurestaticapps.net/`. The source repository is
`ribumann/3d-scene-toolchain`, PR #3, branch `feat/diamond-plant-splats`, reviewed at
`fb6ec273b8f50bc91b960549f5b52d41e267cb76`. Its asset-generation source was
`891d4f3d877d1d8acc7097c017b4e865b73ec8e2` (run `43381383927`); this is distinct from the
reviewed branch head. The PR was not assumed to be merged.

`source/` preserves the published metadata, scene, quality report and file receipts. All twelve
PLY files are included for review; ten are accepted by the pinned quality report and the DMS and
hopper concepts remain screened out by default. The existing Clean GLBs were independently
verified against the same publication receipts. `prepare:reconstructed-assets` re-downloads only
the exact pinned documents and PLY paths, verifies SHA-256, bounds the total PLY payload to 32 MiB,
and does not run as part of the production build. The application has no runtime dependency on the
publication host.

The Cockpit keeps **Clean** as its default and offers **Reconstructed** as a view-only mode.
Both use the same catalog module and equipment IDs, selection, alert state, filters and operating
data; changing appearance never starts or refreshes a run. Rejected DMS and hopper appearances are
hidden by default. The separate review-only toggle may display those pinned assets, with their
screening reason still visible. The top view and object list remain available as fallbacks.

The scene assets are covered by the MIT license in this directory. The Gaussian renderer is
`@sparkjsdev/spark` 2.4.0, also MIT-licensed; its license is copied alongside the local renderer
module during build.
