# Prompt for Claude Code

Read `GAME_DESIGN_BRIEF.md` in this repo fully before writing any code — it has the concept, the reasoning behind every engine choice, the architecture, and exactly what's confirmed vs. guessed about the Atlas API. The "why" behind each decision matters for choices you'll hit while building, so don't skip it.

## Ground rules, non-negotiable

- **Never build a feature against a guessed Atlas contract without verifying it first.** Labyrinth, Retrocausal Echo, and Telablur are all unconfirmed — see the brief's "confirmed vs. still guessed" section. If you don't know an engine's real ID, parameter names, or input shape, say so explicitly and test it with a small isolated script before writing it into game logic.
- **Every Atlas call must fail safe.** Any network error, timeout, or unexpected response should degrade gracefully — skip the effect, keep the previous asset, log it — never crash or block gameplay. If `moth_client.py` from the earlier `quantum-3d-clerk` project is present anywhere in this workspace, read it and port its actual pattern (async worker on a daemon thread so calls never block the main loop/request handler, safe fallback on any failure, disk cache) rather than reinventing it. If it isn't available, build an equivalent with those same three properties.
- **Mark every unverified assumption in code with a comment**, the way `decay.py` and `atlas_async_client.py` did earlier in this project's history — guessed engine IDs, parameter names, or response field names should say so inline, not be written as if certain.
- **Never call Atlas synchronously in a per-frame or latency-sensitive path.** Continuous, proximity-driven effects (Telablur, Retrocausal Echo) get precomputed as a discretized sweep and consumed locally at runtime; only the event-triggered Labyrinth call, at room entry, is safe to make live.

## Build in this order. Stop at each ✋ and show output before continuing — don't run ahead through the whole list unsupervised.

1. **Almost done — one real Telablur success left.** `labyrinth-v1` and `retrocausal-echo-v1` are fully confirmed with real completed output (see the updated brief — Labyrinth's `edge_signs` convention especially matters for step 3). `telablur-v1`'s field names are proven correct (the test job was accepted and actually executed, not rejected for shape), but it failed downstream: `no_mask_region` — no `mask` was supplied, so it fell back to `image1`'s alpha channel, which was almost certainly fully transparent on that tiny placeholder test image, producing an all-zero mask.
   - Resubmit with an explicit `mask` file this time (not just relying on the alpha fallback) — a simple mostly-white or partially-white test mask is enough to prove the masked path works, and it's the path the real game will actually use.
   ✋ **Stop here and confirm a real morphed image comes back before treating step 1 as done.** Once it has, step 1 is fully closed on real evidence for all three engines — move to step 2.

2. **Prototype the core loop with classical placeholders.** Basic first-person movement, a room, a corridor, a chase trigger, a classically-generated (non-quantum) maze standing in for Labyrinth — no real Atlas calls yet, even though step 1 will have confirmed you could make them. The only goal here is answering whether the chase-and-hide loop is actually fun.
   ✋ **Stop here and let me play it before any further engineering goes in.**

3. **Wire in real Labyrinth calls** at the room-entry trigger, using the contract confirmed in step 1.

4. **Build the precompute sweeps** for Telablur and Retrocausal Echo using the contracts confirmed in step 1 — a range of proximity-tier variants generated once, cached, and blended/switched at runtime with zero network calls during actual play.

5. **Integrate**: one proximity value driving all three systems, as described in the brief.

6. Polish / demo pass.

## Open questions from the brief

Don't default these silently — ask me directly, at the point each one actually becomes blocking, not all at once up front:

- Working title — cosmetic, ask whenever.
- House layout (fixed vs. also-variable) — becomes relevant at step 2.
- What the demon actually is: a designed character, or an emergent visual manifestation of decoherence itself. Relevant at step 2, and it meaningfully changes how much of that step you build.
- Win/lose specifics beyond "reach the exit" / "caught" — relevant by step 2 as well.

Start with step 1.
