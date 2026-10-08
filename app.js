/* YouTube Keep — app logic */

const APP_BUILD = "2026.10.08.14";
const STORAGE_KEY = "youtube-keep:v2";
const SYNC_KEY = "youtube-keep:sync";

const CARD_COLORS = [
  { id: "default", bg: "#ffffff" },
  { id: "sand", bg: "#f7f1e6" },
  { id: "blush", bg: "#f9ebe8" },
  { id: "sage", bg: "#eaf1ea" },
  { id: "sky", bg: "#e8f0f7" },
  { id: "lilac", bg: "#f0eaf5" },
  { id: "butter", bg: "#f8f3df" },
];

const CAT_COLORS = [
  "#c2410c",
  "#b45309",
  "#0f766e",
  "#1d4ed8",
  "#7c3aed",
  "#be185d",
  "#334155",
  "#15803d",
];

const state = {
  links: [],
  categories: [],
  filter: "all", // all | pinned | category:<id>
  activeTags: new Set(),
  query: "",
  sort: "updated",
  editingLinkId: null,
  editingCategoryId: null,
  editingCategoryParentId: null,
  pendingParentFolderId: null,
  selectedColor: "default",
  selectedCatColor: CAT_COLORS[0],
  pendingConfirm: null,
  deletedCategoryIds: [],
  noteFolders: [],
  notes: [],
  deletedNoteFolderIds: [],
  deletedNoteIds: [],
  editingNoteId: null,
  editingNoteFolderId: null,
  editingNoteFolderParentId: null,
  notesOpen: true,
  importItems: [],
  sync: {
    token: "",
    gistId: "",
    auto: true,
    lastSync: null,
    status: "idle", // idle | ok | busy | err
    message: "",
  },
};

/* ---------- utils ---------- */

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function colorBg(id) {
  return CARD_COLORS.find((c) => c.id === id)?.bg || CARD_COLORS[0].bg;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-visible"), 2400);
}

/* ---------- storage ---------- */

function normalizeLink(link) {
  return {
    id: link.id || uid(),
    createdAt: link.createdAt || nowIso(),
    updatedAt: link.updatedAt || nowIso(),
    url: link.url || "",
    videoId: link.videoId || parseYouTubeId(link.url),
    title: link.title || "Без названия",
    note: link.note || "",
    categoryId: link.categoryId || null,
    tags: Array.isArray(link.tags)
      ? link.tags.map((t) => String(t).trim()).filter(Boolean)
      : String(link.tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
    color: link.color || "default",
    pinned: !!link.pinned,
    thumb: link.thumb || (link.videoId ? thumbUrl(link.videoId) : ""),
    author: link.author || "",
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // migrate from v1 if present
      const legacy = localStorage.getItem("youtube-keep:v1");
      if (legacy) {
        const data = parseJsonSafe(legacy);
        state.links = (data.links || []).map(normalizeLink);
        state.categories = data.categories || [];
      }
      if (!state.categories.length) seedDefaults();
      else saveState();
      loadSyncSettings();
      return;
    }
    const data = parseJsonSafe(raw);
    state.links = (data.links || []).map(normalizeLink);
    state.deletedCategoryIds = Array.isArray(data.deletedCategoryIds)
      ? data.deletedCategoryIds
      : [];
    state.noteFolders = Array.isArray(data.noteFolders) ? data.noteFolders : [];
    state.notes = Array.isArray(data.notes) ? data.notes : [];
    state.deletedNoteFolderIds = Array.isArray(data.deletedNoteFolderIds)
      ? data.deletedNoteFolderIds
      : [];
    state.deletedNoteIds = Array.isArray(data.deletedNoteIds) ? data.deletedNoteIds : [];
    // purge deleted notes/folders
    const deadF = new Set(state.deletedNoteFolderIds);
    const deadN = new Set(state.deletedNoteIds);
    state.noteFolders = (state.noteFolders || []).filter((f) => f.id && !deadF.has(f.id));
    state.notes = (state.notes || []).filter((n) => n.id && !deadN.has(n.id));
    const dead = new Set(state.deletedCategoryIds);
    state.categories = (Array.isArray(data.categories) ? data.categories : [])
      .filter((c) => c.id && !dead.has(c.id))
      .map((c) => ({
        id: c.id || uid(),
        name: c.name || "Без названия",
        color: c.color || CAT_COLORS[0],
        parentId: c.parentId || null,
      }));
    state.links = state.links.map((l) =>
      l.categoryId && dead.has(l.categoryId) ? { ...l, categoryId: null } : l
    );
    if (!state.categories.length) seedDefaults();
    loadSyncSettings();
  } catch {
    seedDefaults();
    loadSyncSettings();
  }
}

function saveState(options = {}) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      links: state.links,
      categories: state.categories,
      deletedCategoryIds: state.deletedCategoryIds || [],
      noteFolders: state.noteFolders || [],
      notes: state.notes || [],
      deletedNoteFolderIds: state.deletedNoteFolderIds || [],
      deletedNoteIds: state.deletedNoteIds || [],
      noteFolders: state.noteFolders || [],
      notes: state.notes || [],
      deletedNoteFolderIds: state.deletedNoteFolderIds || [],
      deletedNoteIds: state.deletedNoteIds || [],
    })
  );
  if (options.sync !== false) scheduleAutoSync();
}

const appConfig = {
  gistId: "",
  tokenUrl: "https://github.com/settings/tokens/new?scopes=gist&description=YouTube%20Keep",
};

async function loadAppConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-cache" });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.gistId) appConfig.gistId = cfg.gistId;
    if (cfg.tokenUrl) appConfig.tokenUrl = cfg.tokenUrl;
    if (appConfig.gistId && !state.sync.gistId) {
      state.sync.gistId = appConfig.gistId;
      saveSyncSettings();
    }
    const getCode = document.getElementById("btn-get-code");
    if (getCode && appConfig.tokenUrl) getCode.href = appConfig.tokenUrl;
    renderSyncStatus();
    if (isCloudReady()) {
      startCloudWatch();
      syncAll().catch(() => {});
    }
  } catch {
    /* offline / no config */
  }
}

function loadSyncSettings() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) {
      if (appConfig.gistId) state.sync.gistId = appConfig.gistId;
      return;
    }
    const data = parseJsonSafe(raw);
    state.sync.token = data.token || "";
    state.sync.gistId = data.gistId || appConfig.gistId || "";
    state.sync.auto = data.auto !== false;
    state.sync.lastSync = data.lastSync || null;
  } catch {
    /* ignore */
  }
}

function saveSyncSettings() {
  localStorage.setItem(
    SYNC_KEY,
    JSON.stringify({
      token: state.sync.token,
      gistId: state.sync.gistId,
      auto: state.sync.auto,
      lastSync: state.sync.lastSync,
    })
  );
  if (state.sync.token && state.sync.gistId) {
    localStorage.setItem("youtube-keep:setup-dismissed", "1");
  }
}

function seedDefaults() {
  const edu = uid();
  const music = uid();
  const dev = uid();
  const insp = uid();
  state.categories = [
    { id: edu, name: "Образование", color: CAT_COLORS[2], parentId: null },
    { id: uid(), name: "Курсы", color: CAT_COLORS[2], parentId: edu },
    { id: uid(), name: "Лекции", color: CAT_COLORS[2], parentId: edu },
    { id: music, name: "Музыка", color: CAT_COLORS[4], parentId: null },
    { id: uid(), name: "Клипы", color: CAT_COLORS[4], parentId: music },
    { id: uid(), name: "Live", color: CAT_COLORS[4], parentId: music },
    { id: dev, name: "Разработка", color: CAT_COLORS[3], parentId: null },
    { id: uid(), name: "Frontend", color: CAT_COLORS[3], parentId: dev },
    { id: uid(), name: "Backend", color: CAT_COLORS[3], parentId: dev },
    { id: insp, name: "Вдохновение", color: CAT_COLORS[0], parentId: null },
  ];
  saveState();
}

/* ---------- youtube ---------- */

function parseYouTubeId(input) {
  if (!input) return null;
  const text = String(input).trim();

  if (/^[\w-]{11}$/.test(text)) return text;

  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\.|^m\./, "");

    if (host === "youtu.be") {
      return url.pathname.slice(1).split("/")[0] || null;
    }

    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = url.searchParams.get("v");
      if (v) return v.slice(0, 11);

      const parts = url.pathname.split("/").filter(Boolean);
      const markers = ["shorts", "embed", "live", "v"];
      const idx = parts.findIndex((p) => markers.includes(p));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].slice(0, 11);
    }
  } catch {
    return null;
  }
  return null;
}

function thumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function fetchYouTubeMeta(input) {
  const videoId = parseYouTubeId(input);
  if (!videoId) throw new Error("Не удалось распознать YouTube-ссылку");

  const canonical = watchUrl(videoId);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`
    );
    if (!res.ok) throw new Error("oembed failed");
    const data = await res.json();
    return {
      videoId,
      title: data.title || "",
      author: data.author_name || "",
      thumb: data.thumbnail_url || thumbUrl(videoId),
    };
  } catch {
    return {
      videoId,
      title: "",
      author: "",
      thumb: thumbUrl(videoId),
    };
  }
}

/* ---------- filtering / sorting ---------- */

function visibleLinks() {
  let list = [...state.links];

  if (state.filter === "pinned") {
    list = list.filter((l) => l.pinned);
  } else if (state.filter.startsWith("category:")) {
    const catId = state.filter.slice("category:".length);
    const ids = categoryDescendantIds(catId);
    list = list.filter((l) => l.categoryId && ids.has(l.categoryId));
  }

  if (state.activeTags.size) {
    list = list.filter((l) => {
      const tags = (l.tags || []).map((t) => t.toLowerCase());
      return [...state.activeTags].every((t) => tags.includes(t));
    });
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter((l) => {
      const cat = state.categories.find((c) => c.id === l.categoryId);
      const hay = [l.title, l.note, l.url, cat?.name, (l.tags || []).join(" ")]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const sort = state.sort;
  list.sort((a, b) => {
    if (sort === "title") return (a.title || "").localeCompare(b.title || "", "ru");
    if (sort === "category") {
      const an = state.categories.find((c) => c.id === a.categoryId)?.name || "";
      const bn = state.categories.find((c) => c.id === b.categoryId)?.name || "";
      return an.localeCompare(bn, "ru") || (a.title || "").localeCompare(b.title || "", "ru");
    }
    if (sort === "pinned") {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    }
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  });

  return list;
}

/* ---------- render ---------- */


function categoryChildren(parentId) {
  return state.categories.filter((c) => (c.parentId || null) === (parentId || null));
}

function categoryDescendantIds(id) {
  const out = new Set([id]);
  const walk = (pid) => {
    for (const c of state.categories) {
      if ((c.parentId || null) === (pid || null) && !out.has(c.id)) {
        out.add(c.id);
        walk(c.id);
      }
    }
  };
  walk(id);
  return out;
}

function countLinksInCategory(id) {
  const ids = categoryDescendantIds(id);
  return state.links.filter((l) => l.categoryId && ids.has(l.categoryId)).length;
}

function categoryDepth(id) {
  let depth = 0;
  let cur = state.categories.find((c) => c.id === id);
  const seen = new Set();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth += 1;
    cur = state.categories.find((c) => c.id === cur.parentId);
  }
  return depth;
}

function buildCategoryTreeRows(parentId = null, depth = 0) {
  const rows = [];
  const kids = categoryChildren(parentId).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );
  for (const cat of kids) {
    rows.push({ cat, depth, children: categoryChildren(cat.id).length });
    rows.push(...buildCategoryTreeRows(cat.id, depth + 1));
  }
  return rows;
}

function categoryPathLabel(id) {
  const parts = [];
  let cur = state.categories.find((c) => c.id === id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? state.categories.find((c) => c.id === cur.parentId) : null;
  }
  return parts.join(" / ");
}

function renderCategories() {
  const list = document.getElementById("category-list");
  // dedupe by name at render time (merge leftovers from old syncs)
  const seenNames = new Set();
  const roots = categoryChildren(null)
    .filter((cat) => {
      const key = String(cat.name || "").trim().toLowerCase();
      if (!key || seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru"));

  if (!roots.length) {
    list.innerHTML = `<div class="list-empty">Направлений пока нет</div>`;
  } else {
    list.innerHTML = roots
      .map((cat) => {
        const count = countLinksInCategory(cat.id);
        const subCount = categoryChildren(cat.id).length;
        const active = state.filter === `category:${cat.id}`;
        return `
        <div class="dir-row ${active ? "is-active" : ""}">
          <button class="dir-btn" data-category-id="${cat.id}" type="button" title="${escapeHtml(cat.name)}">
            <span class="dir-gear" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2.5l1.1 2.2 2.4-.4 1.1 2.2 2.2 1.1-.4 2.4 2.2 1.1-2.2 1.1.4 2.4-2.2 1.1-1.1 2.2-2.4-.4L12 21.5l-1.1-2.2-2.4.4-1.1-2.2-2.2-1.1.4-2.4L3.4 12l2.2-1.1-.4-2.4 2.2-1.1 1.1-2.2 2.4.4L12 2.5z"/>
              </svg>
            </span>
            <span class="dir-name">${escapeHtml(cat.name)}</span>
            <span class="dir-counts">
              ${subCount ? `<span class="dir-badge" title="Подпапки">${subCount}</span>` : ""}
              <span class="dir-num" title="Ссылки">${count}</span>
            </span>
          </button>
          <div class="dir-actions">
            <button type="button" class="dir-act" data-add-sub="${cat.id}" title="Подпапка" aria-label="Подпапка">+</button>
            <button type="button" class="dir-act" data-edit-cat="${cat.id}" title="Переименовать" aria-label="Переименовать">…</button>
            <button type="button" class="dir-act" data-del-cat="${cat.id}" title="Удалить" aria-label="Удалить">×</button>
          </div>
        </div>`;
      })
      .join("");
  }

  document.getElementById("count-all").textContent = state.links.length;
  document.getElementById("count-pinned").textContent = state.links.filter((l) => l.pinned).length;

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === state.filter);
  });
  document.querySelectorAll(".dir-row").forEach((row) => {
    const id = row.querySelector("[data-category-id]")?.dataset.categoryId;
    row.classList.toggle("is-active", state.filter === `category:${id}`);
  });
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function noteFolderChildren(parentId) {
  return (state.noteFolders || []).filter(
    (f) => (f.parentId || null) === (parentId || null)
  );
}

function notesInFolder(folderId) {
  return (state.notes || []).filter((n) => (n.folderId || null) === (folderId || null));
}

function noteFolderDescendantIds(id) {
  const out = new Set([id || null]);
  const walk = (pid) => {
    for (const f of state.noteFolders || []) {
      if ((f.parentId || null) === (pid || null) && !out.has(f.id)) {
        out.add(f.id);
        walk(f.id);
      }
    }
  };
  walk(id);
  return out;
}

function countNotesInFolder(id) {
  const ids = noteFolderDescendantIds(id);
  return (state.notes || []).filter((n) => n.folderId && ids.has(n.folderId)).length;
}

function currentNotesFolderId() {
  if (!state.filter.startsWith("notes:")) return null;
  const rest = state.filter.slice("notes:".length);
  if (!rest || rest === "all") return null;
  return rest;
}

function currentFolderId() {
  if (!state.filter.startsWith("category:")) return null;
  return state.filter.slice("category:".length) || null;
}

function breadcrumbHtml(folderId) {
  const parts = [];
  let cur = folderId ? state.categories.find((c) => c.id === folderId) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur);
    cur = cur.parentId ? state.categories.find((c) => c.id === cur.parentId) : null;
  }
  const items = [`<button type="button" class="crumb" data-goto-folder="">Все ссылки</button>`];
  for (const part of parts) {
    items.push(`<span class="crumb-sep">/</span>`);
    items.push(
      `<button type="button" class="crumb" data-goto-folder="${part.id}">${escapeHtml(part.name)}</button>`
    );
  }
  return items.join("");
}

function folderTilesHtml(folderId) {
  const kids = categoryChildren(folderId).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );
  if (!kids.length) return "";
  return `
    <div class="folder-strip">
      ${kids
        .map(
          (cat) => `
        <div class="folder-tile-wrap" style="--folder-color:${cat.color}">
          <button type="button" class="folder-tile" data-open-folder="${cat.id}">
            <span class="folder-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2.5h7.5A2.5 2.5 0 0121 10v7.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5v-10z"/>
              </svg>
            </span>
            <span class="folder-name">${escapeHtml(cat.name)}</span>
            <span class="folder-badges">
              ${
                categoryChildren(cat.id).length
                  ? `<span class="badge badge-folders" title="Подпапки">${categoryChildren(cat.id).length} пап</span>`
                  : ""
              }
              <span class="badge badge-links" title="Ссылки">${countLinksInCategory(cat.id)}</span>
            </span>
          </button>
          <div class="folder-actions always">
            <button type="button" class="mini-btn" data-add-sub="${cat.id}" title="Создать подпапку" aria-label="Создать подпапку">+</button>
            <button type="button" class="mini-btn" data-edit-cat="${cat.id}" title="Переименовать" aria-label="Переименовать">✎</button>
            <button type="button" class="mini-btn" data-del-cat="${cat.id}" title="Удалить папку" aria-label="Удалить папку">×</button>
          </div>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderNotesSidebar() {
  const list = document.getElementById("notes-list");
  const countEl = document.getElementById("count-notes");
  if (countEl) countEl.textContent = String((state.notes || []).length);

  const parents = [null, currentNotesFolderId()].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  // show roots when on notes:all or root folder; show children when inside folder
  const pid = currentNotesFolderId();
  const items = noteFolderChildren(pid).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );

  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="list-empty">Папок заметок нет</div>`;
    return;
  }
  list.innerHTML = items
    .map((f) => {
      const active = state.filter === `notes:${f.id}`;
      return `
      <div class="dir-row ${active ? "is-active" : ""}">
        <button class="dir-btn" data-note-folder="${f.id}" type="button">
          <span class="dir-gear" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M5 4h11l3 3v13H5V4z"/><path d="M8 10h8M8 14h6"/>
            </svg>
          </span>
          <span class="dir-name">${escapeHtml(f.name)}</span>
          <span class="dir-counts">
            <span class="dir-num">${countNotesInFolder(f.id)}</span>
          </span>
        </button>
        <div class="dir-actions">
          <button type="button" class="dir-act" data-note-folder-add="${f.id}" title="Подпапка" aria-label="Подпапка">+</button>
          <button type="button" class="dir-act" data-note-folder-edit="${f.id}" title="Переименовать" aria-label="Переименовать">…</button>
        </div>
      </div>`;
    })
    .join("");
}

function renderNotesView() {
  const hero = document.getElementById("folder-hero");
  const strip = document.getElementById("folder-strip");
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const titleEl = document.getElementById("page-title");
  const subEl = document.getElementById("page-sub");
  const crumbEl = document.getElementById("breadcrumbs");

  const folderId = currentNotesFolderId();
  const folder = folderId
    ? (state.noteFolders || []).find((f) => f.id === folderId)
    : null;

  titleEl.textContent = folder ? folder.name : "Все заметки";
  subEl.textContent = folder
    ? "Заметки и подпапки этой папки"
    : "Личные заметки отдельно от видео";
  if (crumbEl) {
    if (!folderId) crumbEl.innerHTML = "";
    else {
      const parts = [];
      let cur = folder;
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur);
        cur = cur.parentId
          ? (state.noteFolders || []).find((f) => f.id === cur.parentId)
          : null;
      }
      crumbEl.innerHTML =
        `<button type="button" class="crumb" data-note-goto="">Заметки</button>` +
        parts
          .map(
            (p) =>
              `<span class="crumb-sep">/</span><button type="button" class="crumb" data-note-goto="${p.id}">${escapeHtml(p.name)}</button>`
          )
          .join("");
    }
  }

  if (hero) {
    if (folderId && folder) {
      hero.hidden = false;
      hero.innerHTML = `
        <div class="folder-hero-inner">
          <div class="folder-hero-icon" style="--folder-color:${folder.color || "#c2410c"}">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M5 4h11l3 3v13H5V4z"/><path d="M8 10h8M8 14h6"/>
            </svg>
          </div>
          <div class="folder-hero-text">
            <div class="folder-hero-kicker">Папка заметок</div>
            <h2 class="folder-hero-title">${escapeHtml(folder.name)}</h2>
            <div class="folder-hero-meta">
              <span>${notesInFolder(folderId).length} заметок</span>
            </div>
          </div>
          <div class="folder-hero-actions">
            <button type="button" class="secondary-btn" data-note-folder-add="${folderId}">+ Подпапка</button>
            <button type="button" class="primary-btn" data-note-add="${folderId}">+ Заметка</button>
          </div>
        </div>`;
    } else {
      hero.hidden = false;
      hero.innerHTML = `
        <div class="folder-hero-inner">
          <div class="folder-hero-icon" style="--folder-color:#c2410c">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M5 4h11l3 3v13H5V4z"/><path d="M8 10h8M8 14h6"/>
            </svg>
          </div>
          <div class="folder-hero-text">
            <div class="folder-hero-kicker">Заметки</div>
            <h2 class="folder-hero-title">Библиотека заметок</h2>
            <div class="folder-hero-meta"><span>${(state.notes || []).length} заметок</span></div>
          </div>
          <div class="folder-hero-actions">
            <button type="button" class="secondary-btn" data-note-folder-add="">+ Папка</button>
            <button type="button" class="primary-btn" data-note-add="">+ Заметка</button>
          </div>
        </div>`;
    }
  }

  // subfolders strip
  const kids = noteFolderChildren(folderId).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );
  if (strip) {
    if (!kids.length) strip.innerHTML = "";
    else {
      strip.innerHTML =
        `<div class="folder-strip-label">Вложенные папки</div>` +
        kids
          .map(
            (cat) => `
        <div class="folder-tile-wrap" style="--folder-color:${cat.color || "#c2410c"}">
          <button type="button" class="folder-tile" data-note-folder="${cat.id}">
            <span class="folder-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M5 4h11l3 3v13H5V4z"/><path d="M8 10h8M8 14h6"/>
              </svg>
            </span>
            <span class="folder-name">${escapeHtml(cat.name)}</span>
            <span class="folder-badges">
              ${noteFolderChildren(cat.id).length ? `<span class="badge badge-folders">${noteFolderChildren(cat.id).length} пап</span>` : ""}
              <span class="badge badge-links">${notesInFolder(cat.id).length}</span>
            </span>
          </button>
          <div class="folder-actions always">
            <button type="button" class="mini-btn" data-note-folder-add="${cat.id}" title="Подпапка">+</button>
            <button type="button" class="mini-btn" data-note-folder-edit="${cat.id}" title="Переименовать">✎</button>
            <button type="button" class="mini-btn" data-note-folder-del="${cat.id}" title="Удалить">×</button>
          </div>
        </div>`
          )
          .join("");
    }
  }

  const list = notesInFolder(folderId)
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  if (!list.length && !kids.length) {
    if (grid) grid.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.querySelector(".empty-title").textContent = "Заметок пока нет";
      empty.querySelector(".empty-text").textContent =
        "Создайте папку или первую заметку.";
      const btn = empty.querySelector("#btn-empty-add");
      if (btn) {
        btn.textContent = "Добавить заметку";
        btn.setAttribute("data-note-add", folderId || "");
        btn.removeAttribute("id");
      }
    }
    return;
  }
  if (empty) empty.hidden = true;

  if (grid) {
    grid.innerHTML = list
      .map((n) => {
        const preview = String(n.text || "")
          .replace(/\s+/g, " ")
          .slice(0, 140);
        return `
        <article class="card note-card" data-note-id="${n.id}">
          <div class="card-body">
            <div class="card-top">
              <h3 class="card-title">${escapeHtml(n.title || "Заметка")}</h3>
            </div>
            <p class="card-note">${escapeHtml(preview)}${preview.length >= 140 ? "…" : ""}</p>
            <div class="card-meta">
              <span class="chip">${n.updatedAt ? new Date(n.updatedAt).toLocaleDateString("ru-RU") : ""}</span>
              <div class="card-actions">
                <button class="icon-btn" data-note-open="${n.id}" title="Открыть" aria-label="Открыть">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 4h11l3 3v13H5V4z"/></svg>
                </button>
                <button class="icon-btn danger" data-note-del="${n.id}" title="Удалить" aria-label="Удалить">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            </div>
          </div>
        </article>`;
      })
      .join("");
  }
}

function renderGrid() {
  if (state.filter.startsWith("notes:")) {
    renderNotesSidebar();
    renderNotesView();
    return;
  }
  renderNotesSidebar();
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const folderId = currentFolderId();

  // drill-down: only links sitting in THIS folder (subfolders are tiles)
  let list = [...state.links];
  if (state.filter === "pinned") {
    list = list.filter((l) => l.pinned);
  } else if (folderId) {
    list = list.filter((l) => l.categoryId === folderId);
  }

  if (state.activeTags.size) {
    list = list.filter((l) => {
      const tags = (l.tags || []).map((t) => t.toLowerCase());
      return [...state.activeTags].every((t) => tags.includes(t));
    });
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter((l) => {
      const cat = state.categories.find((c) => c.id === l.categoryId);
      const hay = [l.title, l.note, l.url, cat?.name, (l.tags || []).join(" ")]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const sort = state.sort;
  list.sort((a, b) => {
    if (sort === "title") return (a.title || "").localeCompare(b.title || "", "ru");
    if (sort === "category") {
      const an = state.categories.find((c) => c.id === a.categoryId)?.name || "";
      const bn = state.categories.find((c) => c.id === b.categoryId)?.name || "";
      return an.localeCompare(bn, "ru") || (a.title || "").localeCompare(b.title || "", "ru");
    }
    if (sort === "pinned") {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    }
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  });

  const titleEl = document.getElementById("page-title");
  const subEl = document.getElementById("page-sub");
  const crumbEl = document.getElementById("breadcrumbs");
  const folderStrip = document.getElementById("folder-strip");

  if (state.filter === "pinned") {
    titleEl.textContent = "Закреплённые";
    subEl.textContent = "Самое важное — под рукой";
    if (crumbEl) crumbEl.innerHTML = "";
    if (folderStrip) folderStrip.innerHTML = "";
    const hero = document.getElementById("folder-hero");
    if (hero) {
      hero.hidden = true;
      hero.innerHTML = "";
    }
  } else if (folderId) {
    const cat = state.categories.find((c) => c.id === folderId);
    const isSub = !!cat?.parentId;
    const path = categoryPathLabel(folderId);
    titleEl.textContent = cat?.name || "Папка";
    subEl.textContent = isSub ? "Содержимое подпапки ниже" : "Папка и её вложенные разделы ниже";
    if (crumbEl) crumbEl.innerHTML = breadcrumbHtml(folderId);

    // big identity card: which folder you are in + YouTube cards underneath
    const hero = document.getElementById("folder-hero");
    if (hero) {
      const linkCount = state.links.filter((l) => l.categoryId === folderId).length;
      const subCount = categoryChildren(folderId).length;
      hero.hidden = false;
      hero.innerHTML = `
        <div class="folder-hero-inner">
          <div class="folder-hero-icon" style="--folder-color:${cat?.color || "#c2410c"}">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2.5h7.5A2.5 2.5 0 0121 10v7.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5v-10z"/>
            </svg>
          </div>
          <div class="folder-hero-text">
            <div class="folder-hero-kicker">${isSub ? "Подпапка" : "Папка"} · ${escapeHtml(path)}</div>
            <h2 class="folder-hero-title">${escapeHtml(cat?.name || "Папка")}</h2>
            <div class="folder-hero-meta">
              <span>${linkCount} ${plural(linkCount, "ссылка", "ссылки", "ссылок")}</span>
              ${subCount ? `<span class="dot-sep">·</span><span>${subCount} ${plural(subCount, "подпапка", "подпапки", "подпапок")}</span>` : ""}
            </div>
          </div>
          <div class="folder-hero-actions">
            <button type="button" class="secondary-btn" data-add-sub="${folderId}">+ Подпапка</button>
            <button type="button" class="secondary-btn" data-edit-cat="${folderId}">Переименовать</button>
          </div>
        </div>`;
    }

    if (folderStrip) {
      const kids = folderTilesHtml(folderId);
      folderStrip.innerHTML = kids
        ? `<div class="folder-strip-label">Вложенные папки</div>` + kids
        : "";
    }
  } else {
    titleEl.textContent = "Все ссылки";
    subEl.textContent = "Выберите направление слева или папку ниже";
    if (crumbEl) crumbEl.innerHTML = "";
    const hero = document.getElementById("folder-hero");
    if (hero) {
      hero.hidden = true;
      hero.innerHTML = "";
    }
    if (folderStrip) folderStrip.innerHTML = folderTilesHtml(null);
  }

  if (!list.length && !(folderStrip && folderStrip.innerHTML)) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = list
    .map((link) => {
      const cat = state.categories.find((c) => c.id === link.categoryId);
      const videoId = link.videoId || parseYouTubeId(link.url);
      const thumb = link.thumb || (videoId ? thumbUrl(videoId) : "");
      return `
        <article class="card" style="--card-bg:${colorBg(link.color)}" data-id="${link.id}">
          <a class="card-link card-thumb" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
            ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : ""}
            <div class="card-play"><div class="play-circle">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>
            </div></div>
          </a>
          <div class="card-body">
            <div class="card-top">
              <a class="card-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">
                <h3 class="card-title">${escapeHtml(link.title || "Без названия")}</h3>
              </a>
            </div>
            <div class="note-fold" data-note-fold="${link.id}">
              <button type="button" class="note-fold-head" data-note="${link.id}" aria-expanded="false">
                <span class="note-fold-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </span>
                <span class="note-fold-label">Заметка</span>
                <span class="note-fold-preview">${link.note ? escapeHtml(String(link.note).replace(/\s+/g, " ").slice(0, 64) + (String(link.note).length > 64 ? "…" : "")) : "добавить текст"}</span>
              </button>
              <div class="note-fold-body" hidden>
                <textarea class="note-fold-input" rows="4" placeholder="О чём видео, мысли, что запомнить…">${escapeHtml(link.note || "")}</textarea>
                <div class="note-fold-actions">
                  <button type="button" class="secondary-btn note-save" data-note-save="${link.id}">Готово</button>
                  ${
                    link.note
                      ? `<button type="button" class="ghost-btn note-clear" data-note-clear="${link.id}">Очистить</button>`
                      : ""
                  }
                </div>
              </div>
            </div>
            <div class="card-meta">
              ${
                cat
                  ? `<span class="chip"><span class="chip-dot" style="background:${cat.color}"></span>${escapeHtml(cat.name)}</span>`
                  : `<span class="chip">Без папки</span>`
              }
              <div class="card-actions">
                <button class="icon-btn ${link.pinned ? "is-active" : ""}" data-pin="${link.id}" title="${link.pinned ? "Открепить" : "Закрепить"}" aria-label="${link.pinned ? "Открепить" : "Закрепить"}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="${link.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.2 6.4H21l-5.3 3.9 2 6.4L12 16.8 6.3 19.7l2-6.4L3 9.4h6.8L12 3z"/></svg>
                </button>
                <button class="icon-btn" data-edit="${link.id}" title="Редактировать" aria-label="Редактировать">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <button class="icon-btn danger" data-delete="${link.id}" title="Удалить" aria-label="Удалить">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                </button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function allTags() {
  const map = new Map();
  for (const link of state.links) {
    for (const tag of link.tags || []) {
      const key = tag.toLowerCase();
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
}

function renderTags() {
  const el = document.getElementById("tag-list");
  const tags = allTags();
  if (!tags.length) {
    el.innerHTML = `<span class="hint">Теги появятся у карточек</span>`;
    return;
  }
  el.innerHTML = tags
    .map(([tag, count]) => {
      const active = state.activeTags.has(tag);
      return `<button type="button" class="tag-chip ${active ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
        <span>#${escapeHtml(tag)}</span><span class="tag-count">${count}</span>
      </button>`;
    })
    .join("");
}

function parseTagsInput(value) {
  return String(value || "")
    .split(/[,;#\n]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

function render() {
  const buildEl = document.getElementById("build-label");
  if (buildEl) buildEl.textContent = `Сборка ${APP_BUILD}`;
  renderCategories();
  renderTags();
  renderGrid();
  fillCategorySelect();
  renderSyncStatus();
  const setup = document.getElementById("setup-banner");
  const sync = document.getElementById("sync-banner");
  const ready = isCloudReady();
  if (setup) {
    if (ready) setup.setAttribute("hidden", "");
    else setup.removeAttribute("hidden");
  }
  if (sync) {
    if (ready) sync.removeAttribute("hidden");
    else sync.setAttribute("hidden", "");
  }
}

function fillCategorySelect() {
  const rows = buildCategoryTreeRows();
  const options =
    `<option value="">Без папки</option>` +
    rows
      .map(({ cat, depth }) => {
        const pad = "\u00A0".repeat(depth * 2);
        return `<option value="${cat.id}">${pad}${escapeHtml(categoryPathLabel(cat.id))}</option>`;
      })
      .join("");
  for (const id of ["link-category", "import-category"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    const current = select.value;
    select.innerHTML = options;
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }
}

function openModal(id) {
  document.getElementById(id).hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
  if (![...document.querySelectorAll(".modal")].some((m) => !m.hidden)) {
    document.body.style.overflow = "";
  }
}

function renderColorPicks(containerId, colors, selectedId, onPick) {
  const el = document.getElementById(containerId);
  el.innerHTML = colors
    .map((c) => {
      const id = typeof c === "string" ? c : c.id;
      const bg = typeof c === "string" ? c : c.bg;
      return `<button type="button" class="color-swatch ${id === selectedId ? "is-selected" : ""}" data-color="${id}" style="background:${bg}" aria-label="Цвет ${id}"></button>`;
    })
    .join("");
  el.onclick = (e) => {
    const btn = e.target.closest("[data-color]");
    if (!btn) return;
    onPick(btn.dataset.color);
  };
}

function openNoteStoreModal(noteId = null, folderId = null) {
  state.editingNoteId = noteId;
  const note = noteId ? (state.notes || []).find((n) => n.id === noteId) : null;
  document.getElementById("note-store-title").textContent = note ? "Редактировать заметку" : "Новая заметка";
  document.getElementById("note-store-name").value = note?.title || "";
  document.getElementById("note-store-text").value = note?.text || "";
  const del = document.getElementById("btn-note-store-delete");
  if (del) del.hidden = !note;
  state.editingNoteFolderParentId = folderId !== null ? folderId : note?.folderId || currentNotesFolderId();
  openModal("modal-note-store");
  setTimeout(() => document.getElementById("note-store-name")?.focus(), 50);
}

function openNoteFolderModal(folderId = null, parentId = null) {
  const folder = folderId
    ? (state.noteFolders || []).find((f) => f.id === folderId)
    : null;
  state.editingNoteFolderId = folderId;
  state.editingNoteFolderParentId = folder
    ? folder.parentId || null
    : parentId !== null
      ? parentId
      : currentNotesFolderId();
  document.getElementById("note-folder-title").textContent = folder
    ? "Редактировать папку"
    : "Новая папка заметок";
  document.getElementById("note-folder-name").value = folder?.name || "";
  const parentLabel = document.getElementById("note-folder-parent");
  if (parentLabel) {
    parentLabel.textContent = state.editingNoteFolderParentId
      ? "Вложенная папка"
      : "Верхний уровень";
  }
  const del = document.getElementById("btn-note-folder-delete");
  if (del) del.hidden = !folder;
  openModal("modal-note-folder");
  setTimeout(() => document.getElementById("note-folder-name")?.focus(), 50);
}

function openNoteModal(id) {
  const link = state.links.find((l) => l.id === id);
  if (!link) return;
  state.editingLinkId = id;
  const titleEl = document.getElementById("note-modal-title");
  const input = document.getElementById("note-text");
  const preview = document.getElementById("note-video-title");
  if (titleEl) titleEl.textContent = "Заметка к видео";
  if (preview) preview.textContent = link.title || "";
  if (input) {
    input.value = link.note || "";
    setTimeout(() => input.focus(), 50);
  }
  openModal("modal-note");
}

function saveNoteFromModal() {
  const link = state.links.find((l) => l.id === state.editingLinkId);
  if (!link) return;
  const input = document.getElementById("note-text");
  link.note = (input?.value || "").trim();
  link.updatedAt = nowIso();
  saveState();
  closeModal("modal-note");
  render();
  toast(link.note ? "Заметка сохранена" : "Заметка удалена");
}

function openLinkModal(link = null) {
  state.editingLinkId = link?.id || null;
  state.selectedColor = link?.color || "default";

  document.getElementById("modal-link-title").textContent = link ? "Редактировать" : "Новая ссылка";
  document.getElementById("link-url").value = link?.url || "";
  document.getElementById("link-title").value = link?.title || "";
  document.getElementById("link-note").value = link?.note || "";
  document.getElementById("link-tags").value = (link?.tags || []).join(", ");
  document.getElementById("link-pinned").checked = !!link?.pinned;
  renderTagSuggestions();
  fillCategorySelect();
  document.getElementById("link-category").value = link?.categoryId || "";

  const preview = document.getElementById("preview-row");
  const videoId = link?.videoId || parseYouTubeId(link?.url || "");
  if (link && (link.thumb || videoId)) {
    preview.hidden = false;
    document.getElementById("preview-thumb").src = link.thumb || thumbUrl(videoId);
    document.getElementById("preview-title").textContent = link.title || "";
    document.getElementById("preview-channel").textContent = link.author || "";
  } else {
    preview.hidden = true;
  }

  const hint = document.getElementById("fetch-hint");
  hint.className = "hint";
  hint.textContent = "Можно вставить ссылку — название и превью подтянутся автоматически.";

  openLinkModalRefreshColors();

  openModal("modal-link");
  setTimeout(() => document.getElementById("link-url").focus(), 50);
}

function renderTagSuggestions() {
  const box = document.getElementById("tag-suggestions");
  const current = parseTagsInput(document.getElementById("link-tags").value).map((t) => t.toLowerCase());
  const suggestions = allTags()
    .map(([t]) => t)
    .filter((t) => !current.includes(t))
    .slice(0, 8);
  box.innerHTML = suggestions
    .map((t) => `<button type="button" class="tag-suggest" data-suggest-tag="${escapeHtml(t)}">+#${escapeHtml(t)}</button>`)
    .join("");
}

function openLinkModalRefreshColors() {
  renderColorPicks("color-picks", CARD_COLORS, state.selectedColor, (id) => {
    state.selectedColor = id;
    openLinkModalRefreshColors();
  });
}

function openCategoryModal(category = null, parentCatId = null) {
  const isEdit = !!category;
  const parentId = isEdit ? category.parentId || null : parentCatId || null;
  document.getElementById("modal-cat-title").textContent = isEdit
    ? parentId
      ? "Редактировать подпапку"
      : "Редактировать папку"
    : parentId
      ? "Новая подпапка"
      : "Новое направление";
  document.getElementById("cat-submit").textContent = isEdit ? "Сохранить" : "Создать";
  document.getElementById("cat-name").value = category?.name || "";
  state.selectedCatColor = category?.color || CAT_COLORS[0];
  state.editingCategoryId = category?.id || null;
  state.editingCategoryParentId = parentId;
  state.pendingParentFolderId = parentId;

  const parentLabel = document.getElementById("cat-parent-label");
  if (parentLabel) {
    parentLabel.textContent = parentId
      ? `В папке: ${categoryPathLabel(parentId)}`
      : "Верхний уровень (направление)";
  }

  openCategoryModalRefresh();
  openModal("modal-category");
  setTimeout(() => document.getElementById("cat-name").focus(), 50);
}

function openCategoryModalRefresh() {
  renderColorPicks("cat-color-picks", CAT_COLORS, state.selectedCatColor, (id) => {
    state.selectedCatColor = id;
    openCategoryModalRefresh();
  });
}

function confirmAction(title, text, onOk) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  state.pendingConfirm = onOk;
  openModal("modal-confirm");
}

/* ---------- actions ---------- */

async function handleFetchMeta() {
  const input = document.getElementById("link-url").value.trim();
  const hint = document.getElementById("fetch-hint");
  const btn = document.getElementById("btn-fetch");
  if (!input) {
    hint.textContent = "Вставьте ссылку";
    hint.className = "hint is-err";
    return;
  }

  btn.disabled = true;
  btn.textContent = "…";
  hint.textContent = "Загружаю данные видео…";
  hint.className = "hint";

  try {
    const meta = await fetchYouTubeMeta(input);
    document.getElementById("link-url").value = watchUrl(meta.videoId);
    if (!document.getElementById("link-title").value.trim() && meta.title) {
      document.getElementById("link-title").value = meta.title;
    }
    const preview = document.getElementById("preview-row");
    preview.hidden = false;
    document.getElementById("preview-thumb").src = meta.thumb;
    document.getElementById("preview-title").textContent = meta.title || "Видео";
    document.getElementById("preview-channel").textContent = meta.author;
    hint.textContent = meta.title
      ? "Данные подтянуты"
      : "Превью готово. Название можно вписать вручную.";
    hint.className = "hint is-ok";
  } catch (err) {
    hint.textContent = err.message || "Не удалось получить данные";
    hint.className = "hint is-err";
  } finally {
    btn.disabled = false;
    btn.textContent = "Подтянуть";
  }
}

function handleSaveLink(e) {
  e.preventDefault();
  const urlRaw = document.getElementById("link-url").value.trim();
  const videoId = parseYouTubeId(urlRaw);
  if (!videoId) {
    toast("Похоже, это не YouTube-ссылка");
    return;
  }

  const title = document.getElementById("link-title").value.trim();
  const note = document.getElementById("link-note").value.trim();
  const tags = parseTagsInput(document.getElementById("link-tags").value);
  const categoryId = document.getElementById("link-category").value;
  const pinned = document.getElementById("link-pinned").checked;
  const thumb = document.getElementById("preview-thumb").src || thumbUrl(videoId);
  const author = document.getElementById("preview-channel").textContent;

  const payload = {
    url: watchUrl(videoId),
    videoId,
    title: title || "Без названия",
    note,
    tags,
    categoryId: categoryId || null,
    color: state.selectedColor,
    pinned,
    thumb,
    author,
    updatedAt: nowIso(),
  };

  if (state.editingLinkId) {
    const idx = state.links.findIndex((l) => l.id === state.editingLinkId);
    if (idx >= 0) {
      state.links[idx] = normalizeLink({ ...state.links[idx], ...payload });
    }
    toast("Ссылка обновлена");
  } else {
    state.links.unshift(
      normalizeLink({
        id: uid(),
        createdAt: nowIso(),
        ...payload,
      })
    );
    toast("Ссылка сохранена");
  }

  saveState();
  closeModal("modal-link");
  render();
}

function handleSaveCategory(e) {
  e.preventDefault();
  const name = document.getElementById("cat-name").value.trim();
  if (!name) return;

  if (state.editingCategoryId) {
    const cat = state.categories.find((c) => c.id === state.editingCategoryId);
    if (cat) {
      cat.name = name;
      cat.color = state.selectedCatColor;
      // keep parent (subfolder stays inside its folder)
      if (state.editingCategoryParentId) cat.parentId = state.editingCategoryParentId;
    }
    toast("Папка обновлена");
  } else {
    state.categories.push({
      id: uid(),
      name,
      color: state.selectedCatColor,
      parentId: state.editingCategoryParentId || state.pendingParentFolderId || null,
    });
    toast("Папка создана");
  }

  saveState();
  closeModal("modal-category");
  render();
}

function togglePin(id) {
  const link = state.links.find((l) => l.id === id);
  if (!link) return;
  link.pinned = !link.pinned;
  link.updatedAt = nowIso();
  saveState();
  render();
  toast(link.pinned ? "Закреплено" : "Откреплено");
}

function deleteLink(id) {
  const link = state.links.find((l) => l.id === id);
  confirmAction(
    "Удалить ссылку?",
    link?.title ? `«${link.title}» будет удалена безвозвратно.` : "Ссылка будет удалена безвозвратно.",
    () => {
      state.links = state.links.filter((l) => l.id !== id);
      saveState();
      render();
      toast("Ссылка удалена");
    }
  );
}

function deleteCategory(id) {
  const cat = state.categories.find((c) => c.id === id);
  const kids = categoryChildren(id);
  const count = countLinksInCategory(id);
  confirmAction(
    "Удалить навсегда?",
    `«${cat?.name}» удалится на всех устройствах.${
      count || kids.length
        ? ` Вложенные папки тоже удалятся, ссылки останутся без папки (${count}).`
        : ""
    }`,
    () => {
      const parent = cat?.parentId || null;
      // tombstone the whole subtree
      const kill = categoryDescendantIds(id);
      for (const cid of kill) {
        if (!state.deletedCategoryIds.includes(cid)) {
          state.deletedCategoryIds.push(cid);
        }
      }
      state.categories = state.categories.filter((c) => !kill.has(c.id));
      state.links = state.links.map((l) =>
        l.categoryId && kill.has(l.categoryId) ? { ...l, categoryId: null } : l
      );
      if (state.filter.startsWith("category:")) {
        const fid = state.filter.slice("category:".length);
        if (kill.has(fid)) state.filter = "all";
      }
      saveState({ sync: false });
      render();
      toast("Направление удалено");
      if (isCloudReady()) {
        syncPush({ silent: true, skipStatus: true }).then(() => syncAll()).catch(() => {});
      }
    }
  );
}

function exportData() {
  const blob = new Blob(
    [JSON.stringify({ version: 1, links: state.links, categories: state.categories }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `youtube-keep-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Экспорт готов");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = parseJsonSafe(reader.result);
      if (!Array.isArray(data.links)) throw new Error("bad file");
      if (Array.isArray(data.categories) && data.categories.length) {
        state.categories = data.categories;
      }
      for (const link of data.links) {
        state.links.push(normalizeLink(link));
      }
      saveState();
      render();
      toast("Данные импортированы");
    } catch {
      toast("Не удалось прочитать файл");
    }
  };
  reader.readAsText(file);
}

/* ---------- bookmarks import ---------- */

function extractYouTubeEntriesFromText(text) {
  const items = [];
  const byId = new Map();

  const push = (videoId, title, url) => {
    if (!videoId) return;
    const prev = byId.get(videoId);
    if (prev) {
      if (!prev.title && title) prev.title = title;
      return;
    }
    const item = {
      url: url || watchUrl(videoId),
      videoId,
      title: title || "",
    };
    byId.set(videoId, item);
    items.push(item);
  };

  // JSON first (often carries titles)
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = parseJsonSafe(trimmed);
      const arr = Array.isArray(json) ? json : json.links || json.items || json.videos || [];
      for (const row of arr) {
        const url = row.url || row.href || row.link || row.videoId || "";
        const videoId = row.videoId || parseYouTubeId(url);
        push(videoId, row.title || row.name || row.text || "", url);
      }
    } catch {
      /* not json */
    }
  }

  // Netscape / browser bookmarks HTML
  const hrefRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = hrefRe.exec(text))) {
    const url = m[1];
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    push(parseYouTubeId(url), title, url);
  }

  // CSV rows with URL + title (Google Takeout / sheets)
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!/youtu/i.test(line)) continue;
    const cols = line
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((c) => c.replace(/^"|"$/g, "").trim());
    for (const col of cols) {
      const videoId = parseYouTubeId(col);
      if (!videoId) continue;
      const title = cols.find((c) => c && !parseYouTubeId(c) && !/^https?:/i.test(c)) || "";
      push(videoId, title, col);
    }
  }

  // Bare URL lines / pasted lists
  const urlRe = /https?:\/\/[^\s<>"']+/gi;
  const urlMatches = text.match(urlRe) || [];
  for (const raw of urlMatches) {
    const cleaned = raw.replace(/[),.;]+$/, "");
    const videoId = parseYouTubeId(cleaned);
    push(videoId, "", cleaned);
  }

  return items;
}

function updateImportPreview() {
  const preview = document.getElementById("import-preview");
  const countEl = document.getElementById("import-count");
  const listEl = document.getElementById("import-preview-list");
  const items = state.importItems;
  if (!items.length) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  countEl.textContent = String(items.length);
  listEl.innerHTML = items
    .slice(0, 12)
    .map((it) => `<li>${escapeHtml(it.title || it.url)}</li>`)
    .join("")
    .concat(items.length > 12 ? `<li>… и ещё ${items.length - 12}</li>` : "");
}

function openImportModal() {
  state.importItems = [];
  document.getElementById("import-paste").value = "";
  document.getElementById("import-file-info").textContent = "Файл не выбран";
  document.getElementById("import-preview").hidden = true;
  fillCategorySelect();
  document.getElementById("import-category").value = "";
  document.getElementById("import-tags").value = "";
  openModal("modal-import");
}

function handleImportFile(file) {
  const info = document.getElementById("import-file-info");
  info.textContent = `Читаю: ${file.name}`;
  const reader = new FileReader();
  reader.onload = () => {
    const items = extractYouTubeEntriesFromText(String(reader.result || ""));
    state.importItems = items;
    info.textContent = items.length
      ? `${file.name}: найдено ${items.length} YouTube-ссылок`
      : `${file.name}: YouTube-ссылки не найдены`;
    updateImportPreview();
  };
  reader.onerror = () => {
    info.textContent = "Не удалось прочитать файл";
  };
  reader.readAsText(file);
}

function collectImportItemsFromPaste() {
  const text = document.getElementById("import-paste").value.trim();
  if (!text) return;
  const items = extractYouTubeEntriesFromText(text);
  const existing = new Set(state.importItems.map((i) => i.videoId));
  for (const item of items) {
    if (!existing.has(item.videoId)) {
      existing.add(item.videoId);
      state.importItems.push(item);
    }
  }
  updateImportPreview();
}

function runBookmarksImport() {
  collectImportItemsFromPaste();
  const items = state.importItems;
  if (!items.length) {
    toast("Нечего импортировать — нет YouTube-ссылок");
    return;
  }

  const categoryId = document.getElementById("import-category").value || null;
  const defaultTags = parseTagsInput(document.getElementById("import-tags").value);
  const existingIds = new Set(state.links.map((l) => l.videoId).filter(Boolean));
  let added = 0;

  for (const item of items) {
    if (existingIds.has(item.videoId)) continue;
    existingIds.add(item.videoId);
    state.links.push(
      normalizeLink({
        id: uid(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        url: item.url,
        videoId: item.videoId,
        title: item.title || "Без названия",
        tags: defaultTags,
        categoryId,
        thumb: thumbUrl(item.videoId),
      })
    );
    added++;
  }

  saveState();
  render();
  closeModal("modal-import");
  toast(added ? `Импортировано: ${added}` : "Все ссылки уже были в библиотеке");
}

/* ---------- cloud sync (GitHub Gist) ---------- */

function renderSyncStatus() {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!dot || !label) return;

  dot.className = "sync-dot";
  if (state.sync.status === "ok") {
    dot.classList.add("is-ok");
    label.textContent = state.sync.lastSync
      ? `Синк ${new Date(state.sync.lastSync).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
      : "Синхронизировано";
  } else if (state.sync.status === "busy") {
    dot.classList.add("is-busy");
    label.textContent = "Синхронизация…";
  } else if (state.sync.status === "err") {
    dot.classList.add("is-err");
    label.textContent = "Ошибка синка";
  } else if (state.sync.token && state.sync.gistId) {
    label.textContent = "Облако подключено";
  } else {
    label.textContent = "Локально";
  }
}

function setSyncMessage(text, isError = false) {
  const el = document.getElementById("sync-message");
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "hint is-err" : text.includes("успешно") || text.includes("Готово") || text.includes("подключено") ? "hint is-ok" : "hint";
}

function explainGitHubError(err, status) {
  const msg = String(err?.message || err || "");
  if (status === 401 || /bad credentials|unauthorized/i.test(msg)) {
    return "Код доступа не принят. Получите новый код и вставьте без пробелов.";
  }
  if (status === 404) {
    return "Облако не найдено. Нажмите «Подключить» ещё раз — я создам его заново.";
  }
  if (status === 403 || /rate limit/i.test(msg)) {
    return "GitHub временно ограничил запросы. Подождите минуту и повторите.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Нет связи с GitHub. Проверьте интернет на Mac и повторите.";
  }
  return `Ошибка: ${msg || status || "неизвестно"}`;
}

function syncPayload() {
  return JSON.stringify(
    {
      version: 2,
      updatedAt: nowIso(),
      links: state.links,
      categories: state.categories,
      deletedCategoryIds: state.deletedCategoryIds || [],
    },
    null,
    2
  );
}

async function syncPush(opts = {}) {
  if (!state.sync.token) {
    setSyncMessage("Укажите GitHub token", true);
    openModal("modal-sync");
    return;
  }
  if (!opts.skipStatus) {
    state.sync.status = "busy";
    renderSyncStatus();
    setSyncMessage("Отправляю данные…");
  }

  try {
    const headers = {
      Authorization: `Bearer ${state.sync.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const body = JSON.stringify({
      description: "YouTube Keep sync",
      public: false,
      files: {
        "youtube-keep.json": { content: syncPayload() },
      },
    });

    let res;
    if (state.sync.gistId) {
      res = await fetch(`https://api.github.com/gists/${state.sync.gistId}`, {
        method: "PATCH",
        headers,
        body,
      });
      if (res.status === 404) {
        // recreate
        res = await fetch("https://api.github.com/gists", {
          method: "POST",
          headers,
          body: JSON.stringify({
            description: "YouTube Keep sync",
            public: false,
            files: { "youtube-keep.json": { content: syncPayload() } },
          }),
        });
      }
    } else {
      res = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers,
        body,
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.message || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    state.sync.gistId = data.id;
    state.sync.lastSync = nowIso();
    state.sync.status = "ok";
    state.sync.message = "Успешно отправлено в облако";
    saveSyncSettings();
    setSyncMessage(`Готово. Облако подключено (Gist ID: ${data.id}). Теперь откройте телефон.`);
    toast("Подключено. Код сохранён — больше не нужно вводить.");
    render();
    startCloudWatch();
    syncAll().catch(() => {});
  } catch (err) {
    state.sync.status = "err";
    if (!opts.silent) {
      setSyncMessage(explainGitHubError(err, err.status), true);
      toast("Не получилось подключиться");
    }
    throw err;
  } finally {
    if (!opts.skipStatus) renderSyncStatus();
  }
}

async function syncPull(opts = {}) {
  if (!state.sync.token || !(state.sync.gistId || appConfig.gistId)) {
    return;
  }
  if (!state.sync.gistId) state.sync.gistId = appConfig.gistId;
  if (!opts.skipStatus) {
    state.sync.status = "busy";
    renderSyncStatus();
    setSyncMessage("Загружаю данные…");
  }

  try {
    const res = await fetch(`https://api.github.com/gists/${state.sync.gistId}`, {
      headers: {
        Authorization: `Bearer ${state.sync.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.message || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const gist = await res.json();
    const file = gist.files?.["youtube-keep.json"] || Object.values(gist.files || {})[0];
    if (!file?.content) throw new Error("В облаке пока нет данных — сначала нажмите «Отправить» на главном устройстве.");

    const data = parseJsonSafe(file.content);
    if (!Array.isArray(data.links)) throw new Error("Некорректный формат данных");

    // merge: keep newer by updatedAt per id
    const map = new Map();
    for (const link of [...state.links, ...data.links]) {
      const norm = normalizeLink(link);
      const prev = map.get(norm.id);
      if (!prev || (norm.updatedAt || "") > (prev.updatedAt || "")) map.set(norm.id, norm);
    }
    state.links = [...map.values()];
    // Merge deletions first so removed folders stay removed
    const dead = new Set([
      ...(state.deletedCategoryIds || []),
      ...(Array.isArray(data.deletedCategoryIds) ? data.deletedCategoryIds : []),
    ]);
    state.deletedCategoryIds = [...dead];
    state.categories = state.categories.filter((c) => !dead.has(c.id));
    state.links = state.links.map((l) =>
      l.categoryId && dead.has(l.categoryId) ? { ...l, categoryId: null } : l
    );

    // Merge categories by NAME (not id) to avoid "Вдохновение" x2
    const catByName = new Map();
    const alias = new Map(); // oldId -> canonicalId
    const putCat = (cat) => {
      if (!cat?.name) return;
      if (dead.has(cat.id)) return;
      const key = `${cat.parentId || ""}::${String(cat.name).trim().toLowerCase()}`;
      const existing = catByName.get(key);
      if (!existing) {
        const id = cat.id || uid();
        catByName.set(key, {
          ...cat,
          id,
          name: String(cat.name).trim(),
          parentId: cat.parentId || null,
        });
        alias.set(cat.id, id);
      } else {
        alias.set(cat.id, existing.id);
      }
    };
    for (const cat of state.categories) putCat(cat);
    for (const cat of data.categories || []) {
      if (dead.has(cat.id)) continue;
      putCat(cat);
    }
    state.categories = [...catByName.values()];
    state.links = state.links.map((l) => ({
      ...l,
      categoryId: l.categoryId ? alias.get(l.categoryId) || l.categoryId : null,
    }));
    // drop links pointing at missing categories? keep them as null
    const validIds = new Set(state.categories.map((c) => c.id));
    state.links = state.links.map((l) =>
      l.categoryId && !validIds.has(l.categoryId) ? { ...l, categoryId: null } : l
    );

    // Notes & note folders merge
    {
      const deadF = new Set([
        ...(state.deletedNoteFolderIds || []),
        ...(data.deletedNoteFolderIds || []),
      ]);
      const deadN = new Set([
        ...(state.deletedNoteIds || []),
        ...(data.deletedNoteIds || []),
      ]);
      state.deletedNoteFolderIds = [...deadF];
      state.deletedNoteIds = [...deadN];

      const fmap = new Map();
      for (const f of [...(state.noteFolders || []), ...(data.noteFolders || [])]) {
        if (!f?.id || deadF.has(f.id)) continue;
        const prev = fmap.get(f.id);
        if (!prev || (f.updatedAt || "") >= (prev.updatedAt || "")) {
          fmap.set(f.id, {
            id: f.id,
            name: f.name || "Папка",
            parentId: f.parentId || null,
            color: f.color || "#c2410c",
            updatedAt: f.updatedAt || "",
          });
        }
      }
      state.noteFolders = [...fmap.values()];

      const nmap = new Map();
      for (const n of [...(state.notes || []), ...(data.notes || [])]) {
        if (!n?.id || deadN.has(n.id)) continue;
        const prev = nmap.get(n.id);
        if (!prev || (n.updatedAt || "") >= (prev.updatedAt || "")) {
          nmap.set(n.id, {
            id: n.id,
            folderId: n.folderId || null,
            title: n.title || "Заметка",
            text: n.text || "",
            updatedAt: n.updatedAt || "",
            createdAt: n.createdAt || "",
          });
        }
      }
      state.notes = [...nmap.values()];
    }

    saveState({ sync: false });
    state.sync.lastSync = nowIso();
    state.sync.status = "ok";
    saveSyncSettings();
    render();
    setSyncMessage(`Готово. Ссылок: ${state.links.length}`);
    if (!opts.silent) toast("Данные загружены из облака");
  } catch (err) {
    state.sync.status = "err";
    if (!opts.silent) {
      setSyncMessage(explainGitHubError(err, err.status), true);
      toast("Не удалось загрузить из облака");
    }
    throw err;
  } finally {
    if (!opts.skipStatus) renderSyncStatus();
  }
}

let autoSyncTimer = null;
let pullTimer = null;
let syncingNow = false;

function isCloudReady() {
  return !!(state.sync.token && (state.sync.gistId || appConfig.gistId));
}

function scheduleAutoSync() {
  if (!isCloudReady() || !state.sync.auto) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    syncAll().catch(() => {});
  }, 800);
}

/** Two-way: download remote, merge, then upload. */
async function syncAll() {
  if (!isCloudReady()) return;
  if (syncingNow) return;
  syncingNow = true;
  state.sync.status = "busy";
  renderSyncStatus();
  try {
    await syncPull({ silent: true, skipStatus: true });
    await syncPush({ silent: true, skipStatus: true });
    state.sync.status = "ok";
    setSyncMessage("Синхронизировано. Данные одинаковы на всех устройствах.");
  } catch (err) {
    state.sync.status = "err";
    setSyncMessage(explainGitHubError(err, err.status), true);
  } finally {
    syncingNow = false;
    renderSyncStatus();
    render();
  }
}

function startCloudWatch() {
  clearInterval(pullTimer);
  if (!isCloudReady()) return;
  pullTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      syncAll().catch(() => {});
    }
  }, 45000);
  if (!startCloudWatch._bound) {
    startCloudWatch._bound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && isCloudReady()) {
        syncAll().catch(() => {});
      }
    });
  }
}

function openSyncModal() {
  document.getElementById("sync-token").value = "";
  document.getElementById("sync-gist").value = state.sync.gistId || appConfig.gistId || "";
  document.getElementById("sync-auto").checked = state.sync.auto;
  const getCode = document.getElementById("btn-get-code");
  if (getCode && appConfig.tokenUrl) getCode.href = appConfig.tokenUrl;

  if (state.sync.token && state.sync.gistId) {
    setSyncMessage(
      state.sync.lastSync
        ? `Всё подключено. Последняя синхронизация: ${new Date(state.sync.lastSync).toLocaleString("ru-RU")}`
        : "Всё подключено. Данные синхронизируются автоматически."
    );
    fillDeviceLink();
  } else {
    setSyncMessage("Облако уже подготовлено. Нужно только получить код.");
  }
  openModal("modal-sync");
}

function parseJsonSafe(text) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "").trim();
  return JSON.parse(cleaned);
}

function extractGitHubToken(raw) {
  const text = String(raw || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  // find a token-like string even if user pasted extra words/quotes
  const m =
    text.match(/gh[pousr]_[A-Za-z0-9_]{20,}/) ||
    text.match(/github_pat_[A-Za-z0-9_]{20,}/);
  if (m) return m[0];
  const cleaned = text.replace(/[\s"'`]+/g, "");
  return cleaned || "";
}

/** One-click connect on another device: #t=token&g=gistId */
function applyHashCredentials() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = extractGitHubToken(params.get("t") || params.get("token") || "");
  const gistId = (params.get("g") || params.get("gist") || "").trim();
  if (!token && !gistId) return false;

  if (token) state.sync.token = token;
  if (gistId) state.sync.gistId = gistId;
  else if (!state.sync.gistId) state.sync.gistId = appConfig.gistId;
  state.sync.auto = true;
  saveSyncSettings();

  const clean = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", clean);
  render();
  startCloudWatch();
  syncAll().catch(() => {});
  toast("Устройство подключено к облаку");
  return true;
}

function deviceLink() {
  const token = state.sync.token;
  const gist = state.sync.gistId || appConfig.gistId;
  if (!token) return "";
  const base = window.location.origin + window.location.pathname;
  return base + "#t=" + encodeURIComponent(token) + "&g=" + encodeURIComponent(gist || "");
}

function fillDeviceLink() {
  const input = document.getElementById("device-link");
  const box = document.getElementById("device-link-box");
  if (!input || !box) return;
  const link = deviceLink();
  if (!link) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  input.value = link;
}

async function copyDeviceLink() {
  const link = deviceLink();
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast("Ссылка скопирована. Откройте её на Mac и телефоне.");
  } catch {
    const input = document.getElementById("device-link");
    if (input) {
      input.focus();
      input.select();
    }
    toast("Скопируйте ссылку вручную (Ctrl/Cmd+C)");
  }
}

async function connectCloud() {
  const raw = document.getElementById("sync-token").value;
  const token = extractGitHubToken(raw);
  if (!token) {
    setSyncMessage("Вставьте код доступа целиком (он длинный, начинается на ghp_).", true);
    return;
  }
  if (!/^gh[pousr]_[A-Za-z0-9_]+$/.test(token) && !/^github_pat_[A-Za-z0-9_]+$/.test(token)) {
    setSyncMessage(
      `В поле нет нормального кода GitHub. Нужен текст вида ghp_… (сейчас вижу «${String(raw).slice(0, 24)}…»). Скопируйте только код.`,
      true
    );
    return;
  }
  state.sync.token = token;
  if (!state.sync.gistId) state.sync.gistId = appConfig.gistId;
  state.sync.auto = true;
  saveSyncSettings();
  renderSyncStatus();
  fillDeviceLink();
  setSyncMessage("Проверяю связь с облаком…");
  await syncPush();
  fillDeviceLink();
}

function handleSaveSync(e) {
  e.preventDefault();
  state.sync.token = document.getElementById("sync-token").value.trim();
  state.sync.gistId = document.getElementById("sync-gist").value.trim();
  state.sync.auto = document.getElementById("sync-auto").checked;
  saveSyncSettings();
  renderSyncStatus();
  toast("Настройки синхронизации сохранены");
  if (state.sync.token && state.sync.gistId) {
    setSyncMessage("Настройки сохранены. Можно синхронизировать.");
  }
}

/* ---------- events ---------- */

function bindEvents() {
  // filters
  document.getElementById("nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    render();
  });

  document.getElementById("breadcrumbs")?.addEventListener("click", (e) => {
    const crumb = e.target.closest("[data-goto-folder]");
    if (!crumb) return;
    const id = crumb.dataset.gotoFolder || "";
    state.filter = id ? `category:${id}` : "all";
    render();
  });

  document.getElementById("folder-strip")?.addEventListener("click", (e) => {
    const addSub = e.target.closest("[data-add-sub]");
    const edit = e.target.closest("[data-edit-cat]");
    const del = e.target.closest("[data-del-cat]");
    const open = e.target.closest("[data-open-folder]");
    if (addSub) {
      e.preventDefault();
      e.stopPropagation();
      openCategoryModal(null, addSub.getAttribute("data-add-sub"));
      return;
    }
    if (edit) {
      e.preventDefault();
      e.stopPropagation();
      const cat = state.categories.find((c) => c.id === edit.dataset.editCat);
      if (cat) openCategoryModal(cat);
      return;
    }
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteCategory(del.getAttribute("data-del-cat"));
      return;
    }
    if (open) {
      state.filter = `category:${open.dataset.openFolder}`;
      render();
    }
  });

  document.getElementById("category-list").addEventListener("click", (e) => {
    const addSub = e.target.closest("[data-add-sub]");
    const edit = e.target.closest("[data-edit-cat]");
    const del = e.target.closest("[data-del-cat]");
    if (addSub) {
      e.preventDefault();
      e.stopPropagation();
      openCategoryModal(null, addSub.getAttribute("data-add-sub"));
      return;
    }
    if (edit) {
      e.preventDefault();
      e.stopPropagation();
      const cat = state.categories.find((c) => c.id === edit.dataset.editCat);
      if (cat) openCategoryModal(cat);
      return;
    }
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteCategory(del.dataset.delCat);
      return;
    }
    const item = e.target.closest("[data-category-id]");
    if (!item) return;
    const id = item.dataset.categoryId;
    state.filter = `category:${id}`;
    render();
    closeSidebar();
  });

  // search / sort
  document.getElementById("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    renderGrid();
  });
  document.getElementById("sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderGrid();
  });

  // add
  document.getElementById("btn-add").addEventListener("click", () => openLinkModal());
  document.getElementById("btn-empty-add").addEventListener("click", () => openLinkModal());
  document.getElementById("btn-add-category").addEventListener("click", () => openCategoryModal());

  // form
  document.getElementById("form-link").addEventListener("submit", handleSaveLink);
  document.getElementById("form-category").addEventListener("submit", handleSaveCategory);
  document.getElementById("btn-fetch").addEventListener("click", handleFetchMeta);

  // auto-fetch on paste/blur of URL
  document.getElementById("link-url").addEventListener("change", () => {
    const v = document.getElementById("link-url").value;
    if (parseYouTubeId(v) && !document.getElementById("link-title").value) {
      handleFetchMeta();
    }
  });

  // grid actions (notes fold + card actions)
  document.getElementById("grid").addEventListener("click", (e) => {
    const foldHead = e.target.closest("[data-note]");
    const saveBtn = e.target.closest("[data-note-save]");
    const clearBtn = e.target.closest("[data-note-clear]");
    if (saveBtn) {
      e.preventDefault();
      const id = saveBtn.getAttribute("data-note-save");
      const fold = saveBtn.closest("[data-note-fold]");
      const ta = fold?.querySelector(".note-fold-input");
      const link = state.links.find((l) => l.id === id);
      if (link && ta) {
        link.note = ta.value.trim();
        link.updatedAt = nowIso();
        saveState();
        render();
        toast(link.note ? "Заметка сохранена" : "Заметка пустая");
      }
      return;
    }
    if (clearBtn) {
      e.preventDefault();
      const id = clearBtn.getAttribute("data-note-clear");
      const link = state.links.find((l) => l.id === id);
      if (link) {
        link.note = "";
        link.updatedAt = nowIso();
        saveState();
        render();
        toast("Заметка очищена");
      }
      return;
    }
    if (foldHead) {
      e.preventDefault();
      const fold = foldHead.closest("[data-note-fold]");
      const body = fold?.querySelector(".note-fold-body");
      const open = body && !body.hidden;
      document.querySelectorAll(".note-fold.is-open").forEach((el) => {
        el.classList.remove("is-open");
        const b = el.querySelector(".note-fold-body");
        const h = el.querySelector(".note-fold-head");
        if (b) b.hidden = true;
        if (h) h.setAttribute("aria-expanded", "false");
      });
      if (body && !open) {
        fold.classList.add("is-open");
        body.hidden = false;
        foldHead.setAttribute("aria-expanded", "true");
        body.querySelector(".note-fold-input")?.focus();
      }
      return;
    }

    const pin = e.target.closest("[data-pin]");
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-delete]");
    if (pin) togglePin(pin.dataset.pin);
    else if (edit) {
      const link = state.links.find((l) => l.id === edit.dataset.edit);
      if (link) openLinkModal(link);
    } else if (del) deleteLink(del.dataset.delete);
  });

  // modals close
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.close));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal").forEach((m) => {
        if (!m.hidden) closeModal(m.id);
      });
      closeSidebar();
    }
  });

  // confirm
  document.getElementById("confirm-ok").addEventListener("click", () => {
    const fn = state.pendingConfirm;
    state.pendingConfirm = null;
    closeModal("modal-confirm");
    if (fn) fn();
  });

  // tags filter
  document.getElementById("notes-list")?.addEventListener("click", (e) => {
    const add = e.target.closest("[data-note-folder-add]");
    const edit = e.target.closest("[data-note-folder-edit]");
    const open = e.target.closest("[data-note-folder]");
    if (add) {
      e.preventDefault();
      openNoteFolderModal(null, add.getAttribute("data-note-folder-add") || null);
      return;
    }
    if (edit) {
      e.preventDefault();
      openNoteFolderModal(edit.getAttribute("data-note-folder-edit"));
      return;
    }
    if (open) {
      state.filter = `notes:${open.getAttribute("data-note-folder")}`;
      render();
      closeSidebar();
    }
  });

  document.getElementById("nav-notes")?.addEventListener("click", () => {
    state.filter = "notes:all";
    render();
    closeSidebar();
  });

  // notes main area
  document.getElementById("folder-hero")?.addEventListener("click", (e) => {
    const addNote = e.target.closest("[data-note-add]");
    const addFolder = e.target.closest("[data-note-folder-add]");
    const editFolder = e.target.closest("[data-note-folder-edit]");
    if (addNote) {
      e.preventDefault();
      openNoteStoreModal(null, addNote.getAttribute("data-note-add") || null);
      return;
    }
    if (addFolder) {
      e.preventDefault();
      openNoteFolderModal(null, addFolder.getAttribute("data-note-folder-add") || null);
      return;
    }
    if (editFolder) {
      e.preventDefault();
      openNoteFolderModal(editFolder.getAttribute("data-note-folder-edit"));
    }
  });

  document.getElementById("folder-strip")?.addEventListener("click", (e) => {
    const add = e.target.closest("[data-note-folder-add]");
    const edit = e.target.closest("[data-note-folder-edit]");
    const del = e.target.closest("[data-note-folder-del]");
    const open = e.target.closest("[data-note-folder]");
    if (add) {
      e.preventDefault();
      e.stopPropagation();
      openNoteFolderModal(null, add.getAttribute("data-note-folder-add") || null);
      return;
    }
    if (edit) {
      e.preventDefault();
      e.stopPropagation();
      openNoteFolderModal(edit.getAttribute("data-note-folder-edit"));
      return;
    }
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      openNoteFolderModal(del.getAttribute("data-note-folder-del"));
      return;
    }
    if (open) {
      state.filter = `notes:${open.getAttribute("data-note-folder")}`;
      render();
    }
  });

  document.getElementById("breadcrumbs")?.addEventListener("click", (e) => {
    const goto = e.target.closest("[data-note-goto]");
    if (goto) {
      const id = goto.getAttribute("data-note-goto");
      state.filter = id ? `notes:${id}` : "notes:all";
      render();
    }
  });

  document.getElementById("grid")?.addEventListener("click", (e) => {
    const open = e.target.closest("[data-note-open]");
    const del = e.target.closest("[data-note-del]");
    const addNote = e.target.closest("[data-note-add]");
    if (addNote && state.filter.startsWith("notes:")) {
      e.preventDefault();
      openNoteStoreModal(null, addNote.getAttribute("data-note-add") || null);
      return;
    }
    if (open) {
      e.preventDefault();
      openNoteStoreModal(open.getAttribute("data-note-open"));
      return;
    }
    if (del && state.filter.startsWith("notes:")) {
      e.preventDefault();
      const id = del.getAttribute("data-note-del");
      state.deletedNoteIds.push(id);
      state.notes = state.notes.filter((n) => n.id !== id);
      saveState();
      render();
      toast("Заметка удалена");
    }
  });

  document.getElementById("tag-list").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (!chip) return;
    const tag = chip.dataset.tag;
    if (state.activeTags.has(tag)) state.activeTags.delete(tag);
    else state.activeTags.add(tag);
    render();
  });

  document.getElementById("btn-clear-tags").addEventListener("click", () => {
    state.activeTags.clear();
    render();
  });

  // tag chips on cards
  document.getElementById("grid").addEventListener("click", (e) => {
    const tagChip = e.target.closest(".tag-chip-card[data-tag]");
    if (tagChip) {
      const tag = tagChip.dataset.tag;
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      render();
    }
  });

  // tag suggestions in form
  document.getElementById("tag-suggestions").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-suggest-tag]");
    if (!btn) return;
    const input = document.getElementById("link-tags");
    const current = parseTagsInput(input.value);
    const tag = btn.dataset.suggestTag;
    if (!current.some((t) => t.toLowerCase() === tag)) {
      current.push(tag);
      input.value = current.join(", ");
    }
    renderTagSuggestions();
  });

  document.getElementById("link-tags").addEventListener("input", renderTagSuggestions);

  // export / import
  document.getElementById("btn-export").addEventListener("click", exportData);
  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importData(file);
    e.target.value = "";
  });

  // bookmarks import
  document.getElementById("btn-import-bookmarks").addEventListener("click", openImportModal);
  document.getElementById("bookmarks-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
  });

  const drop = document.getElementById("file-drop");
  if (drop) {
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) handleImportFile(file);
    });
  }

  document.getElementById("import-paste").addEventListener("change", collectImportItemsFromPaste);
  document.getElementById("btn-run-import").addEventListener("click", runBookmarksImport);

  // sync
  document.getElementById("btn-sync-settings").addEventListener("click", openSyncModal);
  document.getElementById("form-sync").addEventListener("submit", handleSaveSync);
  document.getElementById("btn-sync-push").addEventListener("click", () => syncPush());
  document.getElementById("btn-sync-pull").addEventListener("click", () => syncPull());
  document.getElementById("btn-connect-cloud").addEventListener("click", () => connectCloud());
  document.getElementById("btn-open-setup").addEventListener("click", openSyncModal);
  document.getElementById("btn-save-note")?.addEventListener("click", saveNoteFromModal);
  document.getElementById("btn-delete-note")?.addEventListener("click", () => {
    const link = state.links.find((l) => l.id === state.editingLinkId);
    if (link) {
      link.note = "";
      link.updatedAt = nowIso();
      saveState();
      render();
    }
    closeModal("modal-note");
    toast("Заметка удалена");
  });
  document.getElementById("btn-dismiss-setup")?.addEventListener("click", () => {
    localStorage.setItem("youtube-keep:setup-dismissed", "1");
    render();
    toast("Подсказка скрыта. Код можно добавить позже через шестерёнку.");
  });
  document.getElementById("btn-sync-now").addEventListener("click", () => syncAll());
  document.getElementById("btn-copy-device-link")?.addEventListener("click", () => copyDeviceLink());
  document.getElementById("btn-add-note-folder")?.addEventListener("click", () => openNoteFolderModal(null, currentNotesFolderId()));

  document.getElementById("form-note-store")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("note-store-name").value.trim() || "Заметка";
    const text = document.getElementById("note-store-text").value;
    const folderId = state.editingNoteFolderParentId || null;
    if (state.editingNoteId) {
      const n = state.notes.find((x) => x.id === state.editingNoteId);
      if (n) {
        n.title = title;
        n.text = text;
        n.folderId = folderId;
        n.updatedAt = nowIso();
      }
      toast("Заметка обновлена");
    } else {
      state.notes.unshift({
        id: uid(),
        folderId,
        title,
        text,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      toast("Заметка создана");
    }
    saveState();
    closeModal("modal-note-store");
    render();
  });

  document.getElementById("btn-note-store-delete")?.addEventListener("click", () => {
    if (!state.editingNoteId) return;
    state.deletedNoteIds.push(state.editingNoteId);
    state.notes = state.notes.filter((n) => n.id !== state.editingNoteId);
    saveState();
    closeModal("modal-note-store");
    render();
    toast("Заметка удалена");
  });

  document.getElementById("form-note-folder")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("note-folder-name").value.trim();
    if (!name) return;
    if (state.editingNoteFolderId) {
      const f = state.noteFolders.find((x) => x.id === state.editingNoteFolderId);
      if (f) {
        f.name = name;
        f.updatedAt = nowIso();
      }
      toast("Папка обновлена");
    } else {
      state.noteFolders.push({
        id: uid(),
        name,
        parentId: state.editingNoteFolderParentId || null,
        color: "#c2410c",
        updatedAt: nowIso(),
      });
      toast("Папка создана");
    }
    saveState();
    closeModal("modal-note-folder");
    render();
  });

  document.getElementById("btn-note-folder-delete")?.addEventListener("click", () => {
    const id = state.editingNoteFolderId;
    if (!id) return;
    const kill = noteFolderDescendantIds(id);
    for (const fid of kill) {
      if (fid && !state.deletedNoteFolderIds.includes(fid)) {
        state.deletedNoteFolderIds.push(fid);
      }
    }
    for (const n of state.notes || []) {
      if (n.folderId && kill.has(n.folderId) && !state.deletedNoteIds.includes(n.id)) {
        state.deletedNoteIds.push(n.id);
      }
    }
    state.noteFolders = (state.noteFolders || []).filter((f) => !kill.has(f.id));
    state.notes = (state.notes || []).filter((n) => !(n.folderId && kill.has(n.folderId)));
    if (state.filter.startsWith("notes:")) {
      const fid = state.filter.slice("notes:".length);
      if (kill.has(fid)) state.filter = "notes:all";
    }
    saveState();
    closeModal("modal-note-folder");
    render();
    toast("Папка заметок удалена");
  });

  document.getElementById("folder-hero")?.addEventListener("click", (e) => {
    const addSub = e.target.closest("[data-add-sub]");
    const edit = e.target.closest("[data-edit-cat]");
    if (addSub) {
      e.preventDefault();
      openCategoryModal(null, addSub.getAttribute("data-add-sub"));
      return;
    }
    if (edit) {
      e.preventDefault();
      const cat = state.categories.find((c) => c.id === edit.dataset.editCat);
      if (cat) openCategoryModal(cat);
    }
  });

  // mobile sidebar
  document.getElementById("btn-menu").addEventListener("click", openSidebar);
  document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);
}

function openSidebar() {
  document.getElementById("sidebar").classList.add("is-open");
  document.getElementById("sidebar-backdrop").hidden = false;
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("is-open");
  document.getElementById("sidebar-backdrop").hidden = true;
}

/* ---------- init ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

loadState();
bindEvents();
render();
loadAppConfig().then(() => applyHashCredentials());
