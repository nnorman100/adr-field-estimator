/* Address suggestions and the job map. Both come from the backend (/api/places/*), which holds the
   Maps key, so the browser never loads a Google script or image. With no connection, no key or no
   permission the address stays a plain text box; roles without lookup access see only directions.
   With no connection or key the map says it is unavailable; a job saved
   before this existed has no coordinates and shows only the directions link. */
window.PlacesUI = (() => {
  const MIN_CHARS = 4,
    DEBOUNCE_MS = 350,
    CACHE_LIMIT = 8;
  const field = () => $('address'),
    list = () => $('addressSuggestions');
  let session = newSession(),
    run = 0,
    timer = null,
    off = false,
    pausedUntil = 0,
    retryTimer = null,
    items = [],
    highlighted = -1,
    shownFor = null;
  // Map images already fetched this page load, by rounded coordinates; revoked oldest first.
  const images = new Map();
  // Fetches in flight ('loading') and ones that failed ('failed'), by the same key.
  const fetches = new Map();

  function newSession() {
    return globalThis.crypto?.randomUUID?.() || 'p' + Math.random().toString(36).slice(2, 12);
  }
  // Suggestions only help a technician who can edit this draft, with a connection, until the
  // server says the feature is unavailable.
  const active = () =>
    canEditDraft('places') && navigator.onLine && !off && Date.now() >= pausedUntil;
  const placed = () => {
    const data = state.draft?.data;
    return data?.coordinates && data.coordinates.address === data.address ? data.coordinates : null;
  };
  const coordKey = (c) => c.latitude.toFixed(6) + ',' + c.longitude.toFixed(6);

  function hide() {
    items = [];
    highlighted = -1;
    list().hidden = true;
    list().replaceChildren();
    field().setAttribute('aria-expanded', 'false');
    field().removeAttribute('aria-activedescendant');
  }
  function setHint(text) {
    $('addressHint').textContent = text;
    $('addressHint').hidden = !text;
  }
  function show(suggestions) {
    items = suggestions;
    highlighted = -1;
    list().replaceChildren(
      ...suggestions.map((suggestion, index) => {
        const option = document.createElement('li');
        option.id = 'addressOption' + index;
        option.setAttribute('role', 'option');
        option.textContent = suggestion.text;
        // Keep focus in the field so choosing never ends the typing session first.
        option.addEventListener('mousedown', (e) => e.preventDefault());
        option.addEventListener('click', () => choose(index).catch(report));
        return option;
      }),
    );
    list().hidden = !suggestions.length;
    field().setAttribute('aria-expanded', String(suggestions.length > 0));
  }
  function highlight(index) {
    highlighted = (index + items.length) % items.length;
    [...list().children].forEach((option, i) =>
      option.setAttribute('aria-selected', String(i === highlighted)),
    );
    field().setAttribute('aria-activedescendant', 'addressOption' + highlighted);
  }
  function report(error) {
    say(error.message, 'error');
  }

  function failed(error) {
    hide();
    if (error.status === 429)
      setHint('Address suggestions are paused for now. Keep typing the address.');
    if ([403, 503].includes(error.status)) off = true;
    if ([429, 502].includes(error.status)) {
      const seconds = Number(error.retryAfter);
      pausedUntil = Math.max(
        pausedUntil,
        Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000,
      );
      clearTimeout(retryTimer);
      retryTimer = setTimeout(resume, pausedUntil - Date.now());
    }
    render();
  }
  function typed() {
    clearTimeout(timer);
    hide();
    setHint('');
    const text = field().value.trim(),
      mine = ++run;
    if (!active() || text.length < MIN_CHARS) return;
    timer = setTimeout(async () => {
      try {
        const found = await jsonApi('/api/places/autocomplete', 'POST', { input: text, session });
        if (mine === run && active()) show(found.suggestions);
      } catch (error) {
        if (mine === run) failed(error);
      }
    }, DEBOUNCE_MS);
  }
  async function choose(index) {
    const pick = items[index],
      draft = state.draft;
    if (!pick || !active()) return;
    const mine = ++run;
    hide();
    let place;
    try {
      place = await jsonApi('/api/places/details', 'POST', {
        place_id: pick.place_id,
        session,
      });
    } catch (error) {
      if (mine === run) failed(error);
      return;
    }
    session = newSession();
    // The technician may have opened another job or changed the field while the lookup ran.
    if (mine !== run || draft !== state.draft || !canEditDraft('places')) return;
    field().value = place.address;
    collect();
    state.draft.data.coordinates = {
      latitude: place.latitude,
      longitude: place.longitude,
      address: state.draft.data.address,
    };
    changed(true);
    render();
    field().focus();
  }
  function keys(event) {
    if (!items.length) return;
    if (event.key === 'ArrowDown') highlight(highlighted + 1);
    else if (event.key === 'ArrowUp') highlight(highlighted - 1);
    else if (event.key === 'Enter' && highlighted >= 0) choose(highlighted).catch(report);
    else if (event.key === 'Escape') hide();
    else return;
    event.preventDefault();
  }

  function remember(key, url) {
    images.set(key, url);
    while (images.size > CACHE_LIMIT) {
      const [oldest, stale] = images.entries().next().value;
      images.delete(oldest);
      URL.revokeObjectURL(stale);
    }
  }
  async function loadMap(coordinates) {
    const key = coordKey(coordinates);
    fetches.set(key, 'loading');
    try {
      const response = await api('/api/places/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: coordinates.latitude, longitude: coordinates.longitude }),
      });
      remember(key, URL.createObjectURL(await response.blob()));
      fetches.delete(key);
    } catch (error) {
      failed(error);
      fetches.set(key, 'failed');
    }
    render();
  }
  // The directions link is keyless: it only opens the phone's maps app or Google Maps.
  function directions(address, coordinates) {
    const destination = coordinates
      ? coordinates.latitude + ',' + coordinates.longitude
      : address.trim();
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(destination);
  }
  function render() {
    const draftId = state.draft?.inspection_id ?? null;
    if (shownFor !== draftId) {
      shownFor = draftId;
      ++run;
      hide();
      setHint('');
    }
    const data = state.draft?.data,
      address = (data?.address || '').trim(),
      coordinates = placed(),
      panel = $('jobMap');
    field().setAttribute('autocomplete', active() ? 'off' : 'street-address');
    panel.hidden = !address;
    if (!address) return;
    $('jobDirections').href = directions(address, coordinates);
    const image = $('jobMapImage'),
      status = $('jobMapStatus');
    // A job saved before coordinates existed, or a role without lookup access, has no map.
    const mapped = !!coordinates && (!window.WorkspaceUI?.enabled() || WorkspaceUI.can('places'));
    image.hidden = status.hidden = true;
    if (!mapped) {
      if (
        Object.hasOwn(data, 'coordinates') &&
        (!window.WorkspaceUI?.enabled() || WorkspaceUI.can('places')) &&
        (!navigator.onLine || off)
      ) {
        status.hidden = false;
        status.textContent = 'Map unavailable offline';
      }
      return;
    }
    status.hidden = false;
    const key = coordKey(coordinates);
    if (!navigator.onLine) {
      status.textContent = 'Map unavailable offline';
    } else if (images.has(key)) {
      image.src = images.get(key);
      image.hidden = false;
      status.hidden = true;
    } else if (off || Date.now() < pausedUntil || fetches.get(key) === 'failed') {
      status.textContent = 'Map unavailable offline';
    } else {
      status.textContent = 'Loading map…';
      if (!fetches.has(key)) loadMap(coordinates);
    }
  }
  function resume() {
    if (Date.now() < pausedUntil) return;
    for (const [key, status] of fetches) if (status === 'failed') fetches.delete(key);
    render();
    typed();
  }
  function init() {
    field().setAttribute('role', 'combobox');
    field().setAttribute('aria-autocomplete', 'list');
    field().setAttribute('aria-controls', 'addressSuggestions');
    field().setAttribute('aria-expanded', 'false');
    field().addEventListener('input', typed);
    field().addEventListener('keydown', keys);
    field().addEventListener('blur', () => setTimeout(hide, 150));
    window.addEventListener('online', resume);
    window.addEventListener('offline', () => {
      hide();
      render();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  return { render };
})();
