// OpenStreetMap Nominatim geocoder agent unit with offline cycling landmark catalog.
// Props: kind, q, lang. Raises: found({ kind, q, lang, p0, p1, p2, p3, p4 }).

const API = "https://nominatim.openstreetmap.org/";
const EMAIL = "router@surita.dev";
const SPACING_MS = 1100;
const MIN_CHARS = 2;
const MAX_RESULTS = 5;

const OFFLINE_LANDMARKS = [
  { label: "Hyde Park, Westminster, London, UK", line1: "Hyde Park", city: "London", region: "England", postal_code: "W2 2UH", country: "GB", latitude: "51.507268", longitude: "-0.165730", district: "Westminster" },
  { label: "Greenwich Park, Greenwich, London, UK", line1: "Greenwich Park", city: "London", region: "England", postal_code: "SE10 8QY", country: "GB", latitude: "51.476852", longitude: "-0.000500", district: "Greenwich" },
  { label: "Richmond Park, Richmond, London, UK", line1: "Richmond Park", city: "London", region: "England", postal_code: "TW10 5HS", country: "GB", latitude: "51.442800", longitude: "-0.273600", district: "Richmond" },
  { label: "Trafalgar Square, Westminster, London, UK", line1: "Trafalgar Square", city: "London", region: "England", postal_code: "WC2N 5DN", country: "GB", latitude: "51.508039", longitude: "-0.128069", district: "Westminster" },
  { label: "Tower Bridge, Southwark, London, UK", line1: "Tower Bridge", city: "London", region: "England", postal_code: "SE1 2UP", country: "GB", latitude: "51.505500", longitude: "-0.075406", district: "Southwark" },
  { label: "King's Cross Station, Camden, London, UK", line1: "King's Cross Station", city: "London", region: "England", postal_code: "N1 9AL", country: "GB", latitude: "51.530800", longitude: "-0.123800", district: "Camden" },
  { label: "Parque Ibirapuera, Vila Mariana, São Paulo, BR", line1: "Parque Ibirapuera", city: "São Paulo", region: "SP", postal_code: "04094-050", country: "BR", latitude: "-23.587416", longitude: "-46.657634", district: "Vila Mariana" },
  { label: "Avenida Paulista, Bela Vista, São Paulo, BR", line1: "Avenida Paulista", city: "São Paulo", region: "SP", postal_code: "01310-100", country: "BR", latitude: "-23.561414", longitude: "-46.655881", district: "Bela Vista" },
  { label: "Ciclovia Rio Pinheiros, Pinheiros, São Paulo, BR", line1: "Ciclovia Rio Pinheiros", city: "São Paulo", region: "SP", postal_code: "05425-070", country: "BR", latitude: "-23.567200", longitude: "-46.701900", district: "Pinheiros" },
  { label: "Praça da Sé, Centro, São Paulo, BR", line1: "Praça da Sé", city: "São Paulo", region: "SP", postal_code: "01001-000", country: "BR", latitude: "-23.550303", longitude: "-46.633956", district: "Centro" },
];

let current = 0;
let stamp = "";

function formatRow(item) {
  const clean = (s) => String(s || "").replace(/[\t\r\n]+/g, " ").slice(0, 240);
  return [
    clean(item.label),
    clean(item.line1 || item.label),
    clean(item.city),
    clean(item.region),
    clean(item.postal_code),
    clean(item.country),
    clean(item.latitude),
    clean(item.longitude),
    clean(item.district),
  ].join("\t");
}

function matchOfflineLandmarks(words) {
  const norm = String(words || "").toLowerCase().trim();
  if (!norm) return [];
  const matches = OFFLINE_LANDMARKS.filter((item) =>
    item.label.toLowerCase().includes(norm) || item.city.toLowerCase().includes(norm),
  );
  return matches.slice(0, MAX_RESULTS);
}

function answer(question, places) {
  const detail = { kind: question.kind, q: question.q, lang: question.lang };
  for (let i = 0; i < MAX_RESULTS; i++) {
    detail[`p${i}`] = i < places.length ? formatRow(places[i]) : "";
  }
  postMessage({ type: "pronto:event", name: "found", detail });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function ask(question, id) {
  const words = question.q.trim();
  if (words.length < MIN_CHARS) {
    answer(question, []);
    return;
  }

  // Coordinate literal support: "51.5072, -0.1276"
  const coordMatch = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(words);
  if (coordMatch) {
    const a = Number(coordMatch[1]);
    const b = Number(coordMatch[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      answer(question, [{
        label: `Coordinate (${a.toFixed(4)}, ${b.toFixed(4)})`,
        city: "Direct Coordinate",
        country: "",
        latitude: a.toFixed(6),
        longitude: b.toFixed(6),
      }]);
      return;
    }
  }

  const runFetch = async () => {
    const params = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      "accept-language": question.lang || "en",
      email: EMAIL,
      q: words,
      limit: String(MAX_RESULTS),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const started = Date.now();
      const res = await fetch(`${API}search?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = await res.json();
      await sleep(SPACING_MS - (Date.now() - started));
      return Array.isArray(body) ? body : null;
    } catch (_) {
      clearTimeout(timer);
      return null;
    }
  };

  let rawList = null;
  if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
    rawList = await navigator.locks.request("gabi-router-nominatim", async () => {
      if (id !== current) return null;
      return await runFetch();
    });
  } else {
    rawList = await runFetch();
  }

  if (id !== current) return;

  if (Array.isArray(rawList) && rawList.length > 0) {
    const places = rawList.slice(0, MAX_RESULTS).map((raw) => {
      const addr = raw.address || {};
      const label = String(raw.display_name || words);
      const line1 = String(raw.name || addr.road || label.split(",")[0] || words);
      return {
        label,
        line1,
        city: String(addr.city || addr.town || addr.village || addr.municipality || ""),
        region: String(addr.state || addr.county || ""),
        postal_code: String(addr.postcode || ""),
        country: String(addr.country_code || "").toUpperCase(),
        latitude: Number(raw.lat || 0).toFixed(6),
        longitude: Number(raw.lon || 0).toFixed(6),
        district: String(addr.suburb || addr.neighbourhood || addr.city_district || ""),
      };
    });
    answer(question, places);
    return;
  }

  // Offline landmark fallback
  answer(question, matchOfflineLandmarks(words));
}

function onProps(props) {
  const { kind = "", q = "", lang = "" } = props || {};
  const next = JSON.stringify([kind, q, lang]);
  if (next === stamp) return;
  stamp = next;
  const id = ++current;
  if (kind === "" || q === "" || lang === "") return;
  ask({ kind, q, lang }, id);
}

addEventListener("message", (e) => {
  if (e.data?.type === "pronto:props") onProps(e.data.props);
});
postMessage({ type: "pronto:ready" });
