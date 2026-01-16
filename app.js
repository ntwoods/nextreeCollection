/* ========= CONFIG =========
1) Deploy Code.gs as a Web App and copy the Web App URL.
2) Paste it in API_BASE below.
*/
const API_BASE = "https://script.google.com/macros/s/AKfycbzs1XUWMlIkNcKRlSuwR1qLH1rwguXKg1z9wLJ6xnf0ihepueJGBGfeV6K_IZJD0lbbJg/exec"; // e.g. https://script.google.com/macros/s/XXXXX/exec

/* ========= State ========= */
let RAW = [];          // full rows from API
let VIEW = [];         // after filtering
let sortKey = "calledAtMs";
let sortDir = "desc";  // 'asc' | 'desc'

/* ========= Helpers ========= */
const el = (id) => document.getElementById(id);

function setStatus(msg, type=""){
  const s = el("status");
  s.textContent = msg;
  s.className = "status" + (type ? " " + type : "");
}

function pad2(n){ return String(n).padStart(2,"0"); }

// Parse 'dd-mm-yy hh:mm' (or 'dd-mm-yyyy hh:mm') into ms (Asia/Kolkata local assumption)
function parseDDMMYYHHMM(s){
  if(!s) return null;
  const str = String(s).trim();
  if(!str) return null;

  const m = str.match(/^([0-3]?\d)[-\/ ]([0-1]?\d)[-\/ ](\d{2}|\d{4})(?:[ T]|\s+)([0-2]?\d):([0-5]\d)$/);
  if(!m) return NaN;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yy = Number(m[3]);
  const HH = Number(m[4]);
  const MI = Number(m[5]);
  if(yy < 100) yy = 2000 + yy; // 25 -> 2025

  // Create date in local timezone; browser timezone may differ.
  // We treat input as user's local (India) and only use it for comparisons.
  const d = new Date(yy, mm-1, dd, HH, MI, 0, 0);
  return d.getTime();
}

// Format ms -> dd-mm-yy hh:mm in local time
function fmtDDMMYYHHMM(ms){
  if(ms === null || ms === undefined) return "";
  const d = new Date(ms);
  if(isNaN(d)) return "";
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth()+1);
  const yy = String(d.getFullYear()).slice(-2);
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${dd}-${mm}-${yy} ${hh}:${mi}`;
}

function uniqSorted(arr){
  return [...new Set(arr.filter(v => v !== null && v !== undefined && String(v).trim() !== ""))]
    .sort((a,b)=> String(a).localeCompare(String(b), undefined, { sensitivity:"base" }));
}

function toCSV(rows){
  const header = ["Called At","Called By","Party","Notes","Next Follow Up"];
  const esc = (v) => {
    const s = (v ?? "").toString().replace(/\r?\n/g, " ");
    if(/[",]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for(const r of rows){
    lines.push([
      esc(r.calledAt || fmtDDMMYYHHMM(r.calledAtMs)),
      esc(r.calledBy),
      esc(r.party),
      esc(r.notes),
      esc(r.nextFollowUp || fmtDDMMYYHHMM(r.nextFollowUpMs)),
    ].join(","));
  }
  return lines.join("\n");
}

/* ========= API ========= */
async function apiFetchLogs(){
  if(!API_BASE || API_BASE.includes("PASTE_YOUR_WEB_APP_URL_HERE")){
    throw new Error("API_BASE not set. Paste your Apps Script Web App URL in app.js");
  }
  const url = `${API_BASE}?action=LOGS_LIST`;
  const res = await fetch(url, { method:"GET", cache:"no-store" });
  const data = await res.json();
  if(!data || !data.ok) throw new Error((data && data.error && data.error.message) || "API error");
  return data.data || [];
}

/* ========= UI ========= */
function fillSelect(selectEl, values, placeholder="All"){
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = placeholder;
  selectEl.appendChild(opt0);

  for(const v of values){
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  }
}

function buildFiltersFromRaw(){
  fillSelect(el("crm"), uniqSorted(RAW.map(r => r.calledBy)), "All CRMs");
  fillSelect(el("party"), uniqSorted(RAW.map(r => r.party)), "All Parties");
}

function applyFilters(){
  const q = (el("q").value || "").trim().toLowerCase();
  const crm = el("crm").value || "";
  const party = el("party").value || "";

  const calledFrom = parseDDMMYYHHMM(el("calledFrom").value);
  const calledTo   = parseDDMMYYHHMM(el("calledTo").value);
  const fuFrom     = parseDDMMYYHHMM(el("fuFrom").value);
  const fuTo       = parseDDMMYYHHMM(el("fuTo").value);

  const bad = [calledFrom, calledTo, fuFrom, fuTo].some(v => v !== null && Number.isNaN(v));
  if(bad){
    setStatus("Invalid date format. Use dd-mm-yy hh:mm", "err");
    return;
  }

  VIEW = RAW.filter(r => {
    if(crm && String(r.calledBy) !== crm) return false;
    if(party && String(r.party) !== party) return false;

    // search
    if(q){
      const blob = `${r.calledBy||""} ${r.party||""} ${r.notes||""}`.toLowerCase();
      if(!blob.includes(q)) return false;
    }

    // called at range
    const ca = r.calledAtMs ?? null;
    if(calledFrom !== null && ca !== null && ca < calledFrom) return false;
    if(calledTo !== null && ca !== null && ca > calledTo) return false;

    // follow up range (blank allowed: if filter applied, blank rows are excluded)
    const fu = r.nextFollowUpMs ?? null;
    if(fuFrom !== null){
      if(fu === null) return false;
      if(fu < fuFrom) return false;
    }
    if(fuTo !== null){
      if(fu === null) return false;
      if(fu > fuTo) return false;
    }

    return true;
  });

  applySort();
  renderTable();
  setStatus(`Showing ${VIEW.length} row(s)`, "ok");
}

function applySort(){
  const dir = sortDir === "asc" ? 1 : -1;
  VIEW.sort((a,b)=>{
    const va = a[sortKey];
    const vb = b[sortKey];

    // numbers first (ms)
    if(typeof va === "number" || typeof vb === "number"){
      const na = (typeof va === "number") ? va : -Infinity;
      const nb = (typeof vb === "number") ? vb : -Infinity;
      return (na - nb) * dir;
    }

    // strings
    const sa = (va ?? "").toString();
    const sb = (vb ?? "").toString();
    return sa.localeCompare(sb, undefined, { sensitivity:"base" }) * dir;
  });

  // update sort indicator UI
  document.querySelectorAll("thead th").forEach(th => {
    th.classList.remove("sort-asc","sort-desc");
    const key = th.getAttribute("data-key");
    if(key === sortKey) th.classList.add(sortDir === "asc" ? "sort-asc":"sort-desc");
  });

  el("sortBadge").textContent = `Sort: ${keyLabel(sortKey)} ${sortDir === "asc" ? "↑" : "↓"}`;
}

function keyLabel(key){
  switch(key){
    case "calledAtMs": return "Called At";
    case "calledBy": return "Called By";
    case "party": return "Party";
    case "notes": return "Notes";
    case "nextFollowUpMs": return "Next Follow Up";
    default: return key;
  }
}

function renderTable(){
  const tb = el("tbody");
  el("countBadge").textContent = `${VIEW.length} rows`;

  if(!VIEW.length){
    tb.innerHTML = `<tr><td colspan="5" class="empty">No rows found. Try changing filters.</td></tr>`;
    return;
  }

  const rowsHtml = VIEW.map(r => {
    const ca = r.calledAt || fmtDDMMYYHHMM(r.calledAtMs);
    const fu = r.nextFollowUp || fmtDDMMYYHHMM(r.nextFollowUpMs);
    const notes = (r.notes ?? "").toString();
    return `<tr>
      <td>${escapeHtml(ca)}</td>
      <td>${escapeHtml(r.calledBy ?? "")}</td>
      <td>${escapeHtml(r.party ?? "")}</td>
      <td class="notes">${escapeHtml(notes)}</td>
      <td>${escapeHtml(fu)}</td>
    </tr>`;
  }).join("");

  tb.innerHTML = rowsHtml;
}

function escapeHtml(s){
  return (s ?? "").toString()
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function resetFilters(){
  el("q").value = "";
  el("crm").value = "";
  el("party").value = "";
  el("calledFrom").value = "";
  el("calledTo").value = "";
  el("fuFrom").value = "";
  el("fuTo").value = "";
  applyFilters();
}

/* ========= Quick chips ========= */
function setCalledRange(fromMs, toMs){
  el("calledFrom").value = fromMs ? fmtDDMMYYHHMM(fromMs) : "";
  el("calledTo").value = toMs ? fmtDDMMYYHHMM(toMs) : "";
  applyFilters();
}

function startOfToday(){
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.getTime();
}

function endOfToday(){
  const d = new Date();
  d.setHours(23,59,0,0);
  return d.getTime();
}

function startOfWeek(){
  const d = new Date();
  const day = d.getDay(); // 0 Sun
  const diff = (day === 0 ? -6 : 1 - day); // Mon as start
  d.setDate(d.getDate()+diff);
  d.setHours(0,0,0,0);
  return d.getTime();
}

function startOfMonth(){
  const d = new Date();
  d.setDate(1);
  d.setHours(0,0,0,0);
  return d.getTime();
}

/* ========= Events ========= */
function wireEvents(){
  // live search (debounced)
  let t = null;
  ["q","crm","party","calledFrom","calledTo","fuFrom","fuTo"].forEach(id=>{
    el(id).addEventListener("input", ()=>{
      clearTimeout(t);
      t = setTimeout(applyFilters, 180);
    });
    el(id).addEventListener("change", applyFilters);
  });

  // sort on header click
  document.querySelectorAll("thead th.sortable").forEach(th=>{
    th.addEventListener("click", ()=>{
      const key = th.getAttribute("data-key");
      if(sortKey === key){
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        // default direction: dates desc, strings asc
        sortDir = (key.endsWith("Ms")) ? "desc" : "asc";
      }
      applySort();
      renderTable();
    });
  });

  el("btnReset").addEventListener("click", resetFilters);

  el("btnRefresh").addEventListener("click", async ()=>{
    await boot();
  });

  el("chipToday").addEventListener("click", ()=> setCalledRange(startOfToday(), endOfToday()));
  el("chipThisWeek").addEventListener("click", ()=> setCalledRange(startOfWeek(), Date.now()));
  el("chipThisMonth").addEventListener("click", ()=> setCalledRange(startOfMonth(), Date.now()));

  el("btnExport").addEventListener("click", ()=>{
    const csv = toCSV(VIEW);
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Logs_${fmtDDMMYYHHMM(Date.now()).replace(/[: ]/g,'-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

/* ========= Boot ========= */
async function boot(){
  try{
    setStatus("Loading data…");
    el("tbody").innerHTML = `<tr><td colspan="5" class="empty">Loading…</td></tr>`;
    el("btnRefresh").disabled = true;

    RAW = await apiFetchLogs();

    // Normalize
    RAW = (RAW || []).map(r => ({
      calledAtMs: typeof r.calledAtMs === "number" ? r.calledAtMs : (r.calledAtMs ? Number(r.calledAtMs) : null),
      calledAt: r.calledAt || "",
      calledBy: r.calledBy || "",
      party: r.party || "",
      notes: r.notes || "",
      nextFollowUpMs: typeof r.nextFollowUpMs === "number" ? r.nextFollowUpMs : (r.nextFollowUpMs ? Number(r.nextFollowUpMs) : null),
      nextFollowUp: r.nextFollowUp || "",
    }));

    buildFiltersFromRaw();

    // default sort indicator
    sortKey = "calledAtMs";
    sortDir = "desc";

    applyFilters();
    setStatus(`Loaded ${RAW.length} row(s)`, "ok");
  }catch(err){
    console.error(err);
    setStatus(err.message || "Failed to load", "err");
    el("tbody").innerHTML = `<tr><td colspan="5" class="empty">Error: ${escapeHtml(err.message || "Failed")}</td></tr>`;
  }finally{
    el("btnRefresh").disabled = false;
  }
}

wireEvents();
boot();
