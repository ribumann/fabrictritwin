# D01 Mining supervisor cockpit

The public cockpit is a shift board for a **synthetic diamond-processing plant**, not a
mine-wide control room. It does not model extraction, dispatch, equipment interlocks,
recovery accounting, or tailings facility safety. The controls start and stop one
shared ten-minute simulation; they do not operate physical equipment.

## Supervisor workflow

1. Check publisher status, the Fabric receipt, and standard-ingestion reconciliation
   independently. An arrived hopper tick does not prove that the rest of the plant is current.
2. Scan Lines A, B and C in **Ore flow**. The authored process route includes shared feed
   and water, and separates ore, product and tailings. Only catalog sensor locations get
   rates; a missing or unusable reading is **unknown**. Open a node or incident to
   inspect its evidence. **Needs attention** lists assessed incidents separately from
   batch arrival status and the local buildup advisory.
3. Use **Streams** for five-second hopper observations and 30/60-second aggregate arrivals.
   The batch details show one example tag per batch. **Diagnostics** pairs the family with
   compatible equipment and uses bounded Fabric trend reads. Live trends for the
   completed approved run stay anchored to its end. Replay pins the requested time;
   live receipts and live incidents are not reinterpreted as historical evidence.
4. Open **Twin** for spatial context, **Inquiries** for the approved saved queries, or
   **AI assistant** for interpretation of bounded evidence. The board does not require
   an AI response or a working 3D view.

## Simulator red-team and field cross-check

| What the review challenged | Result and boundary |
|---|---|
| Fixed ROM inflow and hard inventory clamp could create ore on an empty hopper or silently discard surplus. | Bounded deterministic inflow varies with simulated time. Inventory limits actual discharge and excess is accounted as spill in the model step. Spill is not an instrumented public alarm. A rising hopper alone can be normal surge buffering. |
| Sorter previously inherited the full crusher feed, only delayed. | The delayed feed now splits into illustrative concentrate and reject, with the latter feeding the simplified tailings balance. The fixed fraction is dry-solids mass yield to the sorter, not diamond recovery or site calibration. |
| A falling feed rate did not locate a blockage. | The local advisory requires two distinct, aligned sets of good hopper-level and three line-feed readings. It reports possible upstream buildup with both changes, not a diagnosis or a time-to-overflow forecast. Missing or overdue evidence does not assert normal operation. |
| Water, DMS and bearing scenarios looked more causal than they are. | The water restriction is injected once rather than starting again on recovery. Water stages approximate recirculation and rate restriction; DMS density is not coupled to grade/recovery, and the bearing script is not a failure classifier. Keep absolute settings as demo bands, not alarms for real equipment. |
| A ten-minute normal public run cannot guarantee every abnormal signature or its recovery. | Do not expose fault injection in public Start. Use controlled longer captures and tests for bearing, DMS, water and communications loss. Public fault replay needs a separate curated capture and review. |

[Lucara’s Karowe technical report](https://lucaradiamond.com/site/assets/files/63144/luckar18e-karowe-feasibility-study-2025-final.pdf)
and the [De Beers XRT case study](https://onemine.org/documents/the-application-of-xrt-in-the-de-beers-group-of-companies)
show why screening, dense-medium and sensor sorting are plausible building blocks but not
a universal fixed sequence. [ICMM water accounting](https://hub.icmm.com/website/publications/pdfs/environmental-stewardship/2021/guidance_water-reporting.pdf)
distinguishes withdrawals, consumption, internal recycling and storage; gross process-water
flow in D01 must not be used as a withdrawal or compliance metric. [Metso’s condition-monitoring guidance](https://www.metso.com/portfolio/condition-monitoring/)
ties interpretation to machine-specific parameters and operating context. A real fault
diagnosis would need equipment/load baselines, site thresholds and operator verification.

### Release checks

- Start, duplicate start, startup window, overdue receipt, publisher completion before
  ingestion reconciliation, and cooldown are different states.
- Inspect Line B vibration and shared water without a mismatched diagnostic request.
- Missing, stale, and true zero remain distinct; replay never shows the live arrival lane.
- A common-cause water concern must not be interpreted as three proved equipment failures.
- No tag, Eventhouse schema, auth scope, or public scenario input changes in this release.
