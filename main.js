// cs448b a3: dynamic queries over santa clara county restaurants
// everything ui-related lives in createApp(); csv loading is at the bottom

const CSV_URL = "data/sccRestaurantsSynth2026.csv";
const MAP_URL = "data/sccRestaurantsMap2026.png";
const DEBUG = true; // logs update times to the console

// ---- map projection (straight from the handout) ----
const mapScale = 2;
const mapWidth = 1664 / mapScale, mapHeight = 1393 / mapScale;
const longitudeRange = [-122.20085766666666, -121.27442433333333];
const latitudeRange = [36.91311264279123, 37.53067882428926];
const mapFrameGeoJSON = { type: "Feature", geometry: { type: "LineString",
  coordinates: [[longitudeRange[0], latitudeRange[0]], [longitudeRange[1], latitudeRange[1]]] } };
const projection = d3.geoMercator().fitExtent([[0, 0], [mapWidth, mapHeight]], mapFrameGeoJSON);

// placard categories. key = raw value in the csv (null = unknown / missing).
// colors are okabe-ito-ish so they stay distinguishable for colorblind folks.
// `z` = draw order (higher draws on top), so the rare ones aren't buried under 9k greens
const PLACARDS = [
  { key: "Green",     label: "Green",     color: "#009E73", z: 0 },
  { key: "Yellow",    label: "Yellow",    color: "#E6B800", z: 4 },
  { key: "Red",       label: "Red",       color: "#D55E00", z: 5 },
  { key: "Pass *",    label: "Pass *",    color: "#0072B2", z: 2 },
  { key: "Closure *", label: "Closure *", color: "#CC79A7", z: 3 },
  { key: null,        label: "Unknown",   color: "#555555", z: 1 },
];
const UNKNOWN_IDX = PLACARDS.findIndex(p => p.key === null);
const DRAW_ORDER = d3.range(PLACARDS.length).sort((a, b) => PLACARDS[a].z - PLACARDS[b].z);

const STANFORD = [-122.17006, 37.42766]; // [lon, lat]
const REVIEWS_MAX = 5349;
const MILES_PER_DEG_LAT = Math.PI * 3958.8 / 180; // earth radius in miles
const HOVER_RADIUS = 6; // px
const TOOLTIP_MAX = 8;

// default state, as a fn so reset gets a fresh copy
function defaultState() {
  return {
    circles: [
      { id: "A", lon: STANFORD[0], lat: STANFORD[1], r: 3 },
      { id: "B", lon: -122.10, lat: 37.40, r: 3 }, // mountain view, overlaps A
    ],
    minRating: 1,
    minReviews: 1,
    keyword: "",
    placardOn: PLACARDS.map(() => true),
  };
}

// ---- parsing helpers ----

// csv uses "", "null", "N/A" for missing stuff. never turn those into 0
const NULLISH = new Set(["", "null", "n/a", "na", "undefined"]);
function isNullish(v) {
  return v == null || NULLISH.has(String(v).trim().toLowerCase());
}
function parseNum(v) {
  if (isNullish(v)) return null;
  const n = +String(v).trim();
  return Number.isFinite(n) ? n : null;
}
function parseStr(v) {
  return isNullish(v) ? null : String(v).trim();
}

// turn raw csv rows into objects w/ parsed + precomputed fields
function prepRows(raw) {
  const placardIdx = new Map(PLACARDS.map((p, i) => [p.key, i]));
  return raw.map(d => {
    const name = parseStr(d["Facility Name"]) ?? "(unnamed)";
    const address = parseStr(d["Address"]);
    const placard = parseStr(d["Latest placard color"]);
    const row = {
      name, address, placard,
      pi: placardIdx.get(placard) ?? UNKNOWN_IDX, // index into PLACARDS
      score: parseNum(d["Latest Score"]),
      distance: parseNum(d["Distance"]),
      lat: parseNum(d["Latitude"]),
      lon: parseNum(d["Longitude"]),
      rating: parseNum(d["Rating"]),
      reviews: parseNum(d["Number of reviews"]),
      search: (name + " " + (address ?? "")).toLowerCase(),
      x: NaN, y: NaN, group: null,
    };
    if (row.lat != null && row.lon != null) {
      [row.x, row.y] = projection([row.lon, row.lat]);
    }
    return row;
  });
}

// group rows that sit on the exact same pixel (food courts etc)
function buildGroups(rows) {
  const byKey = new Map();
  for (const d of rows) {
    const k = d.x + "," + d.y;
    let g = byKey.get(k);
    if (!g) byKey.set(k, g = { x: d.x, y: d.y, items: [] });
    g.items.push(d);
    d.group = g;
  }
  return Array.from(byKey.values());
}

// px per mile at a given spot: project two pts 1 mile apart north-south
function pxPerMile(lon, lat) {
  const half = 0.5 / MILES_PER_DEG_LAT; // half a mile, in degrees lat
  const p0 = projection([lon, lat - half]);
  const p1 = projection([lon, lat + half]);
  return Math.abs(p1[1] - p0[1]);
}

// keyword box -> list of lowercased terms (comma separated, OR'd)
function parseTerms(s) {
  return s.toLowerCase().split(",").map(t => t.trim()).filter(t => t.length > 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtInt = d3.format(",");

// =====================================================================
// main entry: builds the whole ui inside `container` and returns it
// =====================================================================
function createApp(container, rawRows, mapUrl) {
  const root = d3.select(container).classed("dq-app", true);
  root.selectAll("*").remove();

  // ---- data prep (once) ----
  const allRows = prepRows(rawRows);
  const rows = allRows.filter(d => d.lat != null && d.lon != null); // only mapped ones
  const nUnmapped = allRows.length - rows.length;
  const n = rows.length;
  const groups = buildGroups(rows);
  const quadtree = d3.quadtree(groups, g => g.x, g => g.y);

  // row indices bucketed by placard, so drawing can go placard-by-placard w/o sorting
  rows.forEach((d, i) => d.idx = i);
  const byPlacard = PLACARDS.map(() => []);
  for (const d of rows) byPlacard[d.pi].push(d.idx);
  const placardCounts = byPlacard.map(a => a.length);

  const pass = new Uint8Array(n); // 1 = row matches current query

  // ---- state ----
  let state = defaultState();
  state.circles.forEach(placeCircle);

  // fills in px coords + px-per-mile from lon/lat
  function placeCircle(c) {
    [c.x, c.y] = projection([c.lon, c.lat]);
    c.ppm = pxPerMile(c.lon, c.lat);
  }

  // ---- layout ----
  const header = root.append("div").attr("class", "dq-header");
  header.append("h1").text("Santa Clara County Restaurant Finder");
  header.append("p").text("Drag A and B; adjust radii and filters at right; hover a point for details.");

  const body = root.append("div").attr("class", "dq-body");
  const mapCol = body.append("div").attr("class", "dq-map-col");
  const panel = body.append("div").attr("class", "dq-panel");

  // the stacked layers: img (bottom), canvas (points), svg (circles + hover ring)
  const stack = mapCol.append("div").attr("class", "dq-stack")
    .style("width", mapWidth + "px").style("height", mapHeight + "px");

  stack.append("img")
    .attr("src", mapUrl).attr("alt", "Santa Clara County basemap")
    .attr("width", mapWidth).attr("height", mapHeight)
    .attr("draggable", false)
    .on("error", () => mapCol.append("p").attr("class", "dq-note").text("(basemap image failed to load)"));

  // canvas w/ devicePixelRatio so it's crisp on retina
  const dpr = window.devicePixelRatio || 1;
  const canvas = stack.append("canvas")
    .attr("width", Math.round(mapWidth * dpr)).attr("height", Math.round(mapHeight * dpr))
    .style("width", mapWidth + "px").style("height", mapHeight + "px");
  const ctx = canvas.node().getContext("2d");

  const svg = stack.append("svg").attr("width", mapWidth).attr("height", mapHeight);
  const tooltip = stack.append("div").attr("class", "dq-tooltip").style("display", "none");

  mapCol.append("p").attr("class", "dq-note")
    .text(`${fmtInt(nUnmapped)} restaurants without a location are not shown.`);

  // ---- svg: query circles ----
  // unique id for the clip path in case there are multiple apps on a page (observable)
  const uid = "dq" + Math.random().toString(36).slice(2, 8);
  const clipA = svg.append("defs").append("clipPath").attr("id", uid + "-clipA")
    .append("circle");

  const circleG = svg.append("g").selectAll("g.qc")
    .data(state.circles, c => c.id)
    .join("g").attr("class", c => "qc qc-" + c.id);
  circleG.append("circle").attr("class", "disk")
    .attr("fill", "rgba(40, 50, 80, 0.07)")
    .attr("stroke", "#2d3a5a").attr("stroke-width", 1.5);

  // intersection = circle B clipped by circle A, shaded a bit darker
  const overlap = svg.append("circle")
    .attr("clip-path", `url(#${uid}-clipA)`)
    .attr("fill", "rgba(40, 50, 80, 0.14)")
    .style("pointer-events", "none");

  // center handle + label sit above the overlap shading
  const handleG = svg.append("g").selectAll("g.qc")
    .data(state.circles, c => c.id)
    .join("g").attr("class", "qc");
  handleG.append("circle").attr("class", "handle").attr("r", 5)
    .attr("fill", "#2d3a5a").attr("stroke", "#fff").attr("stroke-width", 1.5);
  handleG.append("text")
    .attr("y", -9).attr("text-anchor", "middle")
    .attr("font-size", 15).attr("font-weight", 700)
    .attr("fill", "#2d3a5a").attr("stroke", "#fff").attr("stroke-width", 3)
    .attr("paint-order", "stroke")
    .text(c => c.id);

  // hover ring (on top of everything)
  const hoverRing = svg.append("circle")
    .attr("r", 7).attr("fill", "none")
    .attr("stroke", "#111").attr("stroke-width", 2)
    .style("display", "none");

  // drag: both the disk and the center handle move the circle
  let dragging = false;
  const drag = d3.drag()
    .container(svg.node())
    .subject((event, c) => ({ x: c.x, y: c.y })) // no jump on grab
    .on("start", function () {
      dragging = true;
      hideHover();
      d3.select(this).classed("dragging", true);
    })
    .on("drag", (event, c) => {
      c.x = clamp(event.x, 0, mapWidth);
      c.y = clamp(event.y, 0, mapHeight);
      [c.lon, c.lat] = projection.invert([c.x, c.y]);
      c.ppm = pxPerMile(c.lon, c.lat); // tiny change at this scale but be correct
      scheduleUpdate();
    })
    .on("end", function () {
      dragging = false;
      d3.select(this).classed("dragging", false);
    });
  circleG.call(drag);
  handleG.call(drag);

  function drawCircles() {
    circleG.select(".disk")
      .attr("cx", c => c.x).attr("cy", c => c.y).attr("r", c => c.r * c.ppm);
    handleG.attr("transform", c => `translate(${c.x},${c.y})`);
    const [A, B] = state.circles;
    clipA.attr("cx", A.x).attr("cy", A.y).attr("r", A.r * A.ppm);
    overlap.attr("cx", B.x).attr("cy", B.y).attr("r", B.r * B.ppm);
  }

  // ---- panel ----
  const status = panel.append("div").attr("class", "dq-status");

  // little helper for a labeled slider w/ live readout
  function addSlider(parent, { label, min, max, step, value, fmt, onInput }) {
    const wrap = parent.append("div").attr("class", "dq-control");
    const lbl = wrap.append("label").attr("class", "dq-lbl");
    lbl.append("span").text(label + ": ");
    const val = lbl.append("span").attr("class", "val");
    const input = wrap.append("input").attr("type", "range")
      .attr("min", min).attr("max", max).attr("step", step)
      .property("value", value)
      .on("input", function () {
        const v = +this.value;
        val.text(fmt(v));
        onInput(v);
      });
    val.text(fmt(value));
    return {
      // sets the slider position + readout without firing onInput
      set(v) { input.property("value", v); val.text(fmt(+input.property("value"))); },
    };
  }

  // query circles section
  const secCircles = panel.append("div").attr("class", "dq-section");
  secCircles.append("h2").text("Query circles");
  const radiusSliders = state.circles.map((c, i) => addSlider(secCircles, {
    label: "Radius " + c.id, min: 0.25, max: 15, step: 0.25, value: c.r,
    fmt: v => v.toFixed(2) + " mi",
    onInput: v => { state.circles[i].r = v; scheduleUpdate(); },
  }));
  secCircles.append("div").attr("class", "dq-hint")
    .text("Shows restaurants inside both A and B.");

  // filters section
  const secFilters = panel.append("div").attr("class", "dq-section");
  secFilters.append("h2").text("Filters");

  const ratingSlider = addSlider(secFilters, {
    label: "Min rating", min: 1, max: 5, step: 0.1, value: state.minRating,
    fmt: v => "★ " + v.toFixed(1),
    onInput: v => { state.minRating = v; scheduleUpdate(); },
  });

  // reviews slider is log scale: slider pos 0..1000 <-> 1..5349 reviews
  const reviewScale = d3.scaleLog().domain([1, REVIEWS_MAX]).range([0, 1000]);
  const posToReviews = p => Math.round(reviewScale.invert(p));
  const reviewsSlider = addSlider(secFilters, {
    label: "Min reviews", min: 0, max: 1000, step: 1, value: reviewScale(state.minReviews),
    fmt: p => fmtInt(posToReviews(p)),
    onInput: p => { state.minReviews = posToReviews(p); scheduleUpdate(); },
  });

  // keyword search, debounced ~100ms
  const kwWrap = secFilters.append("div").attr("class", "dq-control");
  kwWrap.append("label").attr("class", "dq-lbl").text("Name or address contains");
  let kwTimer = null;
  const kwInput = kwWrap.append("input").attr("type", "text")
    .attr("placeholder", "e.g. stanford, el camino")
    .on("input", function () {
      clearTimeout(kwTimer);
      const v = this.value;
      kwTimer = setTimeout(() => { state.keyword = v; scheduleUpdate(); }, 100);
    });
  kwWrap.append("div").attr("class", "dq-hint").text("Separate terms with commas to match any of them.");

  // placard checkboxes (the swatches double as the color legend)
  const plWrap = secFilters.append("div").attr("class", "dq-control");
  plWrap.append("label").attr("class", "dq-lbl").text("Latest placard");
  const checks = plWrap.append("div").attr("class", "dq-checks")
    .selectAll("label").data(PLACARDS).join("label");
  const checkInputs = checks.append("input").attr("type", "checkbox")
    .property("checked", true)
    .on("change", function (event, p) {
      state.placardOn[PLACARDS.indexOf(p)] = this.checked;
      scheduleUpdate();
    });
  checks.append("span").attr("class", "swatch").style("background", p => p.color)
    .style("margin-left", "4px");
  checks.append("span").text(p => p.label + " ");
  checks.append("span").attr("class", "cnt").text((p, i) => `(${fmtInt(placardCounts[i])})`);

  // legend
  const secLegend = panel.append("div").attr("class", "dq-section");
  secLegend.append("h2").text("Legend");
  secLegend.append("div").attr("class", "dq-hint").style("font-size", "12px").html(
    PLACARDS.map(p => `<span class="swatch" style="background:${p.color}"></span>${p.label}`).join(" &nbsp; ") +
    `<br><span class="swatch" style="background:#c4c4c4;width:6px;height:6px"></span>doesn't match the query` +
    ` &nbsp; <span style="color:#2d3a5a">darker shading</span> = A ∩ B`);

  panel.append("button").attr("class", "dq-reset").text("Reset")
    .on("click", reset);

  function reset() {
    state = defaultState();
    state.circles.forEach(placeCircle);
    // circle data objects got replaced, rebind them to the svg elements
    circleG.data(state.circles);
    handleG.data(state.circles);
    radiusSliders.forEach((s, i) => s.set(state.circles[i].r));
    ratingSlider.set(state.minRating);
    reviewsSlider.set(reviewScale(state.minReviews));
    clearTimeout(kwTimer);
    kwInput.property("value", "");
    checkInputs.property("checked", true);
    scheduleUpdate();
  }

  // ---- filtering + drawing ----

  // coalesce many input/drag events into one update per frame
  let rafId = null;
  function scheduleUpdate() {
    if (rafId == null) rafId = requestAnimationFrame(() => { rafId = null; update(); });
  }

  function update() {
    const t0 = performance.now();
    const count = runFilter();
    const t1 = performance.now();
    drawPoints();
    drawCircles();
    status.html(`<b>${fmtInt(count)}</b> of ${fmtInt(n)} mapped restaurants match`);
    if (hovered) showTooltip(hovered, lastMouse); // refresh the pass/fail marks
    if (DEBUG) {
      const t2 = performance.now();
      console.log(`update: ${(t2 - t0).toFixed(1)} ms (filter ${(t1 - t0).toFixed(1)}, draw ${(t2 - t1).toFixed(1)}), ${count} match`);
    }
  }

  // one tight loop over all rows; fills `pass` and returns the count
  function runFilter() {
    const [A, B] = state.circles;
    const ax = A.x, ay = A.y, ar2 = (A.r * A.ppm) ** 2;
    const bx = B.x, by = B.y, br2 = (B.r * B.ppm) ** 2;
    const minRating = state.minRating, minReviews = state.minReviews;
    const on = state.placardOn;
    const terms = parseTerms(state.keyword);
    const nTerms = terms.length;
    // tiny epsilon so slider steps like 4.3 don't miss a 4.3 rating to float error
    const ratingCut = minRating - 1e-9;

    let count = 0;
    for (let i = 0; i < n; i++) {
      const d = rows[i];
      let ok = on[d.pi] &&
        (minRating <= 1 || (d.rating != null && d.rating >= ratingCut)) &&
        (minReviews <= 1 || (d.reviews != null && d.reviews >= minReviews));
      if (ok) {
        let dx = d.x - ax, dy = d.y - ay;
        ok = dx * dx + dy * dy <= ar2;
        if (ok) { dx = d.x - bx; dy = d.y - by; ok = dx * dx + dy * dy <= br2; }
      }
      if (ok && nTerms) {
        ok = false;
        for (let t = 0; t < nTerms; t++) if (d.search.includes(terms[t])) { ok = true; break; }
      }
      pass[i] = ok ? 1 : 0;
      count += ok ? 1 : 0;
    }
    return count;
  }

  const TAU = Math.PI * 2;
  function drawPoints() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mapWidth, mapHeight);

    // failing pts first: small gray dots, all in one path
    const rf = 1.3;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (pass[i]) continue;
      const d = rows[i];
      ctx.moveTo(d.x + rf, d.y);
      ctx.arc(d.x, d.y, rf, 0, TAU);
    }
    ctx.fillStyle = "rgba(120, 120, 120, 0.45)";
    ctx.fill();

    // passing pts on top, one path per placard color, rare colors last
    const rp = 2.8;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    for (const pi of DRAW_ORDER) {
      const idxs = byPlacard[pi];
      ctx.beginPath();
      let any = false;
      for (let k = 0; k < idxs.length; k++) {
        const i = idxs[k];
        if (!pass[i]) continue;
        const d = rows[i];
        ctx.moveTo(d.x + rp, d.y);
        ctx.arc(d.x, d.y, rp, 0, TAU);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = PLACARDS[pi].color;
      ctx.fill();
      ctx.stroke();
    }
  }

  // ---- hover ----
  let hovered = null;      // location group under the mouse
  let lastMouse = [0, 0];

  stack.on("mousemove", event => {
    if (dragging) return;
    const [mx, my] = d3.pointer(event, stack.node());
    lastMouse = [mx, my];
    const g = findNear(mx, my);
    if (!g) return hideHover();
    hovered = g;
    hoverRing.style("display", null).attr("cx", g.x).attr("cy", g.y);
    showTooltip(g, lastMouse);
  });

  // nearest location group, plus any other groups whose dots basically overlap it
  // (malls like valley fair have several groups < 2px apart, which are impossible
  // to pick apart w/ the mouse). returns {x, y, items} like a group
  const MERGE_PX = 2;
  function findNear(mx, my) {
    const g0 = quadtree.find(mx, my, HOVER_RADIUS);
    if (!g0) return null;
    const near = [];
    quadtree.visit((node, x0, y0, x1, y1) => {
      if (!node.length) { // leaf: walk its linked list of points
        let nd = node;
        do {
          const g = nd.data;
          if ((g.x - g0.x) ** 2 + (g.y - g0.y) ** 2 <= MERGE_PX * MERGE_PX) near.push(g);
        } while ((nd = nd.next));
      }
      // skip quads that can't contain anything within MERGE_PX of g0
      return x0 > g0.x + MERGE_PX || x1 < g0.x - MERGE_PX || y0 > g0.y + MERGE_PX || y1 < g0.y - MERGE_PX;
    });
    if (near.length === 1) return g0;
    return { x: g0.x, y: g0.y, items: near.flatMap(g => g.items) };
  }
  stack.on("mouseleave", hideHover);

  function hideHover() {
    hovered = null;
    hoverRing.style("display", "none");
    tooltip.style("display", "none");
  }

  // compact "★ 4.4 · 173 reviews · score 94 · ● Green", skipping nulls
  function metaLine(d) {
    const parts = [];
    if (d.rating != null) parts.push("★ " + d.rating.toFixed(1));
    if (d.reviews != null) parts.push(fmtInt(d.reviews) + (d.reviews === 1 ? " review" : " reviews"));
    if (d.score != null) parts.push("score " + d.score);
    if (d.placard != null) {
      parts.push(`<span class="swatch" style="background:${PLACARDS[d.pi].color}"></span>${escapeHtml(d.placard)}`);
    }
    return parts.join(" · ");
  }

  function passFlag(d) {
    return pass[d.idx]
      ? `<span class="tt-flag pass">✓ match</span>`
      : `<span class="tt-flag fail">filtered out</span>`;
  }

  function showTooltip(g, [mx, my]) {
    const items = g.items;
    let html;
    if (items.length === 1) {
      const d = items[0];
      html = `<div class="tt-head">${escapeHtml(d.name)}${passFlag(d)}</div>` +
        (d.address ? `<div class="tt-addr">${escapeHtml(d.address)}</div>` : "") +
        `<div class="tt-meta">${metaLine(d)}</div>`;
    } else {
      // matching ones first so they don't get cut off by the +N more
      const sorted = items.slice().sort((a, b) => pass[b.idx] - pass[a.idx]);
      const nMatch = items.reduce((s, d) => s + pass[d.idx], 0);
      const shown = sorted.slice(0, TOOLTIP_MAX);
      const addr = items[0].address;
      const sameAddr = items.every(d => d.address === addr);
      html = `<div class="tt-head">${items.length} restaurants here · ${nMatch} match</div>` +
        (sameAddr && addr ? `<div class="tt-addr">${escapeHtml(addr)}</div>` : "") +
        shown.map(d => `<div class="tt-item ${pass[d.idx] ? "pass" : "fail"}">` +
          `<span class="tt-name">${escapeHtml(d.name)}</span>${passFlag(d)}` +
          (!sameAddr && d.address ? `<div class="tt-addr" style="margin:0">${escapeHtml(d.address)}</div>` : "") +
          `<div class="tt-meta">${metaLine(d)}</div></div>`).join("") +
        (items.length > TOOLTIP_MAX ? `<div class="tt-more">+${items.length - TOOLTIP_MAX} more</div>` : "");
    }
    tooltip.html(html).style("display", null);

    // put it near the cursor, flipping to the other side near the edges
    const node = tooltip.node();
    const w = node.offsetWidth, h = node.offsetHeight;
    let left = mx + 14, top = my + 14;
    if (left + w > mapWidth - 4) left = mx - 14 - w;
    if (top + h > mapHeight - 4) top = my - 14 - h;
    tooltip.style("left", Math.max(4, left) + "px").style("top", Math.max(4, top) + "px");
  }

  // first draw (sync, so the page isn't blank for a frame)
  update();

  // handy for debugging / testing from the console
  container.__dq = { state: () => state, rows, groups, pass, update, reset };
  return container;
}

// ---- load the csv, then build the app. show a msg if it fails ----
(function main() {
  const container = document.getElementById("app");
  if (!container) return; // e.g. pasted into observable, call createApp yourself
  d3.csv(CSV_URL)
    .then(rows => createApp(container, rows, MAP_URL))
    .catch(err => {
      console.error(err);
      d3.select(container).append("div").attr("class", "dq-error")
        .html(`<b>Couldn't load the restaurant data.</b><br>` +
          `Make sure you're running a local server from the project folder ` +
          `(<code>python -m http.server</code>) and that <code>${CSV_URL}</code> exists.`);
    });
})();
