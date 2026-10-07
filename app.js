/* YouTube Keep — app logic */

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
  selectedColor: "default",
  selectedCatColor: CAT_COLORS[0],
  pendingConfirm: null,
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
        const data = JSON.parse(legacy);
        state.links = (data.links || []).map(normalizeLink);
        state.categories = data.categories || [];
      }
      if (!state.categories.length) seedDefaults();
      else saveState();
      loadSyncSettings();
      return;
    }
    const data = JSON.parse(raw);
    state.links = (data.links || []).map(normalizeLink);
    state.categories = Array.isArray(data.categories) ? data.categories : [];
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
    })
  );
  if (options.sync !== false) scheduleAutoSync();
}

function loadSyncSettings() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.sync.token = data.token || "";
    state.sync.gistId = data.gistId || "";
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
}

function seedDefaults() {
  state.categories = [
    { id: uid(), name: "Образование", color: CAT_COLORS[2] },
    { id: uid(), name: "Музыка", color: CAT_COLORS[4] },
    { id: uid(), name: "Разработка", color: CAT_COLORS[3] },
    { id: uid(), name: "Вдохновение", color: CAT_COLORS[0] },
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
    list = list.filter((l) => l.categoryId === catId);
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

function renderCategories() {
  const list = document.getElementById("category-list");
  list.innerHTML = state.categories
    .map((cat) => {
      const count = state.links.filter((l) => l.categoryId === cat.id).length;
      const active = state.filter === `category:${cat.id}`;
      return `
        <button class="cat-item ${active ? "active" : ""}" data-category-id="${cat.id}" type="button">
          <span class="cat-dot" style="background:${cat.color}"></span>
          <span>${escapeHtml(cat.name)}</span>
          <span class="nav-count">${count}</span>
          <span class="cat-actions">
            <span class="mini-btn" data-edit-cat="${cat.id}" title="Переименовать" role="button" tabindex="0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </span>
            <span class="mini-btn" data-del-cat="${cat.id}" title="Удалить" role="button" tabindex="0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
            </span>
          </span>
        </button>
      `;
    })
    .join("");

  document.getElementById("count-all").textContent = state.links.length;
  document.getElementById("count-pinned").textContent = state.links.filter((l) => l.pinned).length;

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === state.filter);
  });
  document.querySelectorAll(".cat-item").forEach((btn) => {
    const id = btn.dataset.categoryId;
    btn.classList.toggle("active", state.filter === `category:${id}`);
  });
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const links = visibleLinks();

  // page title
  const titleEl = document.getElementById("page-title");
  const subEl = document.getElementById("page-sub");
  if (state.filter === "pinned") {
    titleEl.textContent = "Закреплённые";
    subEl.textContent = "Самое важное — под рукой";
  } else if (state.filter.startsWith("category:")) {
    const cat = state.categories.find((c) => c.id === state.filter.slice("category:".length));
    titleEl.textContent = cat?.name || "Направление";
    subEl.textContent = "Ссылки этого направления";
  } else {
    titleEl.textContent = "Все ссылки";
    subEl.textContent = "Сохраняйте ролики и разбирайте их по направлениям";
  }

  if (!links.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = links
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
            ${link.note ? `<p class="card-note">${escapeHtml(link.note)}</p>` : ""}
            ${
              (link.tags || []).length
                ? `<div class="card-tags">${link.tags
                    .map(
                      (t) =>
                        `<button type="button" class="tag-chip tag-chip-card" data-tag="${escapeHtml(
                          String(t).toLowerCase()
                        )}">#${escapeHtml(t)}</button>`
                    )
                    .join("")}</div>`
                : ""
            }
            <div class="card-meta">
              ${
                cat
                  ? `<span class="chip"><span class="chip-dot" style="background:${cat.color}"></span>${escapeHtml(cat.name)}</span>`
                  : `<span class="chip">Без направления</span>`
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
  renderCategories();
  renderTags();
  renderGrid();
  fillCategorySelect();
  renderSyncStatus();
}

function fillCategorySelect() {
  const options =
    `<option value="">Без направления</option>` +
    state.categories
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join("");
  for (const id of ["link-category", "import-category"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    const current = select.value;
    select.innerHTML = options;
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }
}

/* ---------- modals ---------- */

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

function openCategoryModal(category = null) {
  const isEdit = !!category;
  document.getElementById("modal-cat-title").textContent = isEdit
    ? "Редактировать направление"
    : "Новое направление";
  document.getElementById("cat-submit").textContent = isEdit ? "Сохранить" : "Создать";
  document.getElementById("cat-name").value = category?.name || "";
  state.selectedCatColor = category?.color || CAT_COLORS[0];
  state.editingCategoryId = category?.id || null;

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
    }
    toast("Направление обновлено");
  } else {
    state.categories.push({
      id: uid(),
      name,
      color: state.selectedCatColor,
    });
    toast("Направление создано");
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
  const count = state.links.filter((l) => l.categoryId === id).length;
  confirmAction(
    "Удалить направление?",
    count
      ? `«${cat?.name}»: ${count} ссылок останутся без направления.`
      : `«${cat?.name}» будет удалено.`,
    () => {
      state.links = state.links.map((l) =>
        l.categoryId === id ? { ...l, categoryId: null } : l
      );
      state.categories = state.categories.filter((c) => c.id !== id);
      if (state.filter === `category:${id}`) state.filter = "all";
      saveState();
      render();
      toast("Направление удалено");
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
      const data = JSON.parse(reader.result);
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
      const json = JSON.parse(trimmed);
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
  el.className = isError ? "hint is-err" : text.includes("успешно") || text.includes("Готово") ? "hint is-ok" : "hint";
}

function syncPayload() {
  return JSON.stringify(
    {
      version: 2,
      updatedAt: nowIso(),
      links: state.links,
      categories: state.categories,
    },
    null,
    2
  );
}

async function syncPush() {
  if (!state.sync.token) {
    setSyncMessage("Укажите GitHub token", true);
    openModal("modal-sync");
    return;
  }
  state.sync.status = "busy";
  renderSyncStatus();
  setSyncMessage("Отправляю данные…");

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
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    state.sync.gistId = data.id;
    state.sync.lastSync = nowIso();
    state.sync.status = "ok";
    state.sync.message = "Успешно отправлено в облако";
    saveSyncSettings();
    setSyncMessage(`Готово. Gist ID: ${data.id}`);
    toast("Синхронизация: данные отправлены");
  } catch (err) {
    state.sync.status = "err";
    setSyncMessage(`Ошибка: ${err.message}`, true);
    toast("Ошибка синхронизации");
  } finally {
    renderSyncStatus();
  }
}

async function syncPull() {
  if (!state.sync.token || !state.sync.gistId) {
    setSyncMessage("Нужны token и Gist ID", true);
    openModal("modal-sync");
    return;
  }
  state.sync.status = "busy";
  renderSyncStatus();
  setSyncMessage("Загружаю данные…");

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
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const gist = await res.json();
    const file = gist.files?.["youtube-keep.json"] || Object.values(gist.files || {})[0];
    if (!file?.content) throw new Error("В gist нет файла youtube-keep.json");

    const data = JSON.parse(file.content);
    if (!Array.isArray(data.links)) throw new Error("Некорректный формат данных");

    // merge: keep newer by updatedAt per id
    const map = new Map();
    for (const link of [...state.links, ...data.links]) {
      const norm = normalizeLink(link);
      const prev = map.get(norm.id);
      if (!prev || (norm.updatedAt || "") > (prev.updatedAt || "")) map.set(norm.id, norm);
    }
    state.links = [...map.values()];
    if (Array.isArray(data.categories) && data.categories.length) {
      const catMap = new Map(state.categories.map((c) => [c.id, c]));
      for (const cat of data.categories) {
        const prev = catMap.get(cat.id);
        catMap.set(cat.id, prev ? { ...prev, ...cat } : cat);
      }
      state.categories = [...catMap.values()];
    }

    saveState({ sync: false });
    state.sync.lastSync = nowIso();
    state.sync.status = "ok";
    saveSyncSettings();
    render();
    setSyncMessage(`Готово. Ссылок: ${state.links.length}`);
    toast("Данные загружены из облака");
  } catch (err) {
    state.sync.status = "err";
    setSyncMessage(`Ошибка: ${err.message}`, true);
    toast("Не удалось загрузить из облака");
  } finally {
    renderSyncStatus();
  }
}

let autoSyncTimer = null;
function scheduleAutoSync() {
  if (!state.sync.auto || !state.sync.token || !state.sync.gistId) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    syncPush().catch(() => {});
  }, 1500);
}

function openSyncModal() {
  document.getElementById("sync-token").value = state.sync.token;
  document.getElementById("sync-gist").value = state.sync.gistId;
  document.getElementById("sync-auto").checked = state.sync.auto;
  setSyncMessage(
    state.sync.lastSync
      ? `Последняя синхронизация: ${new Date(state.sync.lastSync).toLocaleString("ru-RU")}`
      : "Синхронизация не настроена."
  );
  openModal("modal-sync");
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

  document.getElementById("category-list").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit-cat]");
    const del = e.target.closest("[data-del-cat]");
    if (edit) {
      e.stopPropagation();
      const cat = state.categories.find((c) => c.id === edit.dataset.editCat);
      if (cat) openCategoryModal(cat);
      return;
    }
    if (del) {
      e.stopPropagation();
      deleteCategory(del.dataset.delCat);
      return;
    }
    const item = e.target.closest("[data-category-id]");
    if (!item) return;
    const id = item.dataset.categoryId;
    state.filter = state.filter === `category:${id}` ? "all" : `category:${id}`;
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

  // grid actions
  document.getElementById("grid").addEventListener("click", (e) => {
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
