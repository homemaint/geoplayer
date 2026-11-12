// Custom dark slate StyleSpecification for the route replay map.
// Vector tiles: OpenFreeMap (OpenMapTiles schema, free, no key, CORS *).
// Relief: AWS Terrain Tiles (Mapzen terrarium DEM, free, no key).
import type maplibregl from "maplibre-gl";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const FONT = ["Noto Sans Regular"];

export const DARK_STYLE = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    },
    terrain: {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      minzoom: 0,
      maxzoom: 15,
      attribution: "Elevation © Mapzen / AWS",
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0b101c" } },
    { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water",
      paint: { "fill-color": "#0e2436" } },
    { id: "waterway", type: "line", source: "openmaptiles", "source-layer": "waterway",
      layout: { "line-cap": "round" },
      paint: { "line-color": "#123049", "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 10, 0.8, 20, 22] } },

    // ---- terrain / land cover -------------------------------------------------
    { id: "landcover_wood", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#10231c", "fill-opacity": 0.9 } },
    { id: "landcover_grass", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["grass", "scrub"]]],
      paint: { "fill-color": "#12241c", "fill-opacity": 0.75 } },
    { id: "landcover_farmland", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["==", ["get", "class"], "farmland"],
      paint: { "fill-color": "#191f17", "fill-opacity": 0.7 } },
    { id: "landcover_rock", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["rock", "sand"]]],
      paint: { "fill-color": "#1d1e20", "fill-opacity": 0.75 } },
    { id: "landcover_wetland", type: "fill", source: "openmaptiles", "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wetland"],
      paint: { "fill-color": "#10242a", "fill-opacity": 0.7 } },
    { id: "landuse_park", type: "fill", source: "openmaptiles", "source-layer": "park",
      paint: { "fill-color": "#101f1c", "fill-opacity": 0.75 } },
    { id: "landuse_residential", type: "fill", source: "openmaptiles", "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "suburban", "neighbourhood"]]],
      paint: { "fill-color": "#10151f", "fill-opacity": 0.6 } },

    // Hillshade gives the mountains their shape even at high zoom.
    { id: "hillshade", type: "hillshade", source: "terrain",
      paint: {
        "hillshade-shadow-color": "#01050a",
        "hillshade-highlight-color": "#54788c",
        "hillshade-accent-color": "#08121a",
        "hillshade-exaggeration": 0.5,
      } },

    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building",
      minzoom: 13.5,
      paint: { "fill-color": "#141d2b", "fill-outline-color": "#1f2c3d" } },

    // ---- roads ----------------------------------------------------------------
    { id: "road_path_casing", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "path"],
      layout: { "line-cap": "round" },
      paint: { "line-color": "#242e3d", "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 13, 1.4, 20, 9], "line-opacity": 0.7 } },
    { id: "road_minor_casing", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor_road", "service_other", "track"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#26313f", "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 1, 20, 18] } },
    { id: "road_major_casing", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#33415c", "line-width": ["interpolate", ["exponential", 1.35], ["zoom"], 8, 1.2, 20, 26] } },
    { id: "road_motorway_casing", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#3d4e70", "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 6, 1.5, 20, 34] } },

    { id: "road_path", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "path"],
      paint: { "line-color": "#161d29", "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 13, 0.7, 20, 5] } },
    { id: "road_minor", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor_road", "service_other", "track"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#181f2b", "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.5, 20, 12] } },
    { id: "road_major", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#212b3d", "line-width": ["interpolate", ["exponential", 1.35], ["zoom"], 8, 0.6, 20, 17] } },
    { id: "road_motorway", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#2b3750", "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 6, 0.8, 20, 22] } },
    { id: "road_motorway_subtle", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
      paint: { "line-color": "#3f5470", "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 6, 0.15, 20, 3.2], "line-opacity": 0.8 } },

    { id: "railway", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["major_rail", "minor_rail", "service_other"]]],
      paint: { "line-color": "#2a2335", "line-width": 1.6, "line-dasharray": [4, 3], "line-opacity": 0.8 } },

    { id: "boundary_state", type: "line", source: "openmaptiles", "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 4],
      paint: { "line-color": "#1d2b40", "line-width": 1, "line-opacity": 0.6 } },
    { id: "boundary_country", type: "line", source: "openmaptiles", "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: { "line-color": "#22304a", "line-width": 1.3, "line-opacity": 0.75 } },

    // ---- landmarks ------------------------------------------------------------
    // POIs are what make a route feel real: hotels, temples, viewpoints, fuel.
    { id: "poi_dot", type: "circle", source: "openmaptiles", "source-layer": "poi",
      minzoom: 14,
      filter: ["all", ["has", "name"], ["<=", ["coalesce", ["get", "rank"], 99], 40]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 1.4, 18, 3.2],
        "circle-color": "#22d3ee",
        "circle-opacity": 0.65,
        "circle-stroke-width": 0.6,
        "circle-stroke-color": "#05131a",
      } },
    { id: "poi_label", type: "symbol", source: "openmaptiles", "source-layer": "poi",
      minzoom: 14,
      filter: ["all", ["has", "name"], ["<=", ["coalesce", ["get", "rank"], 99], 40]],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 12],
        "text-max-width": 8,
        "text-offset": [0, 0.6],
        "text-anchor": "top",
        "text-padding": 4,
        "text-optional": true,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
      paint: { "text-color": "#8fb3c4", "text-halo-color": "#050a12", "text-halo-width": 1.3 } },

    { id: "peak_label", type: "symbol", source: "openmaptiles", "source-layer": "mountain_peak",
      minzoom: 10,
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        "text-font": ["Noto Sans Italic"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 12],
        "text-max-width": 8,
        "text-letter-spacing": 0.4,
        "text-optional": true,
      },
      paint: { "text-color": "#93a9bd", "text-halo-color": "#050a12", "text-halo-width": 1.3 } },

    // ---- place names ----------------------------------------------------------
    { id: "place_major", type: "symbol", source: "openmaptiles", "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 11, 14, 15, 18],
        "text-max-width": 8,
        "text-letter-spacing": 0.4,
        "text-optional": true,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
      paint: { "text-color": "#d3e4f5", "text-halo-color": "#050a12", "text-halo-width": 1.5 } },
    { id: "place_minor", type: "symbol", source: "openmaptiles", "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["village", "hamlet", "suburb", "neighbourhood", "locality", "isolated_dwelling"]]],
      minzoom: 11,
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 16, 12.5, 19, 14],
        "text-max-width": 8,
        "text-letter-spacing": 0.3,
        "text-optional": true,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
      paint: { "text-color": "#a9bfd4", "text-halo-color": "#050a12", "text-halo-width": 1.3 } },

    { id: "water_name", type: "symbol", source: "openmaptiles", "source-layer": "water_name",
      minzoom: 10,
      layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": FONT, "text-size": 11, "text-max-width": 6 },
      paint: { "text-color": "#4c6d8c", "text-halo-color": "#050a12", "text-halo-width": 1.2 } },

    { id: "road_ref", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
      minzoom: 12,
      filter: ["has", "ref"],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "ref"],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 20, 11],
        "text-letter-spacing": 0.8,
        "text-rotation-alignment": "map",
      },
      paint: { "text-color": "#6f86a3", "text-halo-color": "#050a12", "text-halo-width": 1.2 } },
    { id: "road_name", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
      minzoom: 13,
      layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 20, 13], "text-max-width": 7, "text-letter-spacing": 0.2 },
      paint: { "text-color": "#7f8da6", "text-halo-color": "#050a12", "text-halo-width": 1.1 } },
  ],
} as maplibregl.StyleSpecification;

/** Satellite hybrid style: Esri World Imagery + OpenFreeMap road/place labels on top. */
export const SATELLITE_STYLE = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    satellite: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri · Maxar · Earthstar Geographics",
    },
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#05080f" } },
    { id: "satellite-layer", type: "raster", source: "satellite",
      paint: { "raster-opacity": 0.92, "raster-contrast": 0.08, "raster-saturation": -0.05 } },
    { id: "road_major_hybrid", type: "line", source: "openmaptiles", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgba(255, 255, 255, 0.22)", "line-width": ["interpolate", ["exponential", 1.35], ["zoom"], 8, 0.8, 20, 10] } },
    { id: "road_ref", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
      minzoom: 11,
      filter: ["has", "ref"],
      layout: { "symbol-placement": "line", "text-field": ["get", "ref"], "text-font": FONT, "text-size": 10 },
      paint: { "text-color": "#fde68a", "text-halo-color": "#050a12", "text-halo-width": 1.6 } },
    { id: "road_name", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
      minzoom: 13,
      layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": FONT, "text-size": 11 },
      paint: { "text-color": "#f1f5f9", "text-halo-color": "#050a12", "text-halo-width": 1.6 } },
    { id: "place_minor", type: "symbol", source: "openmaptiles", "source-layer": "place",
      minzoom: 10,
      layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": FONT, "text-size": 12 },
      paint: { "text-color": "#ffffff", "text-halo-color": "#050a12", "text-halo-width": 1.8 } },
  ],
} as maplibregl.StyleSpecification;

/** TomTom Night raster tile style for MapLibre. */
export function buildTomTomStyle(apiKey: string): maplibregl.StyleSpecification {
  const key = encodeURIComponent(apiKey.trim());
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      tomtom: {
        type: "raster",
        tiles: [
          `https://api.tomtom.com/map/1/tile/basic/night/{z}/{x}/{y}.png?key=${key}&tileSize=512`,
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution: "© TomTom",
      },
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0b101c" } },
      { id: "tomtom-night", type: "raster", source: "tomtom" },
      // Transparent vector road layer so queryRenderedFeatures still works for road names
      { id: "road_name", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name",
        minzoom: 13,
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": FONT, "text-size": 10 },
        paint: { "text-opacity": 0 } },
    ],
  };
}
