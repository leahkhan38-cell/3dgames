const JFK = [40.6413, -73.7781];
const REFRESH_MS = 10_000;
const METERS_TO_FEET = 3.28084;
const METERS_PER_SECOND_TO_KNOTS = 1.94384;
const THREE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
  worldCopyJump: true,
  minZoom: 2,
}).setView([39.2, -75.1], 5);

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  maxZoom: 19,
  crossOrigin: true,
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: true, metric: true }).addTo(map);
map.createPane('aircraft');
map.getPane('aircraft').style.zIndex = '620';

const mapElement = document.querySelector('#map');
const listElement = document.querySelector('#flight-list');
const searchInput = document.querySelector('#callsign-search');
const selectedPanel = document.querySelector('#flight-detail');
const stateStore = new Map();
const fallbackMarkers = new Map();
const aircraftMeshes = [];
let aircraftRenderer = null;
let aircraftScene = null;
let aircraftCamera = null;
let THREE = null;
let rendererWidth = 0;
let rendererHeight = 0;
let selectedId = null;
let loading = false;
let searchTimer;
let pollTimer;
let lastUpdated = null;
let totalReceived = 0;

function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value) : '—';
}

function formatAltitude(meters) {
  return Number.isFinite(meters) ? `${formatNumber(meters * METERS_TO_FEET)} ft` : '—';
}

function formatSpeed(metersPerSecond) {
  return Number.isFinite(metersPerSecond) ? `${formatNumber(metersPerSecond * METERS_PER_SECOND_TO_KNOTS)} kt` : '—';
}

function parseState(state) {
  const id = String(state[0] || '').toLowerCase();
  const latitude = state[6];
  const longitude = state[5];
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    id,
    callsign: String(state[1] || '').trim().toUpperCase() || id.toUpperCase(),
    country: String(state[2] || 'Unknown').trim(),
    longitude,
    latitude,
    altitude: Number.isFinite(state[7]) ? state[7] : Number.isFinite(state[13]) ? state[13] : null,
    onGround: Boolean(state[8]),
    speed: Number.isFinite(state[9]) ? state[9] : null,
    track: Number.isFinite(state[10]) ? state[10] : 0,
    lastContact: Number.isFinite(state[4]) ? state[4] : null,
    squawk: state[14] ? String(state[14]) : '—',
    updated: Date.now(),
  };
}

function createPlaneIcon(track) {
  return L.divIcon({
    className: 'aircraft-icon',
    html: `<span class="plane-mark" style="--track:${track}deg"><span></span></span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function extrudedShape(points, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.012,
    bevelThickness: 0.012,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

function addAircraftPart(geometry, color, metalness = 0.48, roughness = 0.38) {
  const material = new THREE.MeshStandardMaterial({ color, metalness, roughness, flatShading: true });
  const mesh = new THREE.InstancedMesh(geometry, material, 60_000);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  aircraftMeshes.push(mesh);
  aircraftScene.add(mesh);
}

async function setupAircraftRenderer() {
  THREE = await import(THREE_MODULE_URL);
  aircraftScene = new THREE.Scene();
  aircraftCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  aircraftCamera.position.set(0, 0, 180);
  aircraftCamera.lookAt(0, 0, 0);
  aircraftRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  aircraftRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  aircraftRenderer.setClearColor(0x000000, 0);
  aircraftRenderer.outputColorSpace = THREE.SRGBColorSpace;
  aircraftRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  aircraftRenderer.toneMappingExposure = 1.15;
  aircraftRenderer.domElement.className = 'aircraft-renderer';
  mapElement.appendChild(aircraftRenderer.domElement);

  const ambient = new THREE.HemisphereLight(0xe9f1ff, 0x55584e, 2.2);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
  keyLight.position.set(-18, 24, 35);
  aircraftScene.add(ambient, keyLight);

  const fuselage = new THREE.CylinderGeometry(0.012, 0.078, 1.45, 12, 1);
  fuselage.translate(0, 0.045, 0.025);
  addAircraftPart(fuselage, 0xdce0d9, 0.72, 0.29);

  const nose = new THREE.CylinderGeometry(0, 0.041, 0.39, 12, 1);
  nose.translate(0, 0.91, 0.025);
  addAircraftPart(nose, 0xeff0e9, 0.62, 0.26);

  const wings = extrudedShape([
    [-0.11, 0.32], [-0.35, 0.29], [-1.28, -0.07], [-1.23, -0.23],
    [-0.14, -0.035], [0.14, -0.035], [1.23, -0.23], [1.28, -0.07],
    [0.35, 0.29], [0.11, 0.32],
  ], 0.075);
  wings.translate(0, 0, 0.005);
  addAircraftPart(wings, 0xbfc7c5, 0.63, 0.34);

  const tailplane = extrudedShape([
    [-0.07, -0.61], [-0.51, -0.76], [-0.47, -0.9], [-0.07, -0.81],
    [0.07, -0.81], [0.47, -0.9], [0.51, -0.76], [0.07, -0.61],
  ], 0.065);
  tailplane.translate(0, 0, 0.015);
  addAircraftPart(tailplane, 0xe0e1d8, 0.56, 0.37);

  const fin = extrudedShape([
    [0, -0.91], [0, -0.63], [0.31, -0.76], [0.19, -0.89],
  ], 0.09);
  fin.rotateY(-Math.PI / 2);
  fin.translate(0, 0, 0.07);
  addAircraftPart(fin, 0xd6d7cc, 0.53, 0.36);

  for (const side of [-1, 1]) {
    const engine = new THREE.CylinderGeometry(0.045, 0.057, 0.37, 10, 1);
    engine.translate(side * 0.48, 0.015, -0.055);
    addAircraftPart(engine, 0x767e7c, 0.78, 0.31);
  }

  const canopy = new THREE.SphereGeometry(1, 10, 7);
  canopy.scale(0.058, 0.19, 0.035);
  canopy.translate(0, 0.42, 0.074);
  addAircraftPart(canopy, 0x34495a, 0.82, 0.2);

  const redLight = new THREE.SphereGeometry(0.04, 8, 6);
  redLight.translate(-1.24, -0.12, 0.06);
  addAircraftPart(redLight, 0xff554a, 0.18, 0.22);
  const greenLight = new THREE.SphereGeometry(0.04, 8, 6);
  greenLight.translate(1.24, -0.12, 0.06);
  addAircraftPart(greenLight, 0x75e6a2, 0.18, 0.22);
  updateMarkers();
}

function renderAircraft(flights) {
  if (!aircraftRenderer || !flights.length) {
    aircraftMeshes.forEach((mesh) => { mesh.count = 0; });
    aircraftRenderer?.render(aircraftScene, aircraftCamera);
    return;
  }

  const { x: width, y: height } = map.getSize();
  if (width !== rendererWidth || height !== rendererHeight) {
    aircraftRenderer.setSize(width, height, false);
    rendererWidth = width;
    rendererHeight = height;
    aircraftCamera.left = -width / 2;
    aircraftCamera.right = width / 2;
    aircraftCamera.top = height / 2;
    aircraftCamera.bottom = -height / 2;
    aircraftCamera.updateProjectionMatrix();
  }

  const scale = THREE.MathUtils.clamp(3 + map.getZoom() * 0.9, 5, 17);
  const transform = new THREE.Object3D();
  const count = Math.min(flights.length, aircraftMeshes[0]?.instanceMatrix.count || 0);
  for (let index = 0; index < count; index += 1) {
    const flight = flights[index];
    const point = map.latLngToContainerPoint([flight.latitude, flight.longitude]);
    transform.position.set(point.x - width / 2, height / 2 - point.y, 0);
    transform.rotation.set(0, 0, -flight.track * Math.PI / 180);
    transform.scale.setScalar(flight.id === selectedId ? scale * 1.24 : scale);
    transform.updateMatrix();
    aircraftMeshes.forEach((mesh) => mesh.setMatrixAt(index, transform.matrix));
  }
  aircraftMeshes.forEach((mesh) => {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });
  aircraftRenderer.render(aircraftScene, aircraftCamera);
}

function inView(flight) {
  return map.getBounds().contains([flight.latitude, flight.longitude]);
}

function getVisibleFlights() {
  return [...stateStore.values()].filter(inView);
}

function renderFlightDetails(flight) {
  document.querySelector('#detail-callsign').textContent = flight.callsign;
  document.querySelector('#detail-origin').textContent = flight.country;
  document.querySelector('#detail-altitude').textContent = flight.onGround ? 'On ground' : formatAltitude(flight.altitude);
  document.querySelector('#detail-speed').textContent = formatSpeed(flight.speed);
  document.querySelector('#detail-latitude').textContent = flight.latitude.toFixed(4);
  document.querySelector('#detail-longitude').textContent = flight.longitude.toFixed(4);
  document.querySelector('#detail-track').textContent = `${formatNumber(flight.track)}°`;
  document.querySelector('#detail-squawk').textContent = flight.squawk;
}

function openFlight(flight) {
  selectedId = flight.id;
  renderFlightDetails(flight);
  selectedPanel.classList.add('visible');
  selectedPanel.setAttribute('aria-hidden', 'false');
  map.flyTo([flight.latitude, flight.longitude], Math.max(map.getZoom(), 7), { duration: 1.1 });
  renderFlightList();
}

function closeFlight() {
  selectedId = null;
  selectedPanel.classList.remove('visible');
  selectedPanel.setAttribute('aria-hidden', 'true');
  renderFlightList();
}

function updateMarkers() {
  const visible = getVisibleFlights();
  if (aircraftRenderer) {
    renderAircraft(visible);
    for (const marker of fallbackMarkers.values()) map.removeLayer(marker);
    fallbackMarkers.clear();
  } else {
    const visibleIds = new Set(visible.map((flight) => flight.id));
    visible.forEach((flight) => {
      let marker = fallbackMarkers.get(flight.id);
      if (!marker) {
        marker = L.marker([flight.latitude, flight.longitude], {
          icon: createPlaneIcon(flight.track),
          keyboard: true,
          title: `${flight.callsign} · ${flight.country}`,
          riseOnHover: true,
        }).addTo(map);
        marker.on('click', () => {
          const current = stateStore.get(flight.id);
          if (current) openFlight(current);
        });
        fallbackMarkers.set(flight.id, marker);
      } else {
        marker.setLatLng([flight.latitude, flight.longitude]);
        const plane = marker.getElement()?.querySelector('.plane-mark');
        if (plane) plane.style.setProperty('--track', `${flight.track}deg`);
      }
    });

    for (const [id, marker] of fallbackMarkers) {
      if (!visibleIds.has(id)) {
        map.removeLayer(marker);
        fallbackMarkers.delete(id);
      }
    }
  }
  updateAnalytics(visible);
  renderFlightList();
}

function redrawAircraft() {
  if (aircraftRenderer) renderAircraft(getVisibleFlights());
}

function selectAircraftAt(latlng) {
  if (!aircraftRenderer) return;
  const click = map.latLngToContainerPoint(latlng);
  const scale = THREE.MathUtils.clamp(3 + map.getZoom() * 0.9, 5, 17);
  let closest = null;
  let closestDistance = Math.max(12, scale * 1.5);

  getVisibleFlights().forEach((flight) => {
    const point = map.latLngToContainerPoint([flight.latitude, flight.longitude]);
    const distance = point.distanceTo(click);
    if (distance < closestDistance) {
      closest = flight;
      closestDistance = distance;
    }
  });
  if (closest) openFlight(closest);
}

function updateAnalytics(visible = getVisibleFlights()) {
  const airborne = visible.filter((flight) => !flight.onGround);
  const highest = airborne.reduce((maximum, flight) => Math.max(maximum, flight.altitude ?? 0), 0);
  document.querySelector('#active-count').textContent = formatNumber(visible.length);
  document.querySelector('#altitude-value').textContent = highest > 0 ? `${formatNumber(highest * METERS_TO_FEET / 1000, 1)}k` : '—';
  document.querySelector('#visible-count').textContent = `${formatNumber(visible.length)} visible`;
  document.querySelector('#tracked-count').textContent = `${formatNumber(totalReceived)} tracked globally`;
  document.querySelector('#tracked-map').textContent = formatNumber(totalReceived);
}

function renderFlightList() {
  const query = searchInput.value.trim().toUpperCase();
  const visible = getVisibleFlights()
    .filter((flight) => !query || flight.callsign.includes(query))
    .sort((first, second) => Number(second.id === selectedId) - Number(first.id === selectedId) || (second.altitude ?? -1) - (first.altitude ?? -1))
    .slice(0, 60);

  if (query && !visible.length) {
    listElement.innerHTML = '<div class="list-empty">No callsign in this view.</div>';
    return;
  }
  if (!visible.length) {
    listElement.innerHTML = '<div class="list-empty">Waiting for aircraft data…</div>';
    return;
  }

  listElement.innerHTML = visible.map((flight) => `
    <button class="flight-row${flight.id === selectedId ? ' current' : ''}" data-flight="${flight.id}" type="button">
      <span class="row-plane"><span class="plane-mark small" style="--track:${flight.track}deg"><span></span></span></span>
      <span class="row-main"><strong>${escapeHtml(flight.callsign)}</strong><small>${escapeHtml(flight.country)}</small></span>
      <span class="row-alt">${flight.onGround ? 'GROUND' : formatAltitude(flight.altitude)}</span>
    </button>`).join('');
  listElement.querySelectorAll('[data-flight]').forEach((button) => button.addEventListener('click', () => {
    const flight = stateStore.get(button.dataset.flight);
    if (flight) openFlight(flight);
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function updateStatus(message, mode = 'live') {
  document.querySelector('#connection-label').textContent = message;
  document.querySelector('#connection').dataset.state = mode;
  document.querySelector('#top-connection').dataset.state = mode;
  document.querySelector('#top-connection-label').textContent = mode === 'live' ? 'LIVE' : 'OFFLINE';
}

function updateClock() {
  document.querySelector('#local-clock').textContent = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false,
  }).format(new Date());
  if (lastUpdated) {
    const seconds = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
    document.querySelector('#last-update').textContent = seconds < 2 ? 'just now' : `${seconds}s ago`;
  }
}

async function pollFlights() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/flights', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `OpenSky returned ${response.status}`);
    const states = Array.isArray(payload.states) ? payload.states : [];
    stateStore.clear();
    states.forEach((state) => {
      const flight = parseState(state);
      if (flight) stateStore.set(flight.id, flight);
    });
    if (selectedId) {
      const selectedFlight = stateStore.get(selectedId);
      if (selectedFlight) renderFlightDetails(selectedFlight);
      else closeFlight();
    }
    totalReceived = Number.isFinite(payload.total) ? payload.total : states.length;
    lastUpdated = Date.now();
    updateStatus('Live feed', 'live');
    document.querySelector('#last-update').textContent = 'just now';
    document.querySelector('#data-note').textContent = 'Positions refresh every 10 seconds';
    updateMarkers();
  } catch (error) {
    updateStatus('Signal unavailable', 'offline');
    document.querySelector('#data-note').textContent = error.message.includes('429')
      ? 'OpenSky rate limit reached. Retrying shortly.'
      : 'Waiting for OpenSky Network. Live data requires network access.';
    document.querySelector('#active-count').textContent = '—';
    document.querySelector('#altitude-value').textContent = '—';
    if (!stateStore.size) renderFlightList();
  } finally {
    loading = false;
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(pollFlights, REFRESH_MS);
  }
}

function searchCallsign() {
  const query = searchInput.value.trim().toUpperCase();
  const result = [...stateStore.values()].find((flight) => flight.callsign.includes(query));
  if (query && result) openFlight(result);
  renderFlightList();
}

document.querySelector('#callsign-form').addEventListener('submit', (event) => {
  event.preventDefault();
  searchCallsign();
});
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  renderFlightList();
  searchTimer = window.setTimeout(searchCallsign, 450);
});
document.querySelector('#detail-close').addEventListener('click', closeFlight);
document.querySelector('#home-hub').addEventListener('click', () => map.flyTo(JFK, 7, { duration: 1.5 }));
document.querySelector('#toggle-panel').addEventListener('click', () => {
  const panel = document.querySelector('#control-panel');
  const collapsed = panel.classList.toggle('collapsed');
  document.querySelector('#toggle-panel').setAttribute('aria-expanded', String(!collapsed));
});
setupAircraftRenderer().catch((error) => {
  aircraftRenderer = null;
  console.error('3D aircraft renderer unavailable; using 2D plane markers.', error);
});
map.on('click', (event) => selectAircraftAt(event.latlng));
map.on('moveend zoomend', updateMarkers);
map.on('move zoom', redrawAircraft);
map.on('resize', () => {
  redrawAircraft();
  updateMarkers();
});
map.whenReady(() => window.setTimeout(() => map.flyTo(JFK, 7, { duration: 2.2, easeLinearity: 0.22 }), 260));
window.setInterval(updateClock, 1000);
updateClock();
pollFlights();
