/* OpenStreetMap Nominatim — the independent second source for addresses. */
const { get } = require("./fetcher");
const { normStreet } = require("./text");

const MA = { latMin: 41.1, latMax: 42.95, lngMin: -73.6, lngMax: -69.85 };

async function geocode(q) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q, format: "jsonv2", countrycodes: "us", limit: "3", addressdetails: "1",
  });
  const r = await get(url, { accept: "application/json" });
  let results = [];
  try { results = JSON.parse(r.body); } catch {}
  const human = "https://www.openstreetmap.org/search?query=" + encodeURIComponent(q);
  return {
    query: q, apiUrl: url, humanUrl: human, status: r.status,
    results: (Array.isArray(results) ? results : []).map(x => ({
      lat: +x.lat, lng: +x.lon, name: x.display_name, category: x.category, type: x.type,
      road: x.address?.road || "", house: x.address?.house_number || "",
      city: x.address?.city || x.address?.town || x.address?.village || x.address?.hamlet || "",
      suburb: x.address?.suburb || x.address?.neighbourhood || "",
      state: x.address?.state || "", osmUrl: `https://www.openstreetmap.org/${x.osm_type}/${x.osm_id}`,
    })).filter(x => x.state === "Massachusetts" && inMA(x.lat, x.lng)),
  };
}

const inMA = (lat, lng) => lat >= MA.latMin && lat <= MA.latMax && lng >= MA.lngMin && lng <= MA.lngMax;

function km(a, b) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Does an OSM result name the same street as the quoted address? */
function sameStreet(result, street) {
  if (!result.road) return false;
  const a = normStreet(result.road), b = normStreet(street);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/* Same town? Neighborhood names (Dorchester, Allston…) count for Boston. */
function sameCity(result, city) {
  if (!city) return true;
  const c = city.toLowerCase().trim();
  return [result.city, result.suburb].some(x => x && x.toLowerCase() === c) || (result.name || "").toLowerCase().includes(`, ${c},`);
}

module.exports = { geocode, km, sameStreet, sameCity, inMA };
