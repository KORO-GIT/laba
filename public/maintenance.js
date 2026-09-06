const module = location.pathname.includes('/service') ? 'service' : 'workshop';
const board = document.querySelector('#maintenance-board');
const dialog = document.querySelector('#card-dialog');
const toast = document.querySelector('#toast');
const search = document.querySelector('#search');
const clearSearch = document.querySelector('#clear-search');
const assetFilter = document.querySelector('#asset-filter');
const state = {
  me: null,
  data: null,
  selectedId: null,
  cardDirty: false,
  dragging: null,
  movePending: 0,
  mutationVersion: 0,
  boardLoading: false,
  refreshTimer: null
};

function showToast(message, error = false) {
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json', 'X-Portal-Request': '1' } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Помилка ${response.status}`);
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kyivTime(value) {
  if (!value) return 'ще не виконувалась';
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function laneTitle(key) {
  return state.data?.lanes.find((lane) => lane.key === key)?.title || key;
}

function filteredCards() {
  const query = search.value.trim().toLocaleLowerCase('uk-UA');
  return state.data.cards.filter((card) => {
    if (assetFilter.value && card.asset !== assetFilter.value) return false;
    if (!query) return true;
    return [
      card.asset,
      card.boardIdentifier,
      card.sourceStatus,
      card.reportNumber,
      ...card.identifiers,
      ...(card.cardStatuses || []).map((status) => status.name),
      ...(card.cardLabels || []).map((label) => label.name)
    ]
      .some((value) => String(value).toLocaleLowerCase('uk-UA').includes(query));
  });
}

function renderAssetFilter() {
  const selected = assetFilter.value;
  const assets = [...new Set(state.data.cards.map((card) => card.asset))]
    .sort((left, right) => left.localeCompare(right, 'uk-UA'));
  const all = el('option', '', 'Усі засоби');
  all.value = '';
  const options = assets.map((asset) => {
    const option = el('option', '', asset);
    option.value = asset;
    return option;
  });
  assetFilter.replaceChildren(all, ...options);
  assetFilter.value = assets.includes(selected) ? selected : '';
}

function renderLabelLegend() {
  const legend = document.querySelector('#card-label-legend');
  const labels = state.data.cardLabels || [];
  const items = labels.map((label) => {
    const item = el('span', 'maintenance-label-legend-item');
    item.style.setProperty('--card-status-color', label.color);
    item.append(el('span', 'maintenance-label-swatch'), el('span', '', label.name));
    return item;
  });
  legend.replaceChildren(...items);
  legend.classList.toggle('hidden', items.length === 0);
}

function cardNode(card) {
  const article = el('article', 'maintenance-card');
  article.dataset.cardId = String(card.id);
  article.tabIndex = 0;
  if (state.data.canEdit) article.classList.add('draggable');
  const accent = el('span', `card-accent status-${card.sourceStatus === 'ПОТРЕБУЄ СЕРВІСУ' ? 'service' : 'repair'}`);
  const labels = card.cardLabels || [];
  const labelBars = el('div', 'maintenance-card-label-bars');
  labelBars.setAttribute('aria-label', `Мітки: ${labels.map((label) => label.name).join(', ')}`);
  labels.forEach((label) => {
    const bar = el('span', 'maintenance-card-label-bar');
    bar.style.setProperty('--card-status-color', label.color);
    bar.title = label.name;
    labelBars.append(bar);
  });
  const asset = el('span', 'maintenance-card-asset', card.asset);
  const title = el('h3', '', card.boardIdentifier);
  const status = el('span', 'source-status', card.sourceStatus);
  const meta = el('div', 'maintenance-card-meta');
  meta.append(status);
  (card.cardStatuses || []).forEach((cardStatus) => {
    const chip = el('span', 'card-custom-status');
    chip.style.setProperty('--card-status-color', cardStatus.color);
    chip.title = cardStatus.name;
    chip.append(el('span', 'card-custom-status-label', cardStatus.name));
    meta.append(chip);
  });
  if (card.reportNumber) meta.append(el('span', 'report-indicator', `Рапорт № ${card.reportNumber}`));
  if (card.notes) meta.append(el('span', 'notes-indicator', 'Примітка'));
  article.append(accent);
  if (labels.length) article.append(labelBars);
  article.append(asset, title, meta);
  article.addEventListener('click', () => {
    if (!state.dragging?.moved) openCard(card.id);
  });
  article.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCard(card.id);
    }
  });
  if (state.data.canEdit) article.addEventListener('pointerdown', beginPointerDrag);
  return article;
}

function renderBoard() {
  const cards = filteredCards();
  const lanes = state.data.lanes.map((lane) => {
    const laneNode = el('section', 'maintenance-lane');
    laneNode.dataset.lane = lane.key;
    laneNode.style.setProperty('--lane-color', lane.color || '#f26430');
    const laneCards = cards.filter((card) => card.lane === lane.key);
    const heading = el('header', 'maintenance-lane-heading');
    heading.append(el('span', 'lane-color-mark'), el('h2', '', lane.title), el('span', 'lane-count', String(laneCards.length)));
    const list = el('div', 'maintenance-list');
    list.append(...laneCards.map(cardNode));
    if (!laneCards.length) list.append(el('p', 'lane-empty', 'Немає бортів'));
    laneNode.append(heading, list);
    return laneNode;
  });
  board.replaceChildren(...lanes);
}

function renderSyncState() {
  const sync = state.data.sync;
  const label = sync.failed
    ? `Помилки синхронізації: ${sync.failed}`
    : sync.pending
      ? `Очікує запису в Облік: ${sync.pending}`
      : `Облік оновлено: ${kyivTime(sync.lastAt)}`;
  const node = document.querySelector('#sync-state');
  node.textContent = label;
  node.classList.toggle('error', sync.failed > 0);
  node.classList.toggle('pending', sync.pending > 0 && !sync.failed);
}

function detailRow(term, value, className = '') {
  const row = document.createElement('div');
  if (className) row.className = className;
  row.append(el('dt', '', term), el('dd', '', value || '—'));
  return row;
}

function renderCardStatusOptions(card) {
  const fieldset = document.querySelector('#card-status-fieldset');
  const container = document.querySelector('#card-status-list');
  const availableStatuses = state.data.cardStatuses || [];
  const selectedIds = new Set((card.cardStatuses || []).map((status) => status.id));
  const visibleStatuses = state.data.canEdit
    ? availableStatuses
    : availableStatuses.filter((status) => selectedIds.has(status.id));
  fieldset.classList.toggle('hidden', visibleStatuses.length === 0);
  fieldset.disabled = !state.data.canEdit;
  if (state.cardDirty) return;
  const options = visibleStatuses.map((status) => {
    const label = el('label', 'maintenance-card-status-option');
    label.style.setProperty('--card-status-color', status.color);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(status.id);
    input.checked = selectedIds.has(status.id);
    const mark = el('span', 'maintenance-card-status-mark');
    label.append(input, mark, el('span', '', status.name));
    return label;
  });
  container.replaceChildren(...options);
}

function renderCardLabelOptions(card) {
  const fieldset = document.querySelector('#card-label-fieldset');
  const container = document.querySelector('#card-label-list');
  const availableLabels = state.data.cardLabels || [];
  const selectedIds = new Set((card.cardLabels || []).map((label) => label.id));
  const visibleLabels = state.data.canEdit
    ? availableLabels
    : availableLabels.filter((label) => selectedIds.has(label.id));
  fieldset.classList.toggle('hidden', visibleLabels.length === 0);
  fieldset.disabled = !state.data.canEdit;
  if (state.cardDirty) return;
  const options = visibleLabels.map((cardLabel) => {
    const label = el('label', 'maintenance-card-status-option');
    label.style.setProperty('--card-status-color', cardLabel.color);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(cardLabel.id);
    input.checked = selectedIds.has(cardLabel.id);
    const mark = el('span', 'maintenance-card-status-mark maintenance-card-label-mark');
    label.append(input, mark, el('span', '', cardLabel.name));
    return label;
  });
  container.replaceChildren(...options);
}

function syncCardDirty() {
  const card = state.data?.cards.find((item) => item.id === state.selectedId);
  if (!card) return;
  const savedStatusIds = (card.cardStatuses || []).map((status) => status.id).sort((left, right) => left - right);
  const selectedStatusIds = [...document.querySelectorAll('#card-status-list input:checked')]
    .map((input) => Number(input.value))
    .sort((left, right) => left - right);
  const savedLabelIds = (card.cardLabels || []).map((label) => label.id).sort((left, right) => left - right);
  const selectedLabelIds = [...document.querySelectorAll('#card-label-list input:checked')]
    .map((input) => Number(input.value))
    .sort((left, right) => left - right);
  state.cardDirty = document.querySelector('#card-notes').value !== card.notes
    || (module === 'service' && document.querySelector('#card-report-number').value !== card.reportNumber)
    || savedStatusIds.length !== selectedStatusIds.length
    || savedStatusIds.some((statusId, index) => statusId !== selectedStatusIds[index])
    || savedLabelIds.length !== selectedLabelIds.length
    || savedLabelIds.some((labelId, index) => labelId !== selectedLabelIds[index]);
  document.querySelector('#save-card').classList.toggle('unsaved', state.cardDirty);
}

function renderOpenCard() {
  const card = state.data.cards.find((item) => item.id === state.selectedId);
  if (!card) return closeCard(true);
  document.querySelector('#card-status').textContent = laneTitle(card.lane).toLocaleUpperCase('uk-UA');
  document.querySelector('#card-title').textContent = `${card.asset} · ${card.boardIdentifier}`;
  document.querySelector('#card-details').replaceChildren(
    detailRow('Статус в Обліку', card.sourceStatus),
    detailRow('Засіб', card.asset),
    detailRow('Номер борту', card.boardIdentifier),
    detailRow('Ідентифікатори', card.identifiers.join(' · ')),
    detailRow('Коментар з Обліку', card.sourceComment, 'maintenance-source-comment')
  );
  const notes = document.querySelector('#card-notes');
  if (!state.cardDirty) notes.value = card.notes;
  notes.disabled = !state.data.canEdit;
  const reportField = document.querySelector('#card-report-field');
  const reportNumber = document.querySelector('#card-report-number');
  reportField.classList.toggle('hidden', module !== 'service');
  if (!state.cardDirty) reportNumber.value = card.reportNumber || '';
  reportNumber.disabled = !state.data.canEdit || module !== 'service';
  renderCardStatusOptions(card);
  renderCardLabelOptions(card);
  const saveButton = document.querySelector('#save-card');
  saveButton.classList.toggle('hidden', !state.data.canEdit);
  saveButton.classList.toggle('unsaved', state.cardDirty);
  const events = card.events.filter((event) => event.action === 'lane.change').map((event) => {
    const item = el('article', 'history-item');
    item.append(
      el('time', '', kyivTime(event.createdAt)),
      el('strong', '', `${laneTitle(event.fromLane)} → ${laneTitle(event.toLane)}`),
      el('span', '', event.actorEmail)
    );
    return item;
  });
  document.querySelector('#card-history').replaceChildren(
    ...(events.length ? events : [el('p', 'lane-empty', 'Переміщень ще не було')])
  );
}

function openCard(id) {
  state.selectedId = id;
  state.cardDirty = false;
  renderOpenCard();
  dialog.classList.remove('hidden');
  document.body.classList.add('dialog-open');
}

function closeCard(force = false) {
  if (!force && state.cardDirty && !window.confirm('Закрити картку без збереження змін?')) return;
  state.selectedId = null;
  state.cardDirty = false;
  dialog.classList.add('hidden');
  document.body.classList.remove('dialog-open');
}

async function saveCard() {
  const button = document.querySelector('#save-card');
  button.disabled = true;
  try {
    const updated = await api(`/api/maintenance/${module}/cards/${state.selectedId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        notes: document.querySelector('#card-notes').value,
        ...(module === 'service' ? { reportNumber: document.querySelector('#card-report-number').value } : {}),
        cardStatusIds: [...document.querySelectorAll('#card-status-list input:checked')]
          .map((input) => Number(input.value)),
        cardLabelIds: [...document.querySelectorAll('#card-label-list input:checked')]
          .map((input) => Number(input.value))
      })
    });
    const index = state.data.cards.findIndex((card) => card.id === updated.id);
    state.data.cards[index] = updated;
    state.cardDirty = false;
    renderBoard();
    renderOpenCard();
    showToast('Зміни збережено');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

function beginPointerDrag(event) {
  if (state.movePending || event.button !== 0 || event.target.closest('button, input, textarea, select, a')) return;
  const card = event.currentTarget;
  const point = { x: event.clientX, y: event.clientY };
  const drag = {
    pointerId: event.pointerId,
    source: card,
    cardId: Number(card.dataset.cardId),
    startX: point.x,
    startY: point.y,
    moved: false,
    timer: null,
    clone: null,
    placeholder: null,
    offsetX: 0,
    offsetY: 0
  };
  state.dragging = drag;
  card.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch') drag.timer = setTimeout(() => startDrag(drag, point), 240);
  card.addEventListener('pointermove', pointerMove);
  card.addEventListener('pointerup', finishPointerDrag, { once: true });
  card.addEventListener('pointercancel', cancelPointerDrag, { once: true });
}

function startDrag(drag, point) {
  if (drag.moved) return;
  const rect = drag.source.getBoundingClientRect();
  drag.moved = true;
  drag.offsetX = point.x - rect.left;
  drag.offsetY = point.y - rect.top;
  drag.placeholder = el('div', 'card-placeholder');
  drag.placeholder.style.height = `${rect.height}px`;
  drag.clone = drag.source.cloneNode(true);
  drag.clone.classList.add('drag-preview');
  drag.clone.style.width = `${rect.width}px`;
  drag.source.before(drag.placeholder);
  drag.source.classList.add('drag-source');
  document.body.append(drag.clone);
  positionPreview(drag, point.x, point.y);
  if (navigator.vibrate) navigator.vibrate(25);
}

function positionPreview(drag, x, y) {
  drag.clone.style.transform = `translate3d(${x - drag.offsetX}px, ${y - drag.offsetY}px, 0) rotate(1deg)`;
}

function pointerMove(event) {
  const drag = state.dragging;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.moved && event.pointerType !== 'touch' && distance > 6) startDrag(drag, { x: event.clientX, y: event.clientY });
  if (!drag.moved && event.pointerType === 'touch' && distance > 10) {
    clearTimeout(drag.timer);
    return;
  }
  if (!drag.moved) return;
  event.preventDefault();
  positionPreview(drag, event.clientX, event.clientY);
  drag.clone.style.display = 'none';
  const target = document.elementFromPoint(event.clientX, event.clientY);
  drag.clone.style.display = '';
  const lane = target?.closest('.maintenance-lane');
  if (!lane) return;
  const list = lane.querySelector('.maintenance-list');
  const candidates = [...list.querySelectorAll('.maintenance-card:not(.drag-source)')];
  const before = candidates.find((candidate) => event.clientY < candidate.getBoundingClientRect().top + candidate.offsetHeight / 2);
  if (before) list.insertBefore(drag.placeholder, before);
  else list.append(drag.placeholder);
  list.querySelector('.lane-empty')?.remove();
}

async function finishPointerDrag(event) {
  const drag = state.dragging;
  cleanupPointerListeners(drag);
  if (!drag?.moved) {
    state.dragging = null;
    return;
  }
  event.preventDefault();
  const lane = drag.placeholder.closest('.maintenance-lane')?.dataset.lane;
  let next = drag.placeholder.nextElementSibling;
  while (next && (!next.classList.contains('maintenance-card') || Number(next.dataset.cardId) === drag.cardId)) {
    next = next.nextElementSibling;
  }
  const beforeCardId = next ? Number(next.dataset.cardId) : null;
  if (!lane) {
    cleanupDragVisuals(drag);
    state.dragging = { moved: true };
    setTimeout(() => { state.dragging = null; }, 0);
    renderBoard();
    return;
  }
  const previousCards = state.data.cards;
  state.movePending += 1;
  state.mutationVersion += 1;
  applyOptimisticMove(drag.cardId, lane, beforeCardId);
  cleanupDragVisuals(drag);
  state.dragging = { moved: true };
  setTimeout(() => { state.dragging = null; }, 0);
  renderBoard();
  try {
    const updated = await api(`/api/maintenance/${module}/cards/${drag.cardId}/move`, {
      method: 'POST', body: JSON.stringify({ lane, beforeCardId })
    });
    const index = state.data.cards.findIndex((card) => card.id === updated.id);
    state.data.cards[index] = updated;
    renderBoard();
  } catch (error) {
    state.data.cards = previousCards;
    renderBoard();
    showToast(error.message, true);
  } finally {
    state.movePending = Math.max(0, state.movePending - 1);
    await loadBoard({ quiet: true });
  }
}

function applyOptimisticMove(cardId, lane, beforeCardId) {
  const card = state.data.cards.find((item) => item.id === cardId);
  if (!card || !lane) return;
  const cards = state.data.cards.filter((item) => item.id !== cardId);
  const moved = { ...card, lane };
  const beforeIndex = beforeCardId ? cards.findIndex((item) => item.id === beforeCardId) : -1;
  cards.splice(beforeIndex >= 0 ? beforeIndex : cards.length, 0, moved);
  state.data.cards = cards;
}

function cancelPointerDrag() {
  const drag = state.dragging;
  cleanupPointerListeners(drag);
  clearTimeout(drag?.timer);
  cleanupDragVisuals(drag);
  state.dragging = null;
  renderBoard();
}

function cleanupPointerListeners(drag) {
  drag?.source.removeEventListener('pointermove', pointerMove);
}

function cleanupDragVisuals(drag) {
  drag?.clone?.remove();
  drag?.placeholder?.remove();
  drag?.source?.classList.remove('drag-source');
}

async function loadBoard({ quiet = false } = {}) {
  if (state.boardLoading) return;
  state.boardLoading = true;
  const mutationVersion = state.mutationVersion;
  try {
    const data = await api(`/api/maintenance/${module}`);
    if (quiet && (mutationVersion !== state.mutationVersion || state.movePending || state.dragging?.moved)) return;
    state.data = data;
    document.title = `LABA — ${data.title}`;
    document.querySelector('#page-title').textContent = data.title;
    renderAssetFilter();
    renderLabelLegend();
    renderBoard();
    renderSyncState();
    if (state.selectedId) renderOpenCard();
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  } finally {
    state.boardLoading = false;
  }
}

function scheduleBoardRefresh(delay) {
  clearTimeout(state.refreshTimer);
  const nextDelay = delay ?? (state.data?.sync?.pending ? 2500 : 8000);
  state.refreshTimer = setTimeout(async () => {
    if (!state.dragging && !state.movePending && !state.cardDirty && document.visibilityState === 'visible') {
      await loadBoard({ quiet: true });
    }
    scheduleBoardRefresh();
  }, nextDelay);
}

async function refreshVisibleBoard() {
  if (document.visibilityState !== 'visible' || state.dragging || state.movePending || state.cardDirty) return;
  await loadBoard({ quiet: true });
  scheduleBoardRefresh();
}

document.querySelectorAll('[data-close-dialog]').forEach((node) => node.addEventListener('click', () => closeCard()));
document.querySelector('#card-notes').addEventListener('input', () => {
  syncCardDirty();
});
document.querySelector('#card-report-number').addEventListener('input', () => {
  syncCardDirty();
});
document.querySelector('#card-status-list').addEventListener('change', () => {
  syncCardDirty();
});
document.querySelector('#card-label-list').addEventListener('change', () => {
  syncCardDirty();
});
document.querySelector('#save-card').addEventListener('click', saveCard);
function syncSearchClearButton() {
  clearSearch.hidden = search.value.length === 0;
}

function clearSearchValue() {
  if (!search.value) return;
  search.value = '';
  syncSearchClearButton();
  renderBoard();
  search.focus();
}

search.addEventListener('input', () => {
  syncSearchClearButton();
  renderBoard();
});
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && search.value) {
    event.preventDefault();
    event.stopPropagation();
    clearSearchValue();
  }
});
clearSearch.addEventListener('click', clearSearchValue);
assetFilter.addEventListener('change', renderBoard);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.classList.contains('hidden')) closeCard(); });
document.addEventListener('visibilitychange', refreshVisibleBoard);
window.addEventListener('focus', refreshVisibleBoard);

async function start() {
  try {
    syncSearchClearButton();
    state.me = await api('/api/me');
    document.querySelector('#identity-name').textContent = state.me.displayName || state.me.email;
    await loadBoard();
    scheduleBoardRefresh();
  } catch (error) { showToast(error.message, true); }
}

start();
