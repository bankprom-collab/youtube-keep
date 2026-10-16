/* YouTube Keep — app logic */

const APP_BUILD = "2026.10.08.67";
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
  deletedVoiceIds: [],
  editingNoteId: null,
  editingNoteFolderId: null,
  editingNoteFolderParentId: null,
  notesOpen: true,
  expandedNoteFolders: new Set(),
  notesTreeOpen: false,
  expandedNoteIds: new Set(),
  notesCompact: true,
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

function mergeLinkPair(a, b) {
  // Prefer the record with the newer updatedAt, but keep the richer note/tags.
  const base =
    (a.updatedAt || "") >= (b.updatedAt || "") ? { ...a } : { ...b };
  const other = base === a ? b : a;
  if (!base.note && other.note) base.note = other.note;
  if (!base.title || base.title === "Без названия") {
    if (other.title && other.title !== "Без названия") base.title = other.title;
  }
  if (!(base.tags || []).length && (other.tags || []).length) {
    base.tags = other.tags;
  } else if ((other.tags || []).length) {
    const set = new Set([...(base.tags || []), ...other.tags]);
    base.tags = [...set];
  }
  if (!base.thumb && other.thumb) base.thumb = other.thumb;
  if (!base.categoryId && other.categoryId) base.categoryId = other.categoryId;
  if (other.pinned) base.pinned = true;
  return base;
}

function normalizeLink(link) {
  return {
    id: link.id || uid(),
    createdAt: link.createdAt || nowIso(),
    updatedAt: link.updatedAt || nowIso(),
    url: link.url || "",
    videoId: link.videoId || parseYouTubeId(link.url),
    title: link.title || "Без названия",
    note: String(
      link.note ??
        link.text ??
        link.comment ??
        link.description ??
        (Array.isArray(link.notes) ? link.notes.map((n) => n.text || n.body || n).join("\n") : "") ??
        ""
    ),
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

    // recover standalone notes from older shapes
    if (!state.notes.length) {
      const legacyNotes = data.linkNotes || data.comments || data.legacyNotes || [];
      if (Array.isArray(legacyNotes)) {
        for (const n of legacyNotes) {
          if (!n) continue;
          state.notes.push({
            id: n.id || uid(),
            folderId: n.folderId || n.categoryId || null,
            title: n.title || n.name || "Заметка",
            text: String(n.text || n.body || n.note || ""),
            createdAt: n.createdAt || nowIso(),
            updatedAt: n.updatedAt || nowIso(),
          });
        }
      }
    }

    // if a link used to hold only a note (no title), lift it into Notes
    for (const l of state.links) {
      if (l.note && !l.url && !l.videoId) {
        state.notes.unshift({
          id: l.id || uid(),
          folderId: null,
          title: l.title || "Заметка",
          text: l.note,
          createdAt: l.createdAt || nowIso(),
          updatedAt: l.updatedAt || nowIso(),
        });
        l.note = "";
      }
    }
    state.deletedNoteFolderIds = Array.isArray(data.deletedNoteFolderIds)
      ? data.deletedNoteFolderIds
      : [];
    state.deletedNoteIds = Array.isArray(data.deletedNoteIds) ? data.deletedNoteIds : [];
    state.deletedVoiceIds = Array.isArray(data.deletedVoiceIds) ? data.deletedVoiceIds : [];
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
  try {
    const notesLite = (state.notes || []).map(function (n) {
      const c = {
        id: n.id,
        folderId: n.folderId || null,
        title: n.title || "",
        text: n.text || "",
        color: n.color || "default",
        pinned: !!n.pinned,
        createdAt: n.createdAt || "",
        updatedAt: n.updatedAt || "",
        voices: noteVoices(n).map(function (v) {
          return {
            id: v.id,
            ref: v.ref || v.id,
            name: v.name || "",
            at: v.at || "",
            mime: v.mime || "",
            data: "",
          };
        }),
      };
      return c;
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        links: state.links,
        categories: state.categories,
        deletedCategoryIds: state.deletedCategoryIds || [],
        noteFolders: state.noteFolders || [],
        notes: notesLite,
        deletedNoteFolderIds: state.deletedNoteFolderIds || [],
        deletedNoteIds: state.deletedNoteIds || [],
      })
    );
  } catch (e) {
    if (/quota/i.test(String(e && e.name) + String(e))) {
      toast("Место в браузере закончилось — удалите старые аудио");
    }
  }
  if (options.sync !== false) scheduleAutoSync();
}

const appConfig = {
  gistId: "",
  token: "",
  autoSync: true,
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


async function hydrateKeepCards() {
  const items = (state.notes || []).filter(function (n) {
    return state.filter === "notes:all" || state.filter === "notes:" + (n.folderId || "") || String(state.filter).startsWith("notes:");
  });
  for (const n of items) {
    await refreshVoiceCache(n.id);
  }
  // re-render only cards audio src if needed — simplest: render again once
  renderNotesView();
}

function render() {
  const buildEl = document.getElementById("build-label");
  if (buildEl) buildEl.textContent = `Сборка ${APP_BUILD}`;
  renderCategories();
  renderTags();
  renderGrid();
  fillCategorySelect();
  renderSyncStatus();
  renderSyncBanner();
  const setup = document.getElementById("setup-banner");
  const sync = document.getElementById("sync-banner");
  const ready = isCloudReady() || !!(appConfig && appConfig.token && (state.sync.gistId || appConfig.gistId));
  if (ready && state.sync.token !== appConfig.token && appConfig.token) {
    state.sync.token = appConfig.token;
    if (appConfig.gistId) state.sync.gistId = appConfig.gistId;
  }
  if (setup) {
    if (ready) setup.setAttribute("hidden", "");
    else setup.removeAttribute("hidden");
  }
  if (sync) {
    if (ready) sync.removeAttribute("hidden");
    else sync.setAttribute("hidden", "");
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
  // All notes view: show everything (including notes inside folders)
  if (!folderId) return (state.notes || []).slice();
  return (state.notes || []).filter((n) => (n.folderId || null) === folderId);
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

function noteFolderRows(parentId, depth = 0) {
  const kids = noteFolderChildren(parentId).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );
  const rows = [];
  for (const f of kids) {
    const childFolders = noteFolderChildren(f.id);
    const expanded = state.expandedNoteFolders.has(f.id);
    rows.push({ f, depth, expanded, hasKids: childFolders.length > 0 });
    if (expanded && childFolders.length) {
      rows.push(...noteFolderRows(f.id, depth + 1));
    }
  }
  return rows;
}

function renderNotesSidebar() {
  const list = document.getElementById("notes-list");
  const countEl = document.getElementById("count-notes");
  if (countEl) countEl.textContent = String((state.notes || []).length);
  if (!list) return;

  const allActive = state.filter === "notes:all";
  const open = !!state.notesTreeOpen;

  // Single collapsed row: «Все заметки». Everything else hides inside.
  const head = `
    <div class="notes-head ${allActive ? "is-active" : ""}">
      <button type="button" class="notes-head-toggle ${open ? "is-open" : ""}" data-notes-tree aria-expanded="${open}" title="Развернуть / свернуть">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <button class="dir-btn notes-head-label" data-note-folder="" type="button">
        <span class="dir-gear" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M5 4h11l3 3v13H5V4z"/><path d="M8 10h8M8 14h6"/>
          </svg>
        </span>
        <span class="dir-name">Все заметки</span>
        <span class="dir-counts"><span class="dir-num">${(state.notes || []).length}</span></span>
      </button>
      <button type="button" class="notes-add-folder" data-note-folder-add="" title="Новая папка">+ папка</button>
    </div>`;

  if (!open) {
    list.innerHTML = head;
    return;
  }

  const rows = noteFolderRows(null, 0);
  const body = rows
    .map(({ f, depth, expanded, hasKids }) => {
      const active = state.filter === `notes:${f.id}`;
      const chevron = hasKids
        ? `<button type="button" class="dir-toggle ${expanded ? "is-open" : ""}" data-note-toggle="${f.id}" aria-label="Развернуть">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
           </button>`
        : `<span class="dir-toggle is-spacer" aria-hidden="true"></span>`;
      return `
      <div class="dir-row ${active ? "is-active" : ""}" style="padding-left:${depth * 14}px">
        ${chevron}
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

  list.innerHTML = head + body;
}

function keepColorHex(id) {
  const map = {
    default: "#fffef7",
    white: "#fffef7",
    orange: "#fff3e0",
    red: "#fce4ec",
    yellow: "#fff8b3",
    blue: "#e8f0fe",
    green: "#e8f5e9",
    purple: "#f3e8ff",
    teal: "#e0f7fa",
    gray: "#f4f4f4",
  };
  return map[id] || map.default;
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
    ? "Папки и заметки"
    : "Как в Google Keep — карточки, цвета, текст";
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

  // Keep-style compose bar
  if (hero) {
    hero.hidden = false;
    hero.innerHTML = `
      <button type="button" class="keep-compose" data-note-add="${folderId || ""}">
        <span class="keep-compose-hint">Заметка…</span>
        <span class="keep-compose-plus">+</span>
      </button>`;
  }

  // label/folder chips (optional, not a hard tree)
  const kids = noteFolderChildren(folderId).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "ru")
  );
  if (strip) {
    if (!kids.length) strip.innerHTML = "";
    else {
      strip.innerHTML =
        `<div class="folder-strip-label">Папки</div>
         <div class="keep-labels">
          ${kids
            .map(
              (f) => `
            <button type="button" class="keep-label ${state.filter === `notes:${f.id}` ? "is-active" : ""}" data-note-folder="${f.id}">
              ${escapeHtml(f.name)}
              <span class="keep-label-count">${notesInFolder(f.id).length}</span>
            </button>`
            )
            .join("")}
           <button type="button" class="keep-label keep-label-add" data-note-folder-add="${folderId || ""}">+ папка</button>
         </div>`;
    }
  }

  let list = notesInFolder(folderId)
    .slice()
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });

  if (!list.length && !kids.length) {
    if (grid) grid.innerHTML = "";
    if (empty) {
      empty.hidden = true;
    }
    return;
  }
  if (empty) empty.hidden = true;

  if (grid) {
    grid.className = "keep-masonry";
    grid.innerHTML = list
      .map((n) => {
        const bg = keepColorHex(n.color);
        const labelName = n.folderId
          ? (state.noteFolders || []).find((f) => f.id === n.folderId)?.name
          : "";
        const expanded = state.expandedNoteIds.has(n.id);
        const voiceCount = noteVoices(n).length;
        const preview = String(n.text || "").replace(/\s+/g, " ").slice(0, 100);
        return `
        <article class="keep-card ${expanded ? "is-open" : "is-closed"}" style="background:${bg}" data-note-id="${n.id}" draggable="true">
          <div class="keep-card-head" data-note-toggle="${n.id}">
            <span class="keep-chevron ${expanded ? "is-open" : ""}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
            </span>
            <span class="keep-line-title">${escapeHtml(n.title || "Заметка")}</span>
            ${voiceCount ? `<span class="keep-line-badge">${voiceCount} г</span>` : ""}
          </div>
          ${
            !expanded && preview
              ? `<div class="keep-line-preview" data-note-toggle="${n.id}">${escapeHtml(preview)}${
                  String(n.text || "").length > 100 ? "…" : ""
                }</div>`
              : ""
          }
          ${
            expanded
              ? `<div class="keep-card-body">
                   <div class="keep-card-text">${escapeHtml(n.text || "")}</div>
                   ${
                     noteVoices(n).length
                       ? `<div class="keep-card-voice">
                            <div class="voice-player-label">Голосовые (${noteVoices(n).length})</div>
                            ${noteVoices(n)
                              .map(
                                (v, i) =>
                                  `<div class="voice-row-title">${escapeHtml(voiceLabel(v, i))}</div>
                                   <audio controls class="voice-audio voice-audio-mini" src="${v.data}"></audio>`
                              )
                              .join("")}
                          </div>`
                       : ""
                   }
                   ${
                     labelName
                       ? `<div class="keep-card-label">${escapeHtml(labelName)}</div>`
                       : ""
                   }
                 </div>`
              : ""
          }
          <div class="keep-card-foot">
            <button type="button" class="keep-edit-btn" data-note-edit="${n.id}">Редактировать</button>
            <div class="keep-card-tools">
              <button type="button" class="keep-tool" data-note-pin="${n.id}" title="Закрепить" aria-label="Закрепить">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="${n.pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.2 6.4H21l-5.3 3.9 2 6.4L12 16.8 6.3 19.7l2-6.4L3 9.4h6.8L12 3z"/></svg>
              </button>
              <button type="button" class="keep-tool" data-note-del="${n.id}" title="Удалить" aria-label="Удалить">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
              </button>
            </div>
          </div>
        </article>`;
      })
      .join("");
    }
}

const KEEP_SWATCHES = [
  { id: "default", bg: "#fffef7" },
  { id: "orange", bg: "#fff3e0" },
  { id: "red", bg: "#fce4ec" },
  { id: "yellow", bg: "#fff8b3" },
  { id: "blue", bg: "#e8f0fe" },
  { id: "green", bg: "#e8f5e9" },
  { id: "purple", bg: "#f3e8ff" },
  { id: "teal", bg: "#e0f7fa" },
];


/* ===== Voice notes (IndexedDB storage) ===== */
function idbOpen() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open("youtube-keep-voice", 1);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains("voice")) {
        db.createObjectStore("voice", { keyPath: "id" });
      }
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

async function idbPut(id, dataUrl, meta) {
  const db = await idbOpen();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction("voice", "readwrite");
    tx.objectStore("voice").put(
      Object.assign({ id: id, data: dataUrl }, meta || {})
    );
    tx.oncomplete = function () {
      resolve(id);
    };
    tx.onerror = function () {
      reject(tx.error);
    };
  });
}

async function idbGet(id) {
  const db = await idbOpen();
  return new Promise(function (resolve) {
    const tx = db.transaction("voice", "readonly");
    const req = tx.objectStore("voice").get(id);
    req.onsuccess = function () {
      resolve(req.result || null);
    };
    req.onerror = function () {
      resolve(null);
    };
  });
}

async function hydrateVoices(note) {
  if (!note) return [];
  const list = Array.isArray(note.voices) ? note.voices : note.voice ? [note.voice] : [];
  const out = [];
  for (const v of list) {
    if (!v) continue;
    if (v.data) {
      out.push(v);
    } else if (v.ref || v.id) {
      const rec = await idbGet(v.ref || v.id);
      if (rec && rec.data) {
        out.push(Object.assign({}, v, { data: rec.data }));
      }
    }
  }
  return out;
}

const voiceCache = {}; /* noteId -> hydrated list */

async function hydrateAllVoices() {
  for (const n of state.notes || []) {
    try {
      await refreshVoiceCache(n.id);
    } catch (_) {}
  }
}

async function refreshVoiceCache(noteId) {
  const n = (state.notes || []).find(function (x) {
    return x.id === noteId;
  });
  if (!n) {
    if (!voiceCache[noteId]) voiceCache[noteId] = [];
    return voiceCache[noteId];
  }
  const memory = noteVoices(n).filter(function (v) {
    return v && v.data;
  });
  if (memory.length) {
    voiceCache[noteId] = memory;
    n.voices = memory;
    return memory;
  }
  const list = await hydrateVoices(n);
  const filled = list.filter(function (v) {
    return v && v.data;
  });
  if (filled.length) {
    voiceCache[noteId] = filled;
    n.voices = filled;
  } else if (!voiceCache[noteId]) {
    voiceCache[noteId] = [];
  }
  return voiceCache[noteId] || filled;
}


const voiceState = {
  recorder: null,
  chunks: [],
  noteId: null,
  recording: false,
  startedAt: 0,
  timer: null,
  prevVolumes: [],
};

function muteAllAudio(mute) {
  try {
    document.querySelectorAll("audio, video").forEach(function (el) {
      if (mute) {
        el.dataset.prevMuted = el.muted ? "1" : "0";
        el.muted = true;
        el.pause();
      } else {
        if (el.dataset.prevMuted === "0") el.muted = false;
      }
    });
    if (window.__ytkAudio) {
      if (mute) window.__ytkAudio.pause();
      window.__ytkAudio.muted = !!mute;
    }
  } catch (_) {}
}

function stopAllPlayback() {
  try {
    document.querySelectorAll("audio, video").forEach(function (a) {
      a.pause();
      try {
        a.currentTime = 0;
      } catch (_) {}
    });
    if (window.__ytkAudio) window.__ytkAudio.pause();
  } catch (_) {}
}

function noteVoices(note) {
  if (!note) return [];
  const cached = voiceCache[note.id];
  if (cached && cached.length) return cached;
  if (Array.isArray(note.voices)) {
    return note.voices.filter(function (v) {
      return v && (v.data || v.ref || v.id);
    });
  }
  if (note.voice) return [note.voice];
  return [];
}

function ensureNoteForVoice(noteId) {
  let n = (state.notes || []).find(function (x) {
    return x.id === noteId;
  });
  if (n) return n;
  n = {
    id: noteId,
    folderId: state.editingNoteFolderParentId || currentNotesFolderId() || null,
    title: "Голосовая заметка",
    text: "",
    color: "default",
    voices: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.notes.unshift(n);
  return n;
}

function voiceLabel(v, i) {
  return v.name || "Запись №" + (i + 1);
}

async function renderVoicePlayer(noteId) {
  const box = document.getElementById("voice-player");
  const n = (state.notes || []).find(function (x) {
    return x.id === noteId;
  });
  if (!box) return;
  const list = await refreshVoiceCache(noteId);
  if (!list.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML =
    '<div class="voice-player-inner">' +
    '<div class="voice-player-label">Голосовые записи — всего ' +
    list.length +
    "</div>" +
    list
      .map(function (v, i) {
        return (
          '<div class="voice-row-item">' +
          '<div class="voice-row-head">' +
          '<span class="voice-row-num">' +
          (i + 1) +
          "</span>" +
          '<input class="voice-name-input" data-voice-name="' +
          i +
          '" type="text" value="' +
          (v.name || "").replace(/"/g, "&quot;") +
          '" placeholder="' +
          "Запись №" +
          (i + 1) +
          '" maxlength="40" />' +
          "</div>" +
          '<audio controls preload="metadata" class="voice-audio" src="' +
          v.data +
          '"></audio>' +
          '<button type="button" class="ghost-btn voice-row-del" data-voice-idx="' +
          i +
          '">Удалить запись ' +
          (i + 1) +
          "</button>" +
          "</div>"
        );
      })
      .join("") +
    "</div>";

  box.querySelectorAll("[data-voice-idx]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const idx = parseInt(btn.getAttribute("data-voice-idx"), 10);
      confirmAction("Удалить запись " + (idx + 1) + " на всех устройствах?", "Аудио сотрётся везде.", function () {
        const n2 = (state.notes || []).find(function (x) {
          return x.id === noteId;
        });
        if (!n2) return;
        const arr = noteVoices(n2);
        const removed = arr[idx];
        if (removed && (removed.id || removed.ref)) {
          const vid = removed.id || removed.ref;
          if (!state.deletedVoiceIds.includes(vid)) state.deletedVoiceIds.push(vid);
        }
        arr.splice(idx, 1);
        n2.voices = arr;
        n2.updatedAt = nowIso();
        saveState();
        render();
        renderVoicePlayer(noteId);
        toast("Запись удалена везде");
        if (isCloudReady()) scheduleAutoSync();
      });
    });
  });

  box.querySelectorAll("[data-voice-name]").forEach(function (inp) {
    inp.addEventListener("change", function () {
      const idx = parseInt(inp.getAttribute("data-voice-name"), 10);
      const n2 = (state.notes || []).find(function (x) {
        return x.id === noteId;
      });
      if (!n2) return;
      const arr = noteVoices(n2);
      if (!arr[idx]) return;
      arr[idx].name = inp.value.trim() || "Запись №" + (idx + 1);
      n2.voices = arr;
      n2.updatedAt = nowIso();
      saveState();
      render();
      renderVoicePlayer(noteId);
      toast("Имя записи сохранено");
    });
  });
}

async function startVoiceRecord(noteId) {
  if (voiceState.recording || voiceState.busy) {
    toast("Подождите секунду — предыдущая запись сохраняется");
    return;
  }
  voiceState.busy = true;
  setTimeout(function () {
    voiceState.busy = false;
  }, 350);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Микрофон не поддерживается");
    return;
  }

  stopAllPlayback();
  muteAllAudio(true);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    muteAllAudio(false);
    toast("Нет доступа к микрофону");
    return;
  }

  let rec;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
  try {
    rec = new MediaRecorder(
      stream,
      mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined
    );
  } catch (_) {
    try {
      rec = new MediaRecorder(stream);
    } catch (__) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      muteAllAudio(false);
      toast("Не удалось запустить запись");
      return;
    }
  }

  const id = noteId || state.editingNoteId || uid();
  state.editingNoteId = id;
  ensureNoteForVoice(id);

  voiceState.chunks = [];
  voiceState.noteId = id;
  voiceState.recorder = rec;
  voiceState.recording = true;
  voiceState.startedAt = Date.now();

  rec.ondataavailable = function (e) {
    if (e.data && e.data.size) voiceState.chunks.push(e.data);
  };

  rec.onstop = async function () {
    try {
      stream.getTracks().forEach(function (tr) {
        tr.stop();
      });
    } catch (_) {}
    const blob = new Blob(voiceState.chunks, { type: rec.mimeType || "audio/webm" });
    voiceState.recording = false;
    voiceState.recorder = null;
    if (voiceState.timer) clearInterval(voiceState.timer);
    updateVoiceUI(false);
    // ensure record button is visible again for clip #2
    const rb = document.getElementById("btn-voice-record");
    const sb = document.getElementById("btn-voice-stop");
    if (rb) rb.hidden = false;
    if (sb) sb.hidden = true;
    // small delay so mic device fully released (reduces echo on next take)
    setTimeout(function () {
      muteAllAudio(false);
    }, 250);

    if (!voiceState.noteId) return;
    if (!blob.size || blob.size < 80) {
      toast("Запись пустая — повторите");
      return;
    }
    if (blob.size > 8 * 1024 * 1024) {
      toast("Запись слишком длинная");
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    const targetId = voiceState.noteId;
    const n = ensureNoteForVoice(targetId);
    const arr = noteVoices(n).slice();
    const num = arr.length + 1;
    const clipId = uid();
    try {
      await idbPut(clipId, dataUrl, { mime: rec.mimeType || "audio/webm", at: nowIso() });
    } catch (e) {
      toast("Не удалось сохранить аудио: " + e.message);
    }
    const clip = {
      id: clipId,
      ref: clipId,
      data: dataUrl,
      mime: rec.mimeType || "audio/webm",
      at: nowIso(),
      name: "Запись №" + num,
    };
    arr.push(clip);
    // KEEP full audio in memory so the note does not lose clips
    n.voices = arr;
    voiceCache[targetId] = arr;
    delete n.voice;
    n.updatedAt = nowIso();
    if (!n.title || n.title === "Заметка") n.title = "Голосовая заметка";
    saveState();
    renderVoicePlayer(targetId);
    const bar = document.getElementById("voice-status");
    if (bar) {
      bar.hidden = false;
      bar.className = "hint is-ok";
      bar.textContent = "Сохранено записей: " + arr.length + ". Можно записать следующую.";
    }
    toast("Готово: Запись №" + num + " (всего " + arr.length + ")");
    clearTimeout(voiceState.renderTimer);
    voiceState.renderTimer = setTimeout(function () {
      render();
      renderVoicePlayer(targetId);
    }, 400);
    // Debounced upload — frequent PATCH triggers GitHub secondary rate limit (403)
    if (isCloudReady()) {
      scheduleAutoSync();
    }
  };

  try {
    rec.start(500);
  } catch (_) {
    try {
      rec.start();
    } catch (__) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      muteAllAudio(false);
      toast("Не удалось начать запись");
      return;
    }
  }

  updateVoiceUI(true);
  if (voiceState.timer) clearInterval(voiceState.timer);
  voiceState.timer = setInterval(function () {
    const s = Math.floor((Date.now() - voiceState.startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    const bar = document.getElementById("voice-status");
    if (bar) {
      bar.hidden = false;
      bar.className = "hint is-err";
      bar.textContent = "Запись " + mm + ":" + ss + " … Потом «Стоп»";
    }
  }, 400);
  toast("Запись начата (звуки приложения заглушены)");
}

function stopVoiceRecord() {
  if (voiceState.timer) {
    clearInterval(voiceState.timer);
    voiceState.timer = null;
  }
  if (voiceState.recorder && voiceState.recording) {
    try {
      voiceState.recorder.stop();
    } catch (_) {
      voiceState.recording = false;
      updateVoiceUI(false);
      muteAllAudio(false);
    }
  } else {
    voiceState.recording = false;
    updateVoiceUI(false);
    muteAllAudio(false);
  }
}

function blobToDataUrl(blob) {
  return new Promise(function (resolve) {
    const fr = new FileReader();
    fr.onload = function () {
      resolve(fr.result);
    };
    fr.readAsDataURL(blob);
  });
}

async function playVoiceNote(noteId) {
  const list = await refreshVoiceCache(noteId);
  if (!list.length) {
    toast("В этой заметке нет голосовых записей");
    return;
  }
  stopAllPlayback();
  muteAllAudio(false);
  const last = list[list.length - 1];
  if (!last.data) {
    toast("Аудио не найдено в хранилище");
    return;
  }
  const a = new Audio(last.data);
  window.__ytkAudio = a;
  a.play().catch(function () {
    toast("Не удалось воспроизвести");
  });
}

function deleteVoiceNote(noteId) {
  const n = (state.notes || []).find(function (x) {
    return x.id === noteId;
  });
  if (!n || !noteVoices(n).length) return;
  confirmAction("Удалить все голосовые?", "Все аудио заметки сотрутся.", function () {
    n.voices = [];
    delete n.voice;
    n.updatedAt = nowIso();
    saveState();
    render();
    renderVoicePlayer(noteId);
    toast("Голосовые удалены");
  });
}

function updateVoiceUI(recording) {
  const recBtn = document.getElementById("btn-voice-record");
  const stopBtn = document.getElementById("btn-voice-stop");
  const bar = document.getElementById("voice-status");
  if (recBtn) recBtn.hidden = recording;
  if (stopBtn) stopBtn.hidden = !recording;
  if (bar && !recording) {
    bar.className = "hint";
  }
}

function fileToDataUrl(file) {
  return new Promise(function (resolve) {
    const fr = new FileReader();
    fr.onload = function () {
      resolve(fr.result);
    };
    fr.readAsDataURL(file);
  });
}

async function attachFilesToNote(noteId, fileList) {
  const n = ensureNoteForVoice(noteId);
  if (!n.files) n.files = [];
  for (const f of fileList) {
    if (!f) continue;
    if (f.size > 8 * 1024 * 1024) {
      toast("Файл слишком большой: " + f.name);
      continue;
    }
    const data = await fileToDataUrl(f);
    n.files.push({
      id: uid(),
      name: f.name,
      type: f.type || "",
      size: f.size,
      data: data,
      at: nowIso(),
    });
  }
  n.updatedAt = nowIso();
  saveState();
  render();
  renderVoicePlayer(noteId);
  renderFilesPlayer(noteId);
  toast("Файлы добавлены (" + (n.files || []).length + ")");
  if (isCloudReady()) scheduleAutoSync();
}

function renderFilesPlayer(noteId) {
  const box = document.getElementById("file-player");
  const n = (state.notes || []).find(function (x) {
    return x.id === noteId;
  });
  if (!box) return;
  const files = (n && n.files) || [];
  if (!files.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML =
    '<div class="voice-player-inner">' +
    '<div class="voice-player-label">Файлы (' + files.length + ")</div>" +
    files
      .map(function (f, i) {
        const isImg = /^image\//.test(f.type || "");
        const isVid = /^video\//.test(f.type || "");
        const isAud = /^audio\//.test(f.type || "");
        let preview = "";
        if (isImg) {
          preview = '<img class="file-img" src="' + f.data + '" alt="" />';
        } else if (isVid) {
          preview = '<video class="file-video" controls src="' + f.data + '"></video>';
        } else if (isAud) {
          preview = '<audio class="voice-audio" controls src="' + f.data + '"></audio>';
        }
        return (
          '<div class="file-row">' +
          '<div class="file-row-title">' +
          (i + 1) +
          ". " +
          escapeHtml(f.name || "Файл") +
          "</div>" +
          preview +
          '<div class="file-row-actions">' +
          '<a class="secondary-btn" download="' +
          escapeHtml(f.name || "file") +
          '" href="' +
          f.data +
          '">Скачать</a>' +
          '<button type="button" class="ghost-btn" data-file-del="' +
          f.id +
          '">Удалить</button>' +
          "</div></div>"
        );
      })
      .join("") +
    "</div>";

  box.querySelectorAll("[data-file-del]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const fid = btn.getAttribute("data-file-del");
      confirmAction("Удалить файл на всех устройствах?", "", function () {
        const n2 = (state.notes || []).find(function (x) {
          return x.id === noteId;
        });
        if (!n2) return;
        n2.files = (n2.files || []).filter(function (x) {
          return x.id !== fid;
        });
        n2.updatedAt = nowIso();
        saveState();
        render();
        renderFilesPlayer(noteId);
        toast("Файл удалён");
        if (isCloudReady()) scheduleAutoSync();
      });
    });
  });
}

function openNoteStoreModal(noteId = null, folderId = null) {
  state.editingNoteId = noteId;
  const note = noteId ? (state.notes || []).find((n) => n.id === noteId) : null;
  const fname = (function () {
    const fid = note ? note.folderId : folderId !== null ? folderId : currentNotesFolderId();
    const f = (state.noteFolders || []).find(function (x) {
      return x.id === fid;
    });
    return f ? f.name : "";
  })();
  document.getElementById("note-store-title").textContent = note
    ? "Заметка"
    : "Новая заметка";
  const folderLine = document.getElementById("note-store-folder");
  const folderSelect = document.getElementById("note-store-folder-select");
  if (folderSelect) {
    const opts = ['<option value="">Без папки</option>'];
    const walk = (parentId, depth) => {
      const kids = noteFolderChildren(parentId);
      for (const f of kids) {
        opts.push(
          `<option value="${f.id}" ${
            f.id === (note ? note.folderId : state.editingNoteFolderParentId) ? "selected" : ""
          }>${" ".repeat(depth * 2)}${escapeHtml(f.name)}</option>`
        );
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    folderSelect.innerHTML = opts.join("");
  }
  if (folderLine) {
    folderLine.textContent = fname
      ? "Папка: " + fname
      : "Папка: Все заметки (без папки)";
  }
  document.getElementById("note-store-name").value = note?.title || "";
  document.getElementById("note-store-text").value = note?.text || "";
  state.selectedNoteColor = note?.color || "default";
  const del = document.getElementById("btn-note-store-delete");
  if (del) del.hidden = !note;
  state.editingNoteFolderParentId =
    folderId !== null ? folderId : note?.folderId || currentNotesFolderId();

  const vPlay = document.getElementById("btn-voice-play");
  const vDel = document.getElementById("btn-voice-delete");
  const hasVoice = !!(note && note.voice && note.voice.data);
  if (vPlay) vPlay.hidden = !hasVoice;
  if (vDel) vDel.hidden = true;
  renderVoicePlayer(state.editingNoteId);
  renderFilesPlayer(state.editingNoteId);
  updateVoiceUI(false);

  const picks = document.getElementById("note-store-colors");
  if (picks) {
    const paint = () => {
      picks.innerHTML = KEEP_SWATCHES.map(
        (c) =>
          `<button type="button" class="color-swatch ${
            state.selectedNoteColor === c.id ? "is-selected" : ""
          }" data-note-color="${c.id}" style="background:${c.bg}" aria-label="Цвет"></button>`
      ).join("");
    };
    paint();
    picks.onclick = (e) => {
      const b = e.target.closest("[data-note-color]");
      if (!b) return;
      state.selectedNoteColor = b.getAttribute("data-note-color");
      paint();
    };
  }

  openModal("modal-note-store");
  setTimeout(() => document.getElementById("note-store-text")?.focus(), 40);
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

async function exportFullBackup() {
  const notes = await notesForSync();
  const payload = {
    version: 3,
    exportedAt: nowIso(),
    links: state.links,
    categories: state.categories,
    noteFolders: state.noteFolders || [],
    notes: notes,
    voiceClips: (function () {
      const out = [];
      for (const n of notes) {
        for (const v of n.voices || []) {
          if (v && v.data) {
            out.push({
              id: v.id,
              noteTitle: n.title || "",
              noteId: n.id,
              name: v.name,
              data: v.data,
            });
          }
        }
      }
      return out;
    })(),
    deletedCategoryIds: state.deletedCategoryIds || [],
    deletedNoteIds: state.deletedNoteIds || [],
    deletedNoteFolderIds: state.deletedNoteFolderIds || [],
  };
  const blob = new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "youtube-keep-full-" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Файл со всеми голосовыми сохранён");
}

async function importFullBackup(file) {
  const text = await file.text();
  const data = parseJsonSafe(text);
  if (!data || !Array.isArray(data.notes)) {
    toast("Файл не похож на резервную копию");
    return;
  }
  // union notes + clips
  const clipMap = new Map();
  const addClip = (v) => {
    if (!v || !v.data) return;
    const k = v.id || String(v.data).slice(0, 80);
    const prev = clipMap.get(k);
    if (!prev || String(v.data || "").length > String(prev.data || "").length) {
      clipMap.set(k, v);
    }
  };
  for (const n of [...(state.notes || []), ...(data.notes || [])]) {
    for (const v of n.voices || []) addClip(v);
    if (n.voice) addClip(n.voice);
  }
  for (const v of data.voiceClips || []) addClip(v);

  const nmap = new Map();
  const put = (n) => {
    if (!n || !n.id) return;
    const prev = nmap.get(n.id);
    const item = {
      id: n.id,
      folderId: n.folderId || null,
      title: n.title || "Заметка",
      text: n.text || "",
      color: n.color || "default",
      pinned: !!n.pinned,
      createdAt: n.createdAt || "",
      updatedAt: n.updatedAt || "",
      voices: [],
    };
    if (!prev) nmap.set(item.id, item);
    else
      nmap.set(item.id, {
        ...prev,
        ...item,
        text: String(n.text || "").length >= String(prev.text || "").length ? n.text : prev.text,
      });
  };
  for (const n of state.notes || []) put(n);
  for (const n of data.notes || []) put(n);

  // by title union clips
  const byTitle = new Map();
  for (const v of clipMap.values()) {
    const key = String(v.noteTitle || "").trim().toLowerCase() || v.noteId || "";
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(v);
  }
  for (const n of nmap.values()) {
    const list = byTitle.get(String(n.title || "").trim().toLowerCase()) || [];
    const m = new Map();
    for (const v of list) {
      const k = v.id || String(v.data).slice(0, 40);
      m.set(k, v);
    }
    n.voices = [...m.values()].map((v) => ({
      id: v.id || uid(),
      name: v.name || "",
      data: v.data,
      at: v.at || nowIso(),
      mime: v.mime || "audio/webm",
    }));
  }

  state.notes = [...nmap.values()];
  if (Array.isArray(data.noteFolders) && data.noteFolders.length) {
    const fm = new Map();
    for (const f of [...(state.noteFolders || []), ...data.noteFolders]) {
      if (f && f.id) fm.set(f.id, f);
    }
    state.noteFolders = [...fm.values()];
  }
  if (Array.isArray(data.links) && data.links.length) {
    const lm = new Map();
    for (const l of [...(state.links || []), ...data.links]) {
      if (l && l.id) lm.set(l.id, l);
    }
    state.links = [...lm.values()];
  }

  await storeVoicesFromCloud(state.notes);
  for (const n of state.notes) await refreshVoiceCache(n.id);
  saveState();
  render();
  const vCount = state.notes.reduce((s, n) => s + noteVoices(n).length, 0);
  toast("Объединено: заметок " + state.notes.length + ", голосовых " + vCount);
  if (isCloudReady()) scheduleAutoSync();
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

function renderSyncBanner() {
  const el = document.getElementById("sync-live");
  if (!el) return;
  const st = state.sync.status;
  const ready = isCloudReady();
  let cls = "sync-live";
  let text = "Облако не подключено";
  if (st === "busy") {
    cls += " is-busy";
    text = "Синхронизация идёт…";
  } else if (st === "ok") {
    cls += " is-ok";
    text =
      "Синхронизация выполнена удачно" +
      (state.sync.lastSync
        ? " · " + new Date(state.sync.lastSync).toLocaleTimeString("ru-RU")
        : "");
  } else if (st === "err") {
    cls += " is-err";
    text = "Синхронизация не удалась";
  } else if (ready) {
    cls += " is-ok";
    text = "Облако подключено — нажмите «Синхронизировать»";
  }
  el.className = cls;
  el.innerHTML = "<span class='sync-live-dot'></span><span>" + text + "</span>";
}

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
  if (status === 403 || /rate limit|abuse|secondary rate/i.test(msg)) {
    return "GitHub ограничил частые запросы. Подождите 1–2 минуты и нажмите «Синхронизировать».";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Нет связи с GitHub. Проверьте интернет на Mac и повторите.";
  }
  return `Ошибка: ${msg || status || "неизвестно"}`;
}

async function storeVoicesFromCloud(notesList) {
  for (const n of notesList || []) {
    const arr = Array.isArray(n.voices) ? n.voices : [];
    for (const v of arr) {
      if (v && v.data) {
        const id = v.id || v.ref || uid();
        try {
          await idbPut(id, v.data, { mime: v.mime, at: v.at });
        } catch (_) {}
      }
    }
    if (n.voice && n.voice.data) {
      try {
        await idbPut(n.voice.id || n.voice.ref || uid(), n.voice.data, { mime: n.voice.mime, at: n.voice.at });
      } catch (_) {}
    }
  }
}

async function notesForSync() {
  const out = [];
  for (const n of state.notes || []) {
    let fullVoices = await hydrateVoices(n);
    const cached = (voiceCache[n.id] || []).filter(function (v) {
      return v && v.data;
    });
    if (cached.length > fullVoices.filter(function (v) {
      return v && v.data;
    }).length) {
      fullVoices = cached;
    }
    // merge cache + hydrate unique by id
    const um = new Map();
    for (const v of [...fullVoices, ...(voiceCache[n.id] || [])]) {
      if (!v) continue;
      const key = v.id || v.ref || String(v.data || "").slice(0, 40);
      const prev = um.get(key);
      if (!prev || String(v.data || "").length > String(prev.data || "").length) {
        um.set(key, v);
      }
    }
    fullVoices = [...um.values()].filter(function (v) {
      return v && v.data;
    });
    out.push({
      id: n.id,
      folderId: n.folderId || null,
      title: n.title || "Заметка",
      text: n.text || "",
      color: n.color || "default",
      pinned: !!n.pinned,
      createdAt: n.createdAt || "",
      updatedAt: n.updatedAt || "",
      files: (n.files || []).map(function (f) {
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          size: f.size,
          data: f.data || '',
          at: f.at || '',
        };
      }),
      voices: fullVoices.map(function (v) {
        return {
          id: v.id,
          ref: v.ref || v.id,
          name: v.name || "",
          at: v.at || "",
          mime: v.mime || "audio/webm",
          data: v.data || "",
        };
      }),
    });
  }
  return out;
}

async function syncPayload() {
  const notes = await notesForSync();
  // flat list of every clip — easiest to union across devices
  const voiceClips = [];
  for (const n of notes) {
    for (const v of n.voices || []) {
      if (!v || !v.data) continue;
      voiceClips.push({
        id: v.id || v.ref || uid(),
        noteTitle: n.title || "",
        noteId: n.id,
        name: v.name || "",
        at: v.at || "",
        mime: v.mime || "audio/webm",
        data: v.data,
      });
    }
  }
  return JSON.stringify(
    {
      version: 3,
      updatedAt: nowIso(),
      links: state.links,
      categories: state.categories,
      deletedCategoryIds: state.deletedCategoryIds || [],
      noteFolders: state.noteFolders || [],
      notes: notes,
      voiceClips: voiceClips,
      deletedNoteFolderIds: state.deletedNoteFolderIds || [],
      deletedNoteIds: state.deletedNoteIds || [],
      deletedVoiceIds: state.deletedVoiceIds || [],
    },
    null,
    2
  );
}

function buildGistFiles(notesFull) {
  const files = {};
  const noteLite = (notesFull || []).map(function (n) {
    return {
      id: n.id,
      folderId: n.folderId || null,
      title: n.title || "",
      text: n.text || "",
      color: n.color || "default",
      pinned: !!n.pinned,
      createdAt: n.createdAt || "",
      updatedAt: n.updatedAt || "",
      voices: (n.voices || []).map(function (v) {
        return {
          id: v.id || v.ref,
          ref: v.id || v.ref,
          name: v.name || "",
          at: v.at || "",
          mime: v.mime || "",
          data: "",
        };
      }),
    };
  });
  const payload = {
    version: 4,
    updatedAt: nowIso(),
    links: state.links,
    categories: state.categories,
    deletedCategoryIds: state.deletedCategoryIds || [],
    noteFolders: state.noteFolders || [],
    notes: noteLite,
    deletedNoteFolderIds: state.deletedNoteFolderIds || [],
    deletedNoteIds: state.deletedNoteIds || [],
  };
  files["youtube-keep.json"] = {
    content: JSON.stringify(payload, null, 2),
  };
  // one file per audio clip — never lost in merge
  for (const n of notesFull || []) {
    for (const v of n.voices || []) {
      if (!v || !v.data) continue;
      const id = (v.id || v.ref || uid()).replace(/[^a-zA-Z0-9_-]/g, "");
      if (!id) continue;
      files["clip_" + id + ".json"] = {
        content: JSON.stringify({
          id: v.id || id,
          noteId: n.id,
          noteTitle: n.title || "",
          name: v.name || "",
          at: v.at || "",
          mime: v.mime || "audio/webm",
          data: v.data,
        }),
      };
    }
  }
  return files;
}

async function syncPush(opts = {}) {
  // EMPTY_LOCAL_PROTECT: never wipe cloud with an empty library
  try {
    if (isCloudReady()) {
      const res = await fetch(
        `https://api.github.com/gists/${state.sync.gistId || appConfig.gistId}`,
        {
          headers: {
            Authorization: `Bearer ${state.sync.token || appConfig.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      if (res.ok) {
        const gist = await res.json();
        const file = gist.files?.["youtube-keep.json"] || Object.values(gist.files || {})[0];
        const remote = file?.content ? parseJsonSafe(file.content) : null;
        const remoteLinks = (remote && remote.links) || [];
        const localLinks = state.links || [];
        const remoteFolders = (remote && remote.noteFolders) || [];
        const remoteNotes = (remote && remote.notes) || [];
        if (!(state.noteFolders || []).length && remoteFolders.length) {
          state.noteFolders = remoteFolders;
        }
        if (!(state.notes || []).length && remoteNotes.length) {
          state.notes = remoteNotes;
        }
        if (!localLinks.length && remoteLinks.length) {
          // adopt remote instead of overwriting
          state.links = remoteLinks.map(normalizeLink);
          if (Array.isArray(remote.categories) && remote.categories.length) {
            state.categories = remote.categories;
          }
          if (Array.isArray(remote.notes) && remote.notes.length) {
            state.notes = remote.notes;
          }
          if (Array.isArray(remote.noteFolders) && remote.noteFolders.length) {
            state.noteFolders = remote.noteFolders;
          }
          saveState({ sync: false });
          render();
          if (!opts.silent) {
            toast("Подтянул " + remoteLinks.length + " записей из облака");
          }
        }
      }
    }
  } catch (_) {
    /* ignore and continue push */
  }

  if (typeof parseJsonSafe !== "function") {
    /* keep going */
  }

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
      files: await buildGistFiles(await notesForSync()),
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
            files: await buildGistFiles(await notesForSync()),
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
    fillDeviceLink();
    setTimeout(function () {
      const link = deviceLink();
      if (link) {
        try {
          navigator.clipboard && navigator.clipboard.writeText(link);
          toast("Ссылка для других устройств скопирована");
        } catch (_) {}
      }
    }, 400);
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
    const gf = gist.files || {};
    const file = gf["youtube-keep.json"] || Object.values(gf)[0];
    if (!file?.content) throw new Error("В облаке пока нет данных — сначала нажмите «Отправить» на главном устройстве.");

    const data = parseJsonSafe(file.content);
    // collect every clip_* file
    data.voiceClips = data.voiceClips || [];
    for (const name of Object.keys(gf)) {
      if (!name.startsWith("clip_")) continue;
      try {
        const clip = parseJsonSafe(gf[name].content || "");
        if (clip && clip.data) {
          data.voiceClips.push(clip);
        }
      } catch (_) {}
    }
    if (!Array.isArray(data.links)) throw new Error("Некорректный формат данных");

    // merge links without losing notes from either side
    const map = new Map();
    for (const raw of [...(state.links || []), ...(data.links || [])]) {
      const norm = normalizeLink(raw);
      const prev = map.get(norm.id);
      map.set(norm.id, prev ? mergeLinkPair(prev, norm) : norm);
    }
    // also merge by videoId/url so the same video from two devices keeps notes
    const byKey = new Map();
    for (const link of map.values()) {
      const key = link.videoId || link.url || link.id;
      const prev = byKey.get(key);
      if (prev) byKey.set(key, mergeLinkPair(prev, link));
      else byKey.set(key, link);
    }
    state.links = [...byKey.values()];
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

    // Notes & note folders merge — UNION both devices
      {
        const deadF = new Set([
          ...(state.deletedNoteFolderIds || []),
          ...(data.deletedNoteFolderIds || []),
        ]);
        const deadN = new Set([
          ...(state.deletedNoteIds || []),
          ...(data.deletedNoteIds || []),
        ]);
        const deadV = new Set([
          ...(state.deletedVoiceIds || []),
          ...(data.deletedVoiceIds || []),
        ]);
        state.deletedNoteFolderIds = [...deadF];
        state.deletedNoteIds = [...deadN];
        state.deletedVoiceIds = [...deadV];

        const fmap = new Map();
        const putFolder = (f) => {
          if (!f || !f.id || deadF.has(f.id)) return;
          const item = {
            id: f.id,
            name: String(f.name || "Папка").trim(),
            parentId: f.parentId || null,
            color: f.color || "#c2410c",
            updatedAt: f.updatedAt || "",
          };
          const prev = fmap.get(f.id);
          if (!prev || (item.updatedAt || "") >= (prev.updatedAt || "")) {
            fmap.set(f.id, item);
          }
        };
        for (const f of state.noteFolders || []) putFolder(f);
        for (const f of data.noteFolders || []) putFolder(f);
        state.noteFolders = [...fmap.values()];

        const nmap = new Map();
        const putNote = (raw) => {
          if (!raw || !raw.id || deadN.has(raw.id)) return;
          const prev = nmap.get(raw.id);
          const item = {
            id: raw.id,
            folderId: raw.folderId || null,
            title: raw.title || "Заметка",
            text: raw.text || "",
            color: raw.color || "default",
            pinned: !!raw.pinned,
            createdAt: raw.createdAt || "",
            updatedAt: raw.updatedAt || "",
          };
          if (!prev) {
            nmap.set(raw.id, item);
            return;
          }
          const winner =
            (item.updatedAt || "") >= (prev.updatedAt || "") ? item : prev;
          nmap.set(raw.id, {
            ...prev,
            ...winner,
            title:
              winner.title && winner.title !== "Заметка"
                ? winner.title
                : prev.title,
            text:
              (item.text || "").length >= (prev.text || "").length
                ? item.text
                : prev.text,
            pinned: !!(prev.pinned || item.pinned),
          });
        };
        for (const n of state.notes || []) putNote(n);
        for (const n of data.notes || []) putNote(n);

        const voiceByNote = new Map();
        const collectVoices = (n) => {
          const out = [];
          if (!n) return out;
          if (Array.isArray(n.voices)) {
            for (const v of n.voices) if (v && (v.data || v.ref || v.id)) out.push(v);
          }
          if (n.voice && (n.voice.data || n.voice.ref || n.voice.id)) out.push(n.voice);
          return out;
        };
        const addVoices = (noteId, list) => {
          if (!noteId) return;
          const map = voiceByNote.get(noteId) || new Map();
          for (const v of list) {
            const key = v.id || v.ref || String(v.data || "").slice(0, 64);
            const prev = map.get(key);
            if (!prev || String(v.data || "").length > String(prev.data || "").length) {
              map.set(key, v);
            }
          }
          voiceByNote.set(noteId, map);
        };
        for (const n of state.notes || []) addVoices(n.id, collectVoices(n));
        for (const n of data.notes || []) addVoices(n.id, collectVoices(n));

        // Collapse duplicates by title+folder ("трава" on PC + phone -> one note)
        const byKey = new Map();
        for (const n of nmap.values()) {
          const key = String(n.title || "").trim().toLowerCase() + "::";
          const prev = byKey.get(key);
          if (!prev) {
            byKey.set(key, n);
          } else {
            const keep = (n.updatedAt || "") >= (prev.updatedAt || "") ? n : prev;
            const other = keep === n ? prev : n;
            byKey.set(key, {
              ...keep,
              text:
                String(n.text || "").length >= String(prev.text || "").length
                  ? n.text
                  : prev.text,
              pinned: !!(n.pinned || prev.pinned),
              createdAt:
                String(n.createdAt || "") < String(prev.createdAt || "") &&
                n.createdAt
                  ? n.createdAt
                  : prev.createdAt || n.createdAt,
            });
            // move voices from discarded id to keeper
            const a = voiceByNote.get(n.id) || new Map();
            const b = voiceByNote.get(prev.id) || new Map();
            for (const [k, v] of b) {
              if (!a.has(k)) a.set(k, v);
            }
            voiceByNote.set(byKey.get(key).id, a);
          }
        }

        for (const n of byKey.values()) {
          const vm = voiceByNote.get(n.id) || new Map();
          n.voices = [...vm.values()].map((v) => ({
            id: v.id || v.ref || uid(),
            ref: v.ref || v.id,
            name: v.name || "",
            at: v.at || "",
            mime: v.mime || "audio/webm",
            data: v.data || "",
          }));
          delete n.voice;
        }

        state.notes = [...byKey.values()];

        // Re-attach clips from flat voiceClips[] (union)
        const clipMap = new Map();
        const addClip = (v) => {
          if (!v || !v.data) return;
          const key = v.id || String(v.data).slice(0, 80);
          const prev = clipMap.get(key);
          if (!prev || String(v.data || "").length > String(prev.data || "").length) {
            clipMap.set(key, v);
          }
        };
        for (const n of state.notes || []) {
          for (const v of collectVoices(n)) addClip(v);
        }
        for (const v of data.voiceClips || []) addClip(v);
        for (const n of data.notes || []) {
          for (const v of collectVoices(n)) addClip(v);
        }

        // group clips by note title (and noteId)
        const byTitle = new Map();
        for (const v of clipMap.values()) {
          const title = String(v.noteTitle || v.title || "").trim().toLowerCase();
          const key = title || v.noteId || "";
          if (!key) continue;
          if (!byTitle.has(key)) byTitle.set(key, []);
          byTitle.get(key).push(v);
        }

        for (const n of state.notes || []) {
          const titleKey = String(n.title || "").trim().toLowerCase();
          const list = byTitle.get(titleKey) || byTitle.get(n.id) || [];
          // unique by id
          const m = new Map();
          for (const v of list) {
            const k = v.id || String(v.data || "").slice(0, 40);
            if (!m.has(k) || String(v.data || "").length > String(m.get(k).data || "").length) {
              m.set(k, v);
            }
          }
          const fm = new Map();
          for (const src of [prev, item, raw]) {
            for (const f of (src && src.files) || []) {
              if (f && f.id && f.data) fm.set(f.id, f);
            }
          }
          if (fm.size) n.files = [...fm.values()];
          n.voices = [...m.values()]
            .filter((v) => v && !(v.id && state.deletedVoiceIds.includes(v.id)))
            .map((v) => ({
              id: v.id || uid(),
              ref: v.id || v.ref,
              name: v.name || "",
              at: v.at || "",
              mime: v.mime || "audio/webm",
              data: v.data || "",
            }));
          delete n.voice;
        }

        storeVoicesFromCloud(state.notes).then(function () {
          for (const n of state.notes || []) refreshVoiceCache(n.id);
        });
      }

    saveState({ sync: false });
    state.sync.lastSync = nowIso();
    state.sync.status = "ok";
    saveSyncSettings();
    render();
    const cloudClips = (data.voiceClips || []).length;
    const localClips = (state.notes || []).reduce(function (s, n) {
      return s + noteVoices(n).length;
    }, 0);
    setSyncMessage(
      "Загружено. На устройстве голосовых: " +
        localClips +
        " (в файле облака клипов: " +
        Math.max(cloudClips, localClips) +
        ")"
    );
    if (!opts.silent) {
      const vv = (state.notes || []).reduce((s, n) => s + noteVoices(n).length, 0);
      toast("Из облака: заметок " + state.notes.length + ", голосовых " + vv);
    }
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
  if (state.sync.rateLimitedUntil && Date.now() < state.sync.rateLimitedUntil) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(function () {
    syncAll().catch(function () {});
  }, 15000);
}

/** Two-way: download remote, merge, then upload. */
async function syncAll() {
  if (!isCloudReady()) {
    setSyncMessage("Нет подключения к облаку. Откройте шестерёнку.", true);
    return;
  }
  if (syncingNow) return;
  syncingNow = true;
  state.sync.status = "busy";
  renderSyncStatus();
  try {
    // 1) always pull first so we do not overwrite other device
    try {
      await syncPull({ silent: true, skipStatus: true });
    } catch (e) {
      // continue — maybe first time
    }
    await hydrateAllVoices();

    // 2) push merged library
    await syncPush({ silent: true, skipStatus: true });
    await hydrateAllVoices();

    const nCount = (state.notes || []).length;
    const vCount = (state.notes || []).reduce(function (s, n) {
      return s + noteVoices(n).length;
    }, 0);
    const lCount = (state.links || []).length;
    state.sync.status = "ok";
    state.sync.lastSync = nowIso();
    saveSyncSettings();
    setSyncMessage(
      "Готово. Ссылок: " +
        lCount +
        ", заметок: " +
        nCount +
        ", голосовых: " +
        vCount +
        ". Данные объединены с облаком."
    );
    render();
  } catch (err) {
    state.sync.status = "err";
    const m = String((err && err.message) || err);
    if (err && (err.status === 403 || /rate limit|abuse/i.test(m))) {
      state.sync.rateLimitedUntil = Date.now() + 120000;
      setSyncMessage(
        "GitHub: слишком частый синк. Подождите 2 минуты, затем «Синхронизировать» вручную.",
        true
      );
    } else {
      setSyncMessage(explainGitHubError(err, err.status), true);
    }
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
  }, 180000);
  if (!startCloudWatch._bound) {
    startCloudWatch._bound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !isCloudReady()) return;
      const now = Date.now();
      if (now - (startCloudWatch._last || 0) < 60000) return;
      startCloudWatch._last = now;
      syncAll().catch(() => {});
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

window.addEventListener("error", function (e) {
  try {
    const el = document.getElementById("toast");
    if (el) {
      el.textContent = "Ошибка: " + (e.message || "script");
      el.classList.add("is-visible");
      setTimeout(() => el.classList.remove("is-visible"), 4000);
    }
  } catch (_) {}
});

// Delegated safety net: critical actions work even if bindEvents partially failed
document.addEventListener("click", function (e) {
  try {
    const add = e.target.closest("#btn-add, #btn-empty-add, [data-open-add]");
    if (add) {
      e.preventDefault();
      if (typeof openLinkModal === "function") openLinkModal();
      return;
    }
    const setup = e.target.closest("#btn-open-setup, #btn-sync-settings");
    if (setup) {
      e.preventDefault();
      if (typeof openSyncModal === "function") openSyncModal();
      return;
    }
    const syncNow = e.target.closest("#btn-sync-now");
    if (syncNow) {
      e.preventDefault();
      if (typeof syncAll === "function") syncAll();
      return;
    }
    const vrec = e.target.closest("#btn-voice-record");
    if (vrec) {
      e.preventDefault();
      const id = state.editingNoteId || uid();
      state.editingNoteId = id;
      if (typeof startVoiceRecord === "function") startVoiceRecord(id);
      return;
    }
    const vstop = e.target.closest("#btn-voice-stop");
    if (vstop) {
      e.preventDefault();
      if (typeof stopVoiceRecord === "function") stopVoiceRecord();
      return;
    }
    const comp = e.target.closest("[data-notes-compact]");
    if (comp) {
      e.preventDefault();
      state.notesCompact = !state.notesCompact;
      if (state.notesCompact) state.expandedNoteIds.clear();
      render();
      return;
    }
    const menu = e.target.closest("#btn-menu");
    if (menu) {
      e.preventDefault();
      if (typeof openSidebar === "function") openSidebar();
    }
  } catch (err) {
    try {
      const el = document.getElementById("toast");
      if (el) {
        el.textContent = "Клик: " + err.message;
        el.classList.add("is-visible");
      }
    } catch (_) {}
  }
}, true);

window.__ytkAdd = function () {
  if (typeof openLinkModal === "function") openLinkModal();
};
window.__ytkSetup = function () {
  if (typeof openSyncModal === "function") openSyncModal();
};
window.__ytkSync = function () {
  if (typeof syncAll === "function") syncAll();
};

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


window.__forcePull = function () {
  if (!isCloudReady()) {
    toast("Нет облака");
    return;
  }
  syncPull({ silent: false })
    .then(() => hydrateAllVoices())
    .then(() => {
      render();
      const v = (state.notes || []).reduce((s, n) => s + noteVoices(n).length, 0);
      toast("Принято: заметок " + state.notes.length + ", голосовых " + v);
    })
    .catch(() => {});
};
window.__forcePush = function () {
  if (!isCloudReady()) {
    toast("Нет облака");
    return;
  }
  syncPush({ silent: false })
    .then(() => {
      toast("Всё с этого устройства отправлено");
    })
    .catch(() => {});
};
window.exportFullBackup = function () {
  exportFullBackup();
};
window.__importFull = function () {
  const el = document.getElementById("import-full-file");
  if (el) el.click();
};

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
    const treeToggle = e.target.closest("[data-notes-tree]");
    if (treeToggle) {
      e.preventDefault();
      e.stopPropagation();
      state.notesTreeOpen = !state.notesTreeOpen;
      renderNotesSidebar();
      return;
    }
    const toggle = e.target.closest("[data-note-toggle]");
    const add = e.target.closest("[data-note-folder-add]");
    const edit = e.target.closest("[data-note-folder-edit]");
    const open = e.target.closest("[data-note-folder]");
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const id = toggle.getAttribute("data-note-toggle");
      if (state.expandedNoteFolders.has(id)) state.expandedNoteFolders.delete(id);
      else state.expandedNoteFolders.add(id);
      renderNotesSidebar();
      return;
    }
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
      const id = open.getAttribute("data-note-folder");
      state.filter = id ? `notes:${id}` : "notes:all";
      if (id) {
        state.expandedNoteFolders.add(id);
        let cur = (state.noteFolders || []).find((f) => f.id === id);
        const guard = new Set();
        while (cur?.parentId && !guard.has(cur.id)) {
          guard.add(cur.id);
          state.expandedNoteFolders.add(cur.parentId);
          cur = (state.noteFolders || []).find((f) => f.id === cur.parentId);
        }
      }
      render();
      closeSidebar();
    }
  });

  document.getElementById("nav-notes")?.addEventListener("click", () => {
    state.notesTreeOpen = !state.notesTreeOpen;
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

  let dragNoteId = null;
  document.getElementById("grid")?.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-note-id]");
    if (!card) return;
    dragNoteId = card.getAttribute("data-note-id");
    try {
      e.dataTransfer.setData("text/plain", dragNoteId);
      e.dataTransfer.effectAllowed = "move";
    } catch (_) {}
    card.classList.add("is-dragging");
  });
  document.getElementById("grid")?.addEventListener("dragend", () => {
    dragNoteId = null;
    document.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
    document.querySelectorAll(".is-drop").forEach((el) => el.classList.remove("is-drop"));
  });

  document.getElementById("folder-strip")?.addEventListener("dragover", (e) => {
    const z = e.target.closest("[data-drop-folder], [data-drop-none]");
    if (!z) return;
    e.preventDefault();
    z.classList.add("is-drop");
  });
  document.getElementById("folder-strip")?.addEventListener("dragleave", (e) => {
    const z = e.target.closest("[data-drop-folder], [data-drop-none]");
    if (z) z.classList.remove("is-drop");
  });
  document.getElementById("folder-strip")?.addEventListener("drop", (e) => {
    const z = e.target.closest("[data-drop-folder], [data-drop-none]");
    if (!z) return;
    e.preventDefault();
    z.classList.remove("is-drop");
    const id = dragNoteId || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const folderId = z.hasAttribute("data-drop-none") ? null : z.getAttribute("data-drop-folder");
    const n = (state.notes || []).find((x) => x.id === id);
    if (!n) return;
    n.folderId = folderId;
    n.updatedAt = nowIso();
    saveState();
    render();
    toast(folderId ? "Заметка перенесена в папку" : "Заметка вынута из папки");
    syncAll().catch(() => {});
  });

  // also allow drop on sidebar folders
  document.getElementById("notes-list")?.addEventListener("dragover", (e) => {
    const z = e.target.closest("[data-note-folder]");
    if (!z) return;
    e.preventDefault();
    z.classList.add("is-drop");
  });
  document.getElementById("notes-list")?.addEventListener("drop", (e) => {
    const z = e.target.closest("[data-note-folder]");
    if (!z) return;
    e.preventDefault();
    z.classList.remove("is-drop");
    const id = dragNoteId || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
    const folderId = z.getAttribute("data-note-folder") || null;
    if (!id) return;
    const n = (state.notes || []).find((x) => x.id === id);
    if (!n) return;
    n.folderId = folderId || null;
    n.updatedAt = nowIso();
    saveState();
    render();
    toast("Заметка перенесена");
    syncAll().catch(() => {});
  });

  document.getElementById("grid")?.addEventListener("dblclick", (e) => {
    const open = e.target.closest("[data-note-open]");
    if (open && state.filter.startsWith("notes:")) {
      e.preventDefault();
      openNoteStoreModal(open.getAttribute("data-note-open"));
    }
  });

  document.getElementById("grid")?.addEventListener("click", (e) => {
    const vplay = e.target.closest("[data-note-voice-play]");
    const vdel = e.target.closest("[data-note-voice-del]");
    const toggleN = e.target.closest("[data-note-toggle]");
    const editNote = e.target.closest("[data-note-edit]");
    if (toggleN && !editNote) {
      e.preventDefault();
      const nid = toggleN.getAttribute("data-note-toggle");
      if (state.expandedNoteIds.has(nid)) state.expandedNoteIds.delete(nid);
      else state.expandedNoteIds.add(nid);
      render();
      return;
    }
    const open = e.target.closest("[data-note-open]");
    const del = e.target.closest("[data-note-del]");
    const pin = e.target.closest("[data-note-pin]");
    if (editNote) {
      e.preventDefault();
      e.stopPropagation();
      openNoteStoreModal(editNote.getAttribute("data-note-edit"));
      return;
    }

    if (vplay) {
      e.preventDefault();
      e.stopPropagation();
      playVoiceNote(vplay.getAttribute("data-note-voice-play"), vplay);
      return;
    }
    if (vdel) {
      e.preventDefault();
      e.stopPropagation();
      deleteVoiceNote(vdel.getAttribute("data-note-voice-del"));
      return;
    }
    const addNote = e.target.closest("[data-note-add]");
    if (pin && state.filter.startsWith("notes:")) {
      e.preventDefault();
      e.stopPropagation();
      const id = pin.getAttribute("data-note-pin");
      const n = state.notes.find((x) => x.id === id);
      if (n) {
        n.pinned = !n.pinned;
        n.updatedAt = nowIso();
        saveState();
        render();
        toast(n.pinned ? "Закреплено" : "Откреплено");
      }
      return;
    }
    if (addNote && state.filter.startsWith("notes:")) {
      e.preventDefault();
      openNoteStoreModal(null, addNote.getAttribute("data-note-add") || null);
      return;
    }
    if (open) {
      e.preventDefault();
      const nid = open.getAttribute("data-note-open");
      if (state.notesCompact) {
        if (state.expandedNoteIds.has(nid)) state.expandedNoteIds.delete(nid);
        else state.expandedNoteIds.add(nid);
        render();
        return;
      }
      openNoteStoreModal(nid);
      return;
    }
    if (del && state.filter.startsWith("notes:")) {
      e.preventDefault();
      const id = del.getAttribute("data-note-del");
      const n = state.notes.find((x) => x.id === id);
      confirmAction(
        "Удалить заметку?",
        `«${n?.title || "Заметка"}» будет удалена. Уверены?`,
        () => {
          state.deletedNoteIds.push(id);
          state.notes = state.notes.filter((x) => x.id !== id);
          saveState();
          render();
          toast("Заметка удалена");
        }
      );
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
  document.getElementById("btn-force-pull")?.addEventListener("click", () => {
    if (window.__forcePull) window.__forcePull();
  });
  document.getElementById("btn-force-push")?.addEventListener("click", () => {
    if (window.__forcePush) window.__forcePush();
  });
  document.getElementById("btn-export-full")?.addEventListener("click", () => exportFullBackup());
  document.getElementById("btn-import-full")?.addEventListener("click", () => {
    document.getElementById("import-full-file").click();
  });
  document.getElementById("import-full-file")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importFullBackup(f);
    e.target.value = "";
  });
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
  document.getElementById("btn-add-files")?.addEventListener("click", () => {
    const id = state.editingNoteId || uid();
    state.editingNoteId = id;
    ensureNoteForVoice(id);
    const inp = document.getElementById("note-files-input");
    if (inp) inp.click();
  });
  document.getElementById("note-files-input")?.addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const id = state.editingNoteId || uid();
    state.editingNoteId = id;
    attachFilesToNote(id, [...files]);
    e.target.value = "";
  });
  document.getElementById("btn-voice-record")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAllPlayback();
    const modal = document.getElementById("modal-note-store");
    if (modal && modal.hidden) {
      openNoteStoreModal(state.editingNoteId || null, currentNotesFolderId());
    }
    const id = state.editingNoteId || uid();
    state.editingNoteId = id;
    startVoiceRecord(id);
  });
  document.getElementById("btn-voice-stop")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopVoiceRecord();
  });
  document.getElementById("btn-voice-stop")?.addEventListener("click", (e) => {
    e.preventDefault();
    stopVoiceRecord();
  });
  document.getElementById("btn-voice-play")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (state.editingNoteId) playVoiceNote(state.editingNoteId);
  });
  document.getElementById("btn-voice-delete")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (state.editingNoteId) {
      deleteVoiceNote(state.editingNoteId);
      openNoteStoreModal(state.editingNoteId);
    }
  });
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
    const sel = document.getElementById("note-store-folder-select");
    const folderId = sel && sel.value !== "" ? sel.value : null;
    const color = state.selectedNoteColor || "default";
    if (state.editingNoteId) {
      const n = state.notes.find((x) => x.id === state.editingNoteId);
      if (n) {
        n.title = title;
        n.text = text;
        n.folderId = folderId;
        n.color = color;
        n.updatedAt = nowIso();
        // voice/files already on n
      }
      toast("Заметка сохранена");
    } else {
      state.notes.unshift({
        id: uid(),
        folderId,
        title,
        text,
        color,
        pinned: false,
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
    const id = state.editingNoteId;
    const n = state.notes.find((x) => x.id === id);
    confirmAction(
      "Удалить заметку?",
      `«${n?.title || "Заметка"}» будет удалена безвозвратно. Уверены?`,
      () => {
        state.deletedNoteIds.push(id);
        state.notes = state.notes.filter((x) => x.id !== id);
        saveState();
        closeModal("modal-note-store");
        render();
        toast("Заметка удалена");
      }
    );
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
loadAppConfig()
  .then(() => applyHashCredentials())
  .then(() => hydrateAllVoices())
  .then(() => {
    render();
    if (isCloudReady()) {
      // pull first so phone receives everything from PC/Mac
      syncPull({ silent: true, skipStatus: true })
        .then(() => hydrateAllVoices())
        .then(() => {
          render();
          return syncAll();
        })
        .catch(() => {});
      startCloudWatch();
    }
  });

// Mark app as alive for the user / debugging
(function markAlive() {
  try {
    const el = document.getElementById("build-label");
    if (el) el.textContent = "Сборка 2026.10.08.67 — работает";
    document.documentElement.setAttribute("data-ytk", "2026.10.08.67");
  } catch (_) {}
})();

// Huawei/HarmonyOS often cannot install PWA — show help after a few seconds if not standalone
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (window.matchMedia("(display-mode: browser)").matches) {
  setTimeout(() => {
    if (localStorage.getItem("youtube-keep:install-hint") === "1") return;
    const ua = navigator.userAgent || "";
    const maybeHuawei = /Huawei|HarmonyOS|HMSCore|HB4A|HONOR/i.test(ua);
    if (maybeHuawei || true) {
      // quiet corner help button instead of a modal nag
      const fab = document.createElement("button");
      fab.type = "button";
      fab.className = "install-fab";
      fab.textContent = "Как установить";
      fab.addEventListener("click", () => {
        openModal("modal-install");
      });
      document.body.appendChild(fab);
    }
  }, 1800);
}
