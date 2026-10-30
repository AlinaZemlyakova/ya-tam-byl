const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const VERDICT_LABEL = { like: "Понравилось", dislike: "Не понравилось", mixed: "Смешанно" };
const OVERLAY_KEY = "yatambyl-overlay-v1";
const PIN_KEY = "yatambyl-pin";

const state = {
  base: [],
  writable: false,
  selected: null,
  bucket: "all",
  verdict: null,
  city: "",
  q: "",
  picking: false,
  draft: emptyDraft(),
};

const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
  zoomAnimation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
  maxZoom: 19,
}).addTo(map);
map.setView([55.75, 37.62], 5);

const markers = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 42,
  spiderfyOnMaxZoom: true,
  iconCreateFunction(cluster) {
    return L.divIcon({
      className: "cluster-wrap",
      html: `<span class="cluster">${cluster.getChildCount()}</span>`,
      iconSize: [36, 36],
    });
  },
});
map.addLayer(markers);
const markerById = new Map();

function emptyDraft() {
  return {
    id: "",
    name: "",
    status: "wish",
    verdict: "like",
    city: "",
    visited: "",
    post: "",
    summary: "",
    visits: [],
    tags: "",
    lat: null,
    lon: null,
    address: "",
    yandex: "",
  };
}

function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function fmtDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : "";
}

function readOverlay() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OVERLAY_KEY) || "");
    return { upserts: parsed.upserts || [], deleted: parsed.deleted || [] };
  } catch {
    return { upserts: [], deleted: [] };
  }
}

function writeOverlay(overlay) {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
}

function allPlaces() {
  const overlay = readOverlay();
  const deleted = new Set(overlay.deleted);
  const merged = new Map();
  for (const place of state.base) {
    if (!deleted.has(place.id)) merged.set(place.id, place);
  }
  for (const place of overlay.upserts) {
    if (!deleted.has(place.id)) merged.set(place.id, place);
  }
  return [...merged.values()];
}

function visible() {
  const query = state.q.trim().toLowerCase();
  return allPlaces()
    .filter((place) => {
      if (state.bucket === "been" && place.status !== "been") return false;
      if (state.bucket === "wish" && place.status !== "wish") return false;
      const visits = placeVisits(place);
      if (state.verdict) {
        const hit = visits.some((visit) => visit.verdict === state.verdict)
          || (!visits.length && place.verdict === state.verdict);
        if (!hit) return false;
      }
      if (state.city && place.city !== state.city) return false;
      if (!query) return true;
      const blob = [
        place.name,
        place.city,
        place.summary,
        place.address,
        ...visits.flatMap((visit) => [visit.summary, visit.post]),
        ...(place.tags || []),
      ].join(" ").toLowerCase();
      return blob.includes(query);
    })
    .sort((a, b) => {
      const aw = a.status === "wish" ? 0 : 1;
      const bw = b.status === "wish" ? 0 : 1;
      if (aw !== bw) return aw - bw;
      return placeDate(b).localeCompare(placeDate(a));
    });
}

function pinKind(place) {
  if (place.status === "wish") return "wish";
  return rolledVerdict(place);
}

function pinIcon(kind) {
  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="pin pin-${kind}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch { /* ignore bad urls */ }
  return "";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function emptyVisit() {
  return { post: "", visited: "", verdict: "like", summary: "" };
}

function normalizeVisit(visit) {
  return {
    post: (visit && visit.post) || "",
    summary: (visit && visit.summary) || "",
    visited: (visit && visit.visited) || "",
    verdict: visit && ["like", "dislike", "mixed"].includes(visit.verdict) ? visit.verdict : "like",
    image: safeImage(visit && visit.image),
  };
}

function safeImage(src) {
  const value = String(src || "");
  if (!/^images\/[a-z0-9][a-z0-9._-]*$/i.test(value)) return "";
  return value;
}

function placeImage(place) {
  const latest = latestVisit(place);
  return (latest && latest.image) || safeImage(place && place.image);
}

function photoNode(src) {
  const safe = safeImage(src);
  if (!safe) return null;
  const img = document.createElement("img");
  img.className = "shot";
  img.alt = "";
  img.src = safe;
  return img;
}

function placeVisits(place) {
  if (place && Array.isArray(place.visits) && place.visits.length) return place.visits.map(normalizeVisit);
  if (!place || place.status === "wish") return [];
  if (place.post || place.summary || place.visited || place.verdict) {
    return [normalizeVisit(place)];
  }
  return [];
}

function latestVisit(place) {
  const visits = placeVisits(place);
  if (!visits.length) return null;
  return [...visits].sort((a, b) => (b.visited || "").localeCompare(a.visited || ""))[0];
}

function rolledVerdict(place) {
  const kinds = [...new Set(placeVisits(place).map((visit) => visit.verdict))];
  if (kinds.length === 1) return kinds[0];
  if (kinds.length > 1) return "mixed";
  return place.verdict || "like";
}

function placeDate(place) {
  const latest = latestVisit(place);
  return (latest && latest.visited) || place.visited || "";
}

function postLink(url, label) {
  const link = el("a", "", label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

function popupNode(place) {
  const root = el("article", "popup");
  const visits = placeVisits(place);
  const kind = place.status === "wish" ? "wish" : rolledVerdict(place);
  const kicker = el(
    "p",
    `popup-kicker ${kind}`,
    place.status === "wish" ? "Хочу побывать" : (VERDICT_LABEL[kind] || ""),
  );
  const title = el("h3", "", place.name);
  const when = visits.length > 1
    ? `${visits.length} ${plural(visits.length, "пост", "поста", "постов")}`
    : fmtDate(placeDate(place));
  const meta = el("p", "popup-meta", [place.city, when].filter(Boolean).join(" · "));
  root.append(kicker, title, meta);
  if (place.status === "wish") {
    appendStory(root, place.summary, place.image, place.post, "Пост в канале");
  } else if (visits.length <= 1) {
    const visit = visits[0] || {};
    appendStory(root, visit.summary || place.summary, visit.image || place.image, visit.post || place.post, "Пост в канале");
  } else {
    visits.forEach((visit, index) => {
      const block = el("div", "popup-visit");
      const bits = [fmtDate(visit.visited), VERDICT_LABEL[visit.verdict]].filter(Boolean);
      block.append(el("p", `popup-kicker ${visit.verdict}`, bits.join(" · ") || `Пост ${index + 1}`));
      appendStory(block, visit.summary, visit.image, visit.post, `Пост ${index + 1}`);
      root.append(block);
    });
  }
  const links = el("p", "popup-links");
  const yandex = safeUrl(place.yandex || "");
  if (yandex) links.append(postLink(yandex, "На картах"));
  root.append(links);
  return root;
}

function appendStory(parent, summary, image, post, label) {
  const row = el("div", "popup-row");
  const shot = photoNode(image);
  if (shot) row.append(shot);
  const copy = el("div");
  if (summary) copy.append(el("p", "popup-sum", summary));
  const url = safeUrl(post || "");
  if (url) copy.append(postLink(url, label));
  if (copy.childNodes.length) row.append(copy);
  if (row.childNodes.length) parent.append(row);
}

function placeToDraft(place) {
  return {
    id: place.id,
    name: place.name || "",
    status: place.status || "wish",
    verdict: place.verdict || "like",
    city: place.city || "",
    visited: place.visited || "",
    post: place.post || "",
    summary: place.summary || "",
    visits: placeVisits(place).map((visit) => ({ ...visit })),
    tags: (place.tags || []).join(", "),
    lat: place.lat,
    lon: place.lon,
    address: place.address || "",
    yandex: place.yandex || "",
  };
}

function renderMarkers(list) {
  markers.clearLayers();
  markerById.clear();
  for (const place of list) {
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    const marker = L.marker([place.lat, place.lon], { icon: pinIcon(pinKind(place)), title: place.name });
    marker.bindPopup(popupNode(place), { maxWidth: 280, minWidth: 220 });
    marker.on("click", () => {
      state.selected = place.id;
      paintActive();
      const card = document.querySelector(`.card[data-id="${CSS.escape(place.id)}"]`);
      if (card) card.scrollIntoView({ block: "nearest" });
    });
    markers.addLayer(marker);
    markerById.set(place.id, marker);
  }
}

function renderList(list) {
  const box = document.getElementById("list");
  box.replaceChildren();
  if (!list.length) {
    box.append(el("p", "empty", "Ничего не нашлось. Снимите фильтр."));
    return;
  }
  for (const place of list) {
    const card = el("button", "card");
    card.type = "button";
    card.dataset.id = place.id;
    if (place.id === state.selected) card.classList.add("active");
    const bar = el("span", `bar ${pinKind(place)}`);
    const body = el("span");
    const visits = placeVisits(place);
    const latest = latestVisit(place);
    const label = place.status === "wish" ? "хочу побывать" : (VERDICT_LABEL[rolledVerdict(place)] || "");
    const count = visits.length > 1
      ? `${visits.length} ${plural(visits.length, "пост", "поста", "постов")}`
      : "";
    body.append(el("p", "kicker", [place.city, label, count].filter(Boolean).join(" · ")));
    body.append(el("h3", "", place.name));
    const line = [fmtDate(placeDate(place)), (latest && latest.summary) || place.summary].filter(Boolean).join(" — ");
    if (line) body.append(el("p", "clamp", line));
    card.append(bar, body);
    const shot = photoNode(placeImage(place));
    if (shot) card.append(shot);
    card.addEventListener("click", () => focusPlace(place.id, true));
    box.append(card);
  }
}

function renderCities() {
  const select = document.getElementById("city");
  const cities = [...new Set(allPlaces().map((place) => place.city).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"));
  const current = state.city;
  select.replaceChildren(new Option("Все города", ""));
  for (const city of cities) select.append(new Option(city, city));
  select.value = cities.includes(current) ? current : "";
  if (select.value !== current) state.city = "";
}

function renderStats() {
  const places = allPlaces();
  const been = places.filter((place) => place.status === "been");
  const wish = places.filter((place) => place.status === "wish");
  document.getElementById("stats").textContent =
    `${been.length} ${plural(been.length, "место", "места", "мест")} позади · ${wish.length} в планах`;
  const like = been.filter((place) => rolledVerdict(place) === "like").length;
  const dislike = been.filter((place) => rolledVerdict(place) === "dislike").length;
  const mixed = been.filter((place) => rolledVerdict(place) === "mixed").length;
  document.getElementById("verdict-stats").textContent =
    `${like} понравилось · ${dislike} не зашло · ${mixed} смешанно`;
}

function paintActive() {
  document.querySelectorAll(".card").forEach((card) => {
    card.classList.toggle("active", card.dataset.id === state.selected);
  });
}

function paintChips() {
  document.querySelectorAll("[data-bucket]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.bucket === state.bucket));
  });
  document.querySelectorAll("[data-verdict]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.verdict === (state.verdict || "")));
  });
}

function render() {
  const list = visible();
  renderStats();
  renderCities();
  paintChips();
  renderList(list);
  renderMarkers(list);
  const dirty = readOverlay();
  document.getElementById("export").hidden = state.writable || (!dirty.upserts.length && !dirty.deleted.length);
}

function fitVisible() {
  const points = visible().filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon));
  if (!points.length) return;
  const bounds = L.latLngBounds(points.map((place) => [place.lat, place.lon]));
  map.invalidateSize();
  map.fitBounds(bounds.pad(0.15), { maxZoom: 11, animate: false });
}

function focusPlace(id, move) {
  state.selected = id;
  paintActive();
  if (history.replaceState) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  if (!move) return;
  const marker = markerById.get(id);
  if (!marker) return;
  markers.zoomToShowLayer(marker, () => marker.openPopup());
}

function toast(text) {
  const node = document.getElementById("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4600);
}

function buildChips() {
  const buckets = document.getElementById("bucket-chips");
  for (const [id, label] of [["all", "Все"], ["been", "Была"], ["wish", "Хочу"]]) {
    const button = el("button", "", label);
    button.type = "button";
    button.dataset.bucket = id;
    button.addEventListener("click", () => {
      state.bucket = id;
      if (id === "wish") state.verdict = null;
      render();
    });
    buckets.append(button);
  }
  const verdicts = document.getElementById("verdict-chips");
  for (const [id, label] of [["like", "Понравилось"], ["dislike", "Не зашло"], ["mixed", "Смешанно"]]) {
    const button = el("button", "", label);
    button.type = "button";
    button.dataset.verdict = id;
    button.addEventListener("click", () => {
      state.verdict = state.verdict === id ? null : id;
      if (state.verdict) state.bucket = state.bucket === "wish" ? "all" : state.bucket;
      render();
    });
    verdicts.append(button);
  }
}

async function loadBase() {
  try {
    const response = await fetch("data/places.json", { cache: "no-store" });
    if (response.ok) return await response.json();
  } catch { /* file:// or offline */ }
  return Array.isArray(window.PLACES) ? window.PLACES : [];
}

async function detectServer() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body.writable);
  } catch {
    return false;
  }
}

function readVisitsFromDom() {
  const cards = [...document.querySelectorAll("#visits .visit-card")];
  if (!cards.length) return (state.draft.visits || []).map((visit) => ({ ...visit }));
  return cards.map((card) => ({
    post: card.querySelector("[data-visit='post']").value,
    visited: card.querySelector("[data-visit='visited']").value,
    verdict: (card.querySelector("[data-visit='verdict']:checked") || {}).value || "like",
    summary: card.querySelector("[data-visit='summary']").value,
  }));
}

function renderVisitEditor() {
  const box = document.getElementById("visits");
  const visits = state.draft.visits && state.draft.visits.length ? state.draft.visits : [emptyVisit()];
  state.draft.visits = visits;
  box.replaceChildren();
  visits.forEach((visit, index) => {
    const card = el("fieldset", "visit-card");
    const head = el("div", "visit-head");
    head.append(el("span", "visit-title", visits.length > 1 ? `Пост ${index + 1}` : "Пост"));
    if (visits.length > 1) {
      const remove = el("button", "text-btn", "убрать");
      remove.type = "button";
      remove.addEventListener("click", () => {
        state.draft.visits = readVisitsFromDom();
        state.draft.visits.splice(index, 1);
        renderVisitEditor();
      });
      head.append(remove);
    }
    const summary = document.createElement("textarea");
    summary.dataset.visit = "summary";
    summary.maxLength = 500;
    summary.rows = 2;
    summary.placeholder = "Что это был за визит";
    summary.value = visit.summary || "";
    const post = document.createElement("input");
    post.dataset.visit = "post";
    post.type = "url";
    post.placeholder = "https://t.me/ya_tam_byl/…";
    post.maxLength = 300;
    post.value = visit.post || "";
    const date = document.createElement("input");
    date.dataset.visit = "visited";
    date.type = "date";
    date.value = visit.visited || "";
    const verdicts = el("div", "verdict-switch");
    for (const [value, label] of [["like", "Понравилось"], ["mixed", "Смешанно"], ["dislike", "Не понравилось"]]) {
      const labelNode = el("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `visit-verdict-${index}`;
      input.value = value;
      input.dataset.visit = "verdict";
      input.checked = (visit.verdict || "like") === value;
      labelNode.append(input, document.createTextNode(` ${label}`));
      verdicts.append(labelNode);
    }
    const summaryLabel = el("label", "field", "Коротко");
    summaryLabel.append(summary);
    const postLabel = el("label", "field", "Ссылка на пост");
    postLabel.append(post);
    const dateLabel = el("label", "field", "Дата");
    dateLabel.append(date);
    card.append(head, summaryLabel, postLabel, dateLabel, verdicts);
    box.append(card);
  });
}

function syncStatusFields() {
  const been = (state.draft.status || "wish") === "been";
  document.getElementById("been-fields").hidden = !been;
  document.getElementById("summary-field").hidden = been;
  if (been) {
    if (!(state.draft.visits || []).length) state.draft.visits = [emptyVisit()];
    renderVisitEditor();
  } else {
    document.getElementById("visits").replaceChildren();
  }
}

function readForm() {
  const form = document.getElementById("place-form");
  const data = new FormData(form);
  return {
    ...state.draft,
    id: state.draft.id,
    name: String(data.get("name") || ""),
    status: String(data.get("status") || "wish"),
    city: String(data.get("city") || ""),
    summary: String(data.get("summary") || ""),
    visits: readVisitsFromDom(),
    tags: state.draft.tags || "",
    lat: state.draft.lat,
    lon: state.draft.lon,
    address: state.draft.address || "",
    yandex: state.draft.yandex || "",
  };
}

function fillForm(draft) {
  const form = document.getElementById("place-form");
  state.draft = {
    ...state.draft,
    ...draft,
    visits: (draft.visits || []).map((visit) => ({ ...visit })),
  };
  form.elements.name.value = draft.name || "";
  form.elements.city.value = draft.city || "";
  form.elements.summary.value = draft.summary || "";
  for (const input of form.elements.status) input.checked = input.value === (draft.status || "wish");
  syncStatusFields();
  document.getElementById("sheet-title").textContent = draft.id ? "Поправить место" : "Новое место";
  document.getElementById("remove").hidden = !draft.id;
  document.getElementById("find").value = "";
  document.getElementById("find-results").replaceChildren();
  document.getElementById("form-status").textContent = "";
  document.getElementById("form-status").classList.remove("error");
  const pinField = document.getElementById("pin-field");
  pinField.hidden = !state.writable;
  if (state.writable) {
    const typed = form.elements.pin.value;
    form.elements.pin.value = localStorage.getItem(PIN_KEY) || typed || "";
  }
  paintPoint();
}

function paintPoint() {
  const node = document.getElementById("point-label");
  if (Number.isFinite(state.draft.lat) && Number.isFinite(state.draft.lon)) {
    node.textContent = `Точка: ${state.draft.lat.toFixed(5)}, ${state.draft.lon.toFixed(5)}`;
  } else {
    node.textContent = "Точка ещё не выбрана";
  }
}

function openSheet() {
  fillForm(state.draft);
  const dialog = document.getElementById("sheet");
  if (!dialog.open) dialog.showModal();
}

function closeSheet() {
  const dialog = document.getElementById("sheet");
  if (dialog.open) dialog.close();
}

function setFormStatus(text, isError) {
  const node = document.getElementById("form-status");
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
}

function cleanClientPlace(draft) {
  const name = draft.name.trim();
  if (!name) throw new Error("Нужно название");
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Найдите место или поставьте точку на карте");
  const status = draft.status === "been" ? "been" : "wish";
  const tags = String(draft.tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (status === "wish" && !tags.length) tags.push("хочу");
  let visits = [];
  let verdict = null;
  let post = safeUrl(draft.post || "") || null;
  let visited = null;
  let summary = draft.summary.trim().slice(0, 500);
  if (status === "been") {
    const incoming = draft.visits || [];
    if (!incoming.length) throw new Error("Добавьте хотя бы один пост");
    if (incoming.length > 20) throw new Error("Слишком много постов");
    visits = incoming.map((visit) => {
      const link = String(visit.post || "").trim();
      if (link && !/^https?:\/\//.test(link)) throw new Error("Ссылка на пост должна начинаться с https://");
      if (!["like", "dislike", "mixed"].includes(visit.verdict)) throw new Error("Отметьте, понравилось или нет");
      const note = String(visit.summary || "").trim().slice(0, 500);
      if (!link && !note) throw new Error("У поста нужна ссылка или пара слов");
      return {
        post: link || null,
        summary: note,
        visited: visit.visited ? String(visit.visited).slice(0, 10) : null,
        verdict: visit.verdict,
      };
    });
    const kinds = [...new Set(visits.map((visit) => visit.verdict))];
    verdict = kinds.length === 1 ? kinds[0] : "mixed";
    const latest = [...visits].sort((a, b) => (b.visited || "").localeCompare(a.visited || ""))[0];
    post = latest.post;
    visited = latest.visited;
    summary = latest.summary || "";
  }
  return {
    id: draft.id || `p-${Date.now().toString(36)}`,
    name: name.slice(0, 120),
    status,
    verdict,
    city: draft.city.trim().slice(0, 60),
    visited,
    post,
    visits,
    address: (draft.address || "").slice(0, 180),
    tags,
    lat,
    lon,
    yandex: draft.yandex || `https://yandex.ru/maps/?pt=${lon},${lat}&z=16&l=map`,
    summary,
  };
}

function rememberLocal(place) {
  const overlay = readOverlay();
  overlay.deleted = overlay.deleted.filter((id) => id !== place.id);
  overlay.upserts = overlay.upserts.filter((item) => item.id !== place.id);
  overlay.upserts.push(place);
  writeOverlay(overlay);
}

async function saveToServer(place, authorPin) {
  const response = await fetch("/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pin": authorPin },
    body: JSON.stringify({ place }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Не удалось сохранить");
  localStorage.setItem(PIN_KEY, authorPin);
  const overlay = readOverlay();
  overlay.upserts = overlay.upserts.filter((item) => item.id !== place.id);
  overlay.deleted = overlay.deleted.filter((id) => id !== place.id);
  writeOverlay(overlay);
  state.base = state.base.filter((item) => item.id !== place.id).concat(place);
}

async function deletePlace(id, authorPin) {
  if (state.writable && authorPin) {
    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pin": authorPin },
      body: JSON.stringify({ action: "delete", id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Не удалось убрать");
    localStorage.setItem(PIN_KEY, authorPin);
    state.base = state.base.filter((place) => place.id !== id);
    const overlay = readOverlay();
    overlay.upserts = overlay.upserts.filter((place) => place.id !== id);
    overlay.deleted = overlay.deleted.filter((item) => item !== id);
    writeOverlay(overlay);
    return "для всех";
  }
  const overlay = readOverlay();
  overlay.upserts = overlay.upserts.filter((place) => place.id !== id);
  if (!overlay.deleted.includes(id)) overlay.deleted.push(id);
  writeOverlay(overlay);
  return "на этом устройстве";
}

async function searchPlaces(query) {
  const remote = state.writable
    ? `/api/geocode?q=${encodeURIComponent(query)}`
    : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ru&q=${encodeURIComponent(query)}`;
  const response = await fetch(remote);
  if (!response.ok) throw new Error("search");
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    lat: Number(row.lat),
    lon: Number(row.lon),
    label: row.display_name,
    name: row.name || String(row.display_name || "").split(",")[0],
    city: cityFromAddress(row.address) || localityName(row),
  }));
}

async function reverse(lat, lon) {
  const remote = state.writable
    ? `/api/reverse?lat=${lat}&lon=${lon}`
    : `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ru&lat=${lat}&lon=${lon}`;
  const response = await fetch(remote);
  if (!response.ok) throw new Error("reverse");
  const row = await response.json();
  if (!row || row.error) return null;
  return {
    name: row.name || String(row.display_name || "").split(",")[0],
    label: row.display_name || "",
    city: cityFromAddress(row.address) || localityName(row),
  };
}

function cityFromAddress(address) {
  if (!address) return "";
  return address.city || address.town || address.village || address.hamlet || address.municipality || address.county || address.state || "";
}

function localityName(row) {
  const kind = row.addresstype || row.type || "";
  if (["city", "town", "village", "hamlet", "municipality", "administrative"].includes(kind)) {
    return row.name || "";
  }
  return "";
}

function applyHit(hit) {
  state.draft = readForm();
  state.draft.lat = hit.lat;
  state.draft.lon = hit.lon;
  state.draft.address = hit.label || state.draft.address;
  if (!state.draft.name.trim()) state.draft.name = hit.name || "";
  if (!state.draft.city.trim()) state.draft.city = hit.city || "";
  fillForm(state.draft);
}

function downloadPlaces() {
  const payload = JSON.stringify(allPlaces(), null, 2);
  const onFile = location.protocol === "file:";
  const blob = new Blob(
    [onFile ? `window.PLACES = ${payload};\n` : `${payload}\n`],
    { type: onFile ? "text/javascript" : "application/json" },
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = onFile ? "places.js" : "places.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  toast(onFile
    ? "Файл скачан. Положите его в папку карты вместо places.js и обновите страницу."
    : "Файл скачан. Положите его в папку data вместо places.json и обновите страницу — тогда правки увидят все.");
}

function wire() {
  buildChips();
  document.getElementById("q").addEventListener("input", (event) => {
    state.q = event.target.value;
    render();
  });
  document.getElementById("city").addEventListener("change", (event) => {
    state.city = event.target.value;
    render();
    fitVisible();
  });
  document.getElementById("fit").addEventListener("click", fitVisible);
  document.getElementById("share").addEventListener("click", async () => {
    if (location.protocol === "file:") {
      toast("Ссылку можно отправить, когда карта открыта через сервер, а не как файл.");
      return;
    }
    const url = `${location.origin}${location.pathname}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    toast("Ссылка скопирована. Её можно отправить кому угодно.");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement === document.body) {
      event.preventDefault();
      document.getElementById("q").focus();
    }
  });
}

async function start() {
  if (!window.L || !window.L.markerClusterGroup) {
    document.body.replaceChildren(el("p", "boot-error", "Карта не загрузилась. Обновите страницу."));
    return;
  }
  wire();
  state.writable = await detectServer();
  state.base = await loadBase();
  render();
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  const show = () => {
    map.invalidateSize();
    if (hash && allPlaces().some((place) => place.id === hash)) focusPlace(hash, true);
    else fitVisible();
  };
  requestAnimationFrame(show);
}

start();
