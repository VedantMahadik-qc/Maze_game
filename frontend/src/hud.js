// All DOM-side UI: meters, transition banners, overlays, and the judge
// telemetry panel (Tab) with a live 4x4 map of the current ZZ edge signs.
// Text that came from the network is written with textContent only.

import { EDGES, NUM_QUBITS, GRID_COLS, EXIT_NODE, START_NODE, nodeLabel } from "./maze.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.telemetryOpen = false;
    this._toastTimer = null;
    this._retroTimer = null;
    this._collapseTimer = null;
    this._placeKey = "";
    this.el = {
      blocker: $("blocker"),
      samplerStatus: $("sampler-status"),
      pause: $("pause"),
      pauseNote: $("pause-note"),
      end: $("end-screen"),
      endTitle: $("end-title"),
      endSub: $("end-sub"),
      endStats: $("end-stats"),
      statusSource: $("status-source"),
      room: $("room-line"),
      banner: $("transition-banner"),
      bannerSub: $("transition-sub"),
      collapse: $("collapse-banner"),
      proxFill: $("proximity-fill"),
      proxValue: $("proximity-value"),
      staminaFill: $("stamina-fill"),
      toast: $("toast"),
      telemetry: $("telemetry"),
      tProx: $("t-prox"),
      tProxFill: $("t-prox-fill"),
      tPlace: $("t-place"),
      tStatus: $("t-status"),
      tSample: $("t-sample"),
      tSampler: $("t-sampler"),
      tGuard: $("t-guard"),
      tRetro: $("t-retro"),
      tRetroDot: $("t-retro-dot"),
      tMap: $("t-map"),
      tEdges: $("t-edges"),
    };
    this._buildMap();
    this._buildEdgeList();
  }

  // ---- overlays -------------------------------------------------------

  hideOverlays() {
    this.el.blocker.classList.add("hidden");
    this.el.pause.classList.add("hidden");
    this.el.end.classList.add("hidden");
  }

  showPause(note = "") {
    this.el.pauseNote.textContent = note;
    this.el.pause.classList.remove("hidden");
  }

  showEnd(kind, stats) {
    const caught = kind === "caught";
    this.el.end.classList.toggle("win", !caught);
    this.el.endTitle.textContent = caught ? "CAUGHT" : "ESCAPED";
    this.el.endSub.textContent = caught ? "( state decohered )" : "( superposition resolved )";
    this.el.endStats.replaceChildren(
      ...stats.map(([k, v]) => {
        const row = document.createElement("div");
        const a = document.createElement("span");
        const b = document.createElement("b");
        a.textContent = k;
        b.textContent = v;
        row.append(a, b);
        return row;
      })
    );
    this.el.end.classList.remove("hidden");
  }

  setSamplerMenuStatus(text, ok) {
    this.el.samplerStatus.textContent = text;
    this.el.samplerStatus.classList.toggle("ok", !!ok);
  }

  // ---- in-game HUD --------------------------------------------------------

  setMeters(proximity, stamina, exhausted) {
    const p = Math.min(1, Math.max(0, proximity));
    this.el.proxFill.style.width = `${(p * 100).toFixed(1)}%`;
    this.el.proxValue.textContent = p.toFixed(2);
    this.el.staminaFill.style.width = `${(stamina * 100).toFixed(1)}%`;
    this.el.staminaFill.classList.toggle("exhausted", exhausted);
    if (this.telemetryOpen) {
      this.el.tProx.textContent = p.toFixed(2);
      this.el.tProxFill.style.width = `${(p * 100).toFixed(1)}%`;
    }
  }

  // Where the player is, and whether that's safe. Cheap to call every frame.
  setPlace(region) {
    const key = region.kind === "corridor" ? `c${region.edge.id}` : `${region.kind[0]}${region.node}`;
    if (key === this._placeKey) return;
    this._placeKey = key;
    let text;
    let cls;
    if (region.kind === "room") {
      const tag = region.node === START_NODE ? " · Foyer" : region.node === EXIT_NODE ? " · Exit" : "";
      text = `SAFE ROOM ${nodeLabel(region.node)}${tag}`;
      cls = "safe";
    } else if (region.kind === "hub") {
      text = `EXPOSED · hub ${nodeLabel(region.node)}`;
      cls = "exposed";
    } else {
      text = `EXPOSED · corridor ${nodeLabel(region.edge.a)}–${nodeLabel(region.edge.b)}`;
      cls = "exposed";
    }
    this.el.room.textContent = text;
    this.el.room.className = cls;
    this.el.tPlace.textContent = text;
    this.el.tPlace.className = cls;
  }

  showTransition(on) {
    this.el.banner.classList.toggle("hidden", !on);
    if (on) this.el.bannerSub.textContent = "local 16-qubit lattice · sampling 24 ZZ edges…";
  }

  // Subtle "the layout just changed" banner, restarted on every reshuffle.
  flashCollapse() {
    const el = this.el.collapse;
    el.classList.remove("hidden", "show");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("show");
    clearTimeout(this._collapseTimer);
    this._collapseTimer = setTimeout(() => el.classList.add("hidden"), 1900);
  }

  toast(text, ms = 2600) {
    this.el.toast.textContent = text;
    this.el.toast.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.add("hidden"), ms);
  }

  flashRetro(kind) {
    this.el.tRetroDot.classList.add("on");
    this.el.tRetro.textContent = `${kind} · cue fired ahead of the demon`;
    clearTimeout(this._retroTimer);
    this._retroTimer = setTimeout(() => {
      this.el.tRetroDot.classList.remove("on");
      this.el.tRetro.textContent = "footsteps play 0.90 s ahead";
    }, 900);
  }

  // ---- telemetry --------------------------------------------------------

  toggleTelemetry() {
    this.telemetryOpen = !this.telemetryOpen;
    this.el.telemetry.classList.toggle("hidden", !this.telemetryOpen);
    return this.telemetryOpen;
  }

  // What the last reshuffle was built from, stated plainly.
  setSample(sample) {
    const server = sample.source === "server";
    this.el.statusSource.textContent = server ? "server.py" : "in-browser";
    this.el.statusSource.className = server ? "ok" : "warn";

    const walls = sample.signs.filter((s) => s < 0).length;
    const t = sample.timing;
    let exec = "";
    if (t && t.execMs != null) {
      exec = `${t.execMs.toFixed(1)} ms`;
      if (t.budgetMs != null) exec += t.within ? ` (budget ${t.budgetMs} ms)` : ` (OVER ${t.budgetMs} ms budget)`;
    }
    if (server) {
      const rtt = sample.latencyMs != null ? ` · round trip ${Math.round(sample.latencyMs)} ms` : "";
      this.el.tStatus.textContent = `OK · circuit executed in ${exec}${rtt}`;
      this.el.tStatus.className = t && t.within === false ? "warn" : "ok";
    } else {
      this.el.tStatus.textContent = `FALLBACK ACTIVE · ${sample.fallbackReason || "server.py unavailable"} → in-browser sampler${exec ? ` (${exec})` : ""}`;
      this.el.tStatus.className = "warn";
    }

    const p = sample.params || {};
    const parts = [p.model || "emulated sampler"];
    if (p.theta != null) parts.push(`θ=${p.theta.toFixed(2)}`);
    if (p.layers != null) parts.push(`${p.layers} layers`);
    if (p.temperature != null) parts.push(`T=${p.temperature.toFixed(2)}`);
    if (p.sigma != null) parts.push(`σ=${p.sigma.toFixed(2)}`);
    if (p.shots != null) parts.push(`${p.shots} shots`);
    parts.push(`${walls} of ${sample.signs.length} corridors sealed`);
    this.el.tSample.textContent = parts.join(" · ");
  }

  setGuards(guardFlips, occupancyFlips, totalGuardFlips) {
    const names = (ids) => ids.map((id) => edgeName(EDGES[id])).join(", ");
    const parts = [];
    parts.push(guardFlips.length ? `solvability opened ${names(guardFlips)}` : "exit reachable as sampled");
    if (occupancyFlips.length) parts.push(`held open under you: ${names(occupancyFlips)}`);
    parts.push(`run total ${totalGuardFlips}`);
    this.el.tGuard.textContent = parts.join(" · ");
  }

  // Whether server.py answered its health check (the game runs either way).
  setSamplerLink(online) {
    this.el.tSampler.textContent = online
      ? "server.py (localhost) · 16-qubit circuit · no remote calls"
      : "server.py offline → in-browser Ising fallback · no remote calls";
    this.el.tSampler.className = online ? "ok" : "warn";
  }

  // Live 4x4 map: edges coloured by sign (and by which guard touched them),
  // spins in each room when the sample carried them, player/demon markers.
  setEdges({ signs, rawSigns, zz, guardFlips, occupancyFlips, spins }) {
    const guard = new Set(guardFlips);
    const occ = new Set(occupancyFlips);
    for (const e of EDGES) {
      const s = signs[e.id];
      const cls = occ.has(e.id) ? "occ" : guard.has(e.id) ? "guard" : s > 0 ? "open" : "wall";
      const { line, label } = this._mapEdges[e.id];
      line.setAttribute("class", `edge ${cls}`);
      label.textContent = s > 0 ? "+1" : "−1";
      label.setAttribute("class", `elabel ${cls}`);

      // The row is coloured like its map edge (green open, red wall, amber
      // guard-opened, cyan held-open); the legend explains the colours.
      const row = this._edgeRows[e.id];
      row.className = cls;
      row.children[1].textContent = s > 0 ? "+1" : "−1";
      const z = zz ? zz[e.id] : null;
      row.children[2].textContent = z == null ? "—" : `${z >= 0 ? "+" : ""}${z.toFixed(2)}`;
    }
    for (let n = 0; n < NUM_QUBITS; n++) {
      this._mapNodes[n].spin.textContent = spins ? (spins[n] > 0 ? "↑" : "↓") : "";
    }
  }

  // Offset into the node's lower corners so markers never cover the labels.
  setMarkers(playerAt, demonAt) {
    place(this._player, playerAt && { x: playerAt.x - 9, y: playerAt.y + 9 });
    place(this._demon, demonAt && { x: demonAt.x + 9, y: demonAt.y + 9 });
  }

  _buildMap() {
    const svg = this.el.tMap;
    // 4x4 nodes in a 220-unit box: 55-unit pitch, 30-unit node squares.
    const pos = (n) => ({ x: 27.5 + (n % GRID_COLS) * 55, y: 27.5 + Math.floor(n / GRID_COLS) * 55 });
    this._nodePos = pos;
    this._mapEdges = EDGES.map((e) => {
      const a = pos(e.a);
      const b = pos(e.b);
      const line = svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "edge wall" });
      const label = svgEl("text", {
        x: (a.x + b.x) / 2 + (e.horizontal ? 0 : 11),
        y: (a.y + b.y) / 2 + (e.horizontal ? -5 : 3),
        class: "elabel wall",
        "text-anchor": "middle",
      });
      label.textContent = "−1";
      svg.append(line, label);
      return { line, label };
    });
    this._mapNodes = [];
    for (let n = 0; n < NUM_QUBITS; n++) {
      const p = pos(n);
      const kind = n === EXIT_NODE ? " exit" : n === START_NODE ? " start" : "";
      const rect = svgEl("rect", { x: p.x - 15, y: p.y - 15, width: 30, height: 30, rx: 4, class: `node${kind}` });
      const name = svgEl("text", { x: p.x, y: p.y - 2, class: "nname", "text-anchor": "middle" });
      name.textContent = nodeLabel(n);
      const spin = svgEl("text", { x: p.x, y: p.y + 10, class: "nspin", "text-anchor": "middle" });
      svg.append(rect, name, spin);
      this._mapNodes.push({ rect, spin });
    }
    this._player = svgEl("circle", { r: 4.5, class: "marker player" });
    this._demon = svgEl("circle", { r: 4.5, class: "marker demon" });
    svg.append(this._player, this._demon);
    place(this._player, null);
    place(this._demon, null);
  }

  _buildEdgeList() {
    this._edgeRows = EDGES.map((e) => {
      const li = document.createElement("li");
      for (let i = 0; i < 3; i++) li.append(document.createElement("span"));
      li.children[0].textContent = edgeName(e);
      this.el.tEdges.append(li);
      return li;
    });
  }

  // Map position for a region: node centre (room or hub), or corridor midpoint.
  mapPoint(region) {
    if (!region) return null;
    if (region.kind !== "corridor") return this._nodePos(region.node);
    const a = this._nodePos(region.edge.a);
    const b = this._nodePos(region.edge.b);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}

function place(marker, pt) {
  if (!pt) {
    marker.setAttribute("visibility", "hidden");
    return;
  }
  marker.setAttribute("visibility", "visible");
  marker.setAttribute("cx", pt.x);
  marker.setAttribute("cy", pt.y);
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function edgeName(e) {
  return `${nodeLabel(e.a)}–${nodeLabel(e.b)}`;
}
