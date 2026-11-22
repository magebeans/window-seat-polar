// MapLibre style: Protomaps basemap (local PMTiles, local glyphs + sprites) plus our overlays.
import { layers, namedFlavor } from '../vendor/basemaps.mjs';
import { TYPE_COLOR } from './pois.js';

const base = new URL('./', location.href).href;

export function buildStyle({ flavor = 'light', projection = 'globe', overlays }) {
  const typeColor = ['match', ['get', 'type'], ...Object.entries(TYPE_COLOR).flat(), '#888'];
  return {
    version: 8,
    projection: { type: projection },
    glyphs: `${base}fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}sprites/${flavor}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${base}data/basemap.pmtiles`,
        attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
      'ws-night': { type: 'geojson', data: overlays.night },
      'ws-route': { type: 'geojson', data: overlays.route },
      'ws-corridor': { type: 'geojson', data: overlays.corridor },
      'ws-pois': { type: 'geojson', data: overlays.pois },
      'ws-plane': { type: 'geojson', data: overlays.plane },
    },
    layers: [
      ...layers('protomaps', namedFlavor(flavor), { lang: 'en' }),
      { id: 'ws-night-twilight', type: 'fill', source: 'ws-night', filter: ['==', ['get', 'h'], 0], paint: { 'fill-color': '#0a1030', 'fill-opacity': 0.22 } },
      { id: 'ws-night-dark', type: 'fill', source: 'ws-night', filter: ['==', ['get', 'h'], -6], paint: { 'fill-color': '#050a24', 'fill-opacity': 0.25 } },
      { id: 'ws-terminator', type: 'line', source: 'ws-night', filter: ['==', ['get', 'h'], 0], paint: { 'line-color': '#f5b342', 'line-width': 1.2, 'line-opacity': 0.8 } },
      { id: 'ws-corridor', type: 'line', source: 'ws-corridor', paint: { 'line-color': '#7a5af8', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } },
      { id: 'ws-route-casing', type: 'line', source: 'ws-route', paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.7 } },
      { id: 'ws-route', type: 'line', source: 'ws-route', paint: { 'line-color': '#d0312d', 'line-width': 2.5 } },
      {
        id: 'ws-pois', type: 'circle', source: 'ws-pois',
        paint: {
          'circle-color': typeColor,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['>', ['get', 'hl'], 0], 8, 2.5], 9, ['case', ['>', ['get', 'hl'], 0], 10, 5]],
          'circle-stroke-color': ['case', ['>', ['get', 'hl'], 0], '#111', '#fff'],
          'circle-stroke-width': ['case', ['>', ['get', 'hl'], 0], 2, 1],
        },
      },
      {
        id: 'ws-poi-labels', type: 'symbol', source: 'ws-pois',
        filter: ['any', ['>', ['get', 'hl'], 0], ['>=', ['zoom'], 7]],
        layout: {
          'text-field': ['case', ['>', ['get', 'hl'], 0], ['concat', ['to-string', ['get', 'hl']], '  ', ['get', 'name']], ['get', 'name']],
          'text-font': ['Noto Sans Medium'], 'text-size': ['case', ['>', ['get', 'hl'], 0], 13, 11],
          'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 9,
          'symbol-sort-key': ['-', 0, ['get', 'r']],
        },
        paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
      },
      {
        id: 'ws-plane', type: 'symbol', source: 'ws-plane',
        layout: {
          'icon-image': 'ws-plane', 'icon-size': 1, 'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['case', ['get', 'estimated'], 0.5, 1] },
      },
    ],
  };
}

/** A plane silhouette pointing up (north), drawn on a canvas so no image file is needed. */
export function planeImage(size = 44) {
  const dpr = 2, s = size * dpr;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.scale(s / 100, s / 100);
  g.beginPath();
  g.moveTo(50, 4); g.bezierCurveTo(55, 4, 56, 14, 56, 22); g.lineTo(56, 40); g.lineTo(94, 60); g.lineTo(94, 68);
  g.lineTo(56, 58); g.lineTo(55, 80); g.lineTo(68, 90); g.lineTo(68, 96); g.lineTo(50, 91); g.lineTo(32, 96);
  g.lineTo(32, 90); g.lineTo(45, 80); g.lineTo(44, 58); g.lineTo(6, 68); g.lineTo(6, 60); g.lineTo(44, 40);
  g.lineTo(44, 22); g.bezierCurveTo(44, 14, 45, 4, 50, 4); g.closePath();
  g.fillStyle = '#d0312d'; g.strokeStyle = '#fff'; g.lineWidth = 5; g.lineJoin = 'round';
  g.stroke(); g.fill();
  return { data: g.getImageData(0, 0, s, s), pixelRatio: dpr };
}
