import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODING_API_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES_AUTOCOMPLETE_API_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_API_URL = "https://places.googleapis.com/v1/places";
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let programs = null;
let programIndex = null;
let programIndexByCode = null;
const detailBucketCache = new Map();
const routeCache = new Map();
const geocodeCache = new Map();

function normalizeKey(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      normalizeKey(key),
      String(value ?? "").trim(),
    ])
  );
}

function normalizeAddress(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}


// Arama metnini Türkçe karakterlerden bağımsız ve çok kelimeli aramaya uygun hale getirir.
// Örnek: "İstanbul Aydın Bilgisayar" -> ["istanbul", "aydin", "bilgisayar"]
function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getProgramField(program, names) {
  const normalizedNames = names.map((name) => normalizeSearchText(name));
  const entry = Object.entries(program).find(([key]) =>
    normalizedNames.includes(normalizeSearchText(key))
  );
  return String(entry?.[1] || "").trim();
}

function scoreProgramSearch(program, normalizedQuery, terms) {
  const code = normalizeSearchText(findProgramCode(program));
  const university = normalizeSearchText(
    getProgramField(program, ["Üniversite İsmi", "Üniversite", "Universite"])
  );
  const programName = normalizeSearchText(
    getProgramField(program, ["Program İsmi", "Program", "Bölüm"])
  );
  const fullText = normalizeSearchText(Object.values(program).join(" "));

  // Her kelime aynı kaydın herhangi bir alanında bulunmalı.
  // Böylece "İstanbul Aydın bilgisayar" sorgusu üniversite ve bölüm alanlarını birlikte arar.
  if (!terms.every((term) => fullText.includes(term))) return -1;

  let score = 0;

  if (code === normalizedQuery) score += 2000;
  else if (code.includes(normalizedQuery)) score += 900;

  if (fullText.includes(normalizedQuery)) score += 350;
  if (university.includes(normalizedQuery)) score += 300;
  if (programName.includes(normalizedQuery)) score += 280;

  for (const term of terms) {
    if (university === term) score += 130;
    else if (university.startsWith(term)) score += 100;
    else if (university.includes(term)) score += 70;

    if (programName === term) score += 125;
    else if (programName.startsWith(term)) score += 95;
    else if (programName.includes(term)) score += 65;

    if (code === term) score += 500;
    else if (code.includes(term)) score += 180;
  }

  // Daha kısa ve doğrudan eşleşmeleri üstte tutar.
  score -= Math.min(fullText.length / 500, 20);
  return score;
}

function readTimedCache(cache, key, ttl) {
  const cached = cache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.createdAt > ttl) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => String(value).trim())) rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((value) => normalizeKey(value));

  return rows.slice(1).map((values) =>
    Object.fromEntries(
      headers.map((header, index) => [header, String(values[index] ?? "")])
    )
  );
}

function readGzipJson(filePath) {
  const compressed = fs.readFileSync(filePath);
  const raw = zlib.gunzipSync(compressed).toString("utf8");
  return JSON.parse(raw);
}

function legacyProgramFromSummary(detail) {
  const rank =
    detail.basari_sirasi === null || detail.basari_sirasi === undefined
      ? ""
      : String(detail.basari_sirasi);
  const score =
    detail.taban_puan === null || detail.taban_puan === undefined
      ? ""
      : String(detail.taban_puan);

  return normalizeRow({
    "Program Kodu": detail.program_kodu,
    "Üniversite İsmi": detail.universite_adi || "",
    "Fakülte": detail.fakulte_adi || "",
    "Program İsmi": [detail.fakulte_adi, detail.program_adi]
      .filter(Boolean)
      .join("\n"),
    "Başarı Sırası": rank,
    "Başarı Puanı": score,
    "Puan Türü": detail.puan_turu || "",
    "Üniversite Türü": detail.universite_turu || "",
    "Şehir": detail.program_il || "",
    "İlçe": detail.program_ilce || "",
    "Öğretim Türü": detail.ogrenim_turu || "",
    "Öğretim Dili": detail.ogrenim_dili || "",
    "Öğrenim Süresi": detail.ogrenim_suresi || "",
    "Burs Oranı": detail.burs_orani || "",
    "Kontenjan": detail.kontenjan ?? "",
    "Yerleşen": detail.yerlesen ?? "",
    "Boş Kontenjan": detail.bos_kontenjan ?? "",
    "Doluluk Oranı": detail.doluluk_orani ?? "",
    "Veri Yılı": detail.veri_yili ?? "",
    "YÖK Atlas Detayı": "var",
  });
}

function loadProgramIndex() {
  if (programIndex && programIndexByCode) return programIndex;

  const indexPath = path.join(
    process.cwd(),
    "data",
    "yokatlas",
    "program-index.json.gz"
  );

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const loaded = readGzipJson(indexPath);
  if (!Array.isArray(loaded)) {
    throw new Error("YÖK Atlas program indeksi geçersiz.");
  }

  programIndex = loaded;
  programIndexByCode = new Map(
    loaded.map((item) => [String(item.program_kodu || ""), item])
  );

  return programIndex;
}

function getPrograms() {
  if (programs) return programs;

  const atlasIndex = loadProgramIndex();
  if (atlasIndex) {
    programs = atlasIndex.map(legacyProgramFromSummary);
    return programs;
  }

  const filePath = path.join(process.cwd(), "data", "universite.csv");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Üniversite veri dosyası bulunamadı: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  programs = parseCsv(raw)
    .map(normalizeRow)
    .filter((row) => Object.values(row).join("").trim());

  return programs;
}

function getProgramDetail(code) {
  const normalizedCode = String(code || "").trim();
  if (!/^\d{8,12}$/.test(normalizedCode)) return null;

  const atlasIndex = loadProgramIndex();
  if (!atlasIndex || !programIndexByCode?.has(normalizedCode)) return null;

  const prefix = normalizedCode.slice(0, 3);
  let bucket = detailBucketCache.get(prefix);

  if (!bucket) {
    const bucketPath = path.join(
      process.cwd(),
      "data",
      "yokatlas",
      "details",
      `${prefix}.json.gz`
    );

    if (!fs.existsSync(bucketPath)) return null;
    const loaded = readGzipJson(bucketPath);
    bucket = new Map(
      (Array.isArray(loaded) ? loaded : []).map((item) => [
        String(item.program_kodu || ""),
        item,
      ])
    );
    detailBucketCache.set(prefix, bucket);
  }

  return bucket.get(normalizedCode) || null;
}

function findProgramCode(program) {
  const named =
    program["Program Kodu"] || program.program_kodu || program.Kod || "";

  if (String(named).trim()) return String(named).trim();

  return (
    Object.values(program)
      .map((value) => String(value || "").trim())
      .find((value) => /^\d{8,12}$/.test(value)) || ""
  );
}

function cleanDestinationPart(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (/bilgisi (bulunmuyor|yok)/i.test(text)) return "";
  return text;
}

function buildDestinationQuery({ university, faculty }) {
  const parts = [
    cleanDestinationPart(university),
    cleanDestinationPart(faculty),
    "Türkiye",
  ].filter(Boolean);

  return parts.join(", ");
}

function buildGoogleMapsUrl(origin, destinationQuery) {
  const originText = `${origin.lat},${origin.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    originText
  )}&destination=${encodeURIComponent(destinationQuery)}&travelmode=transit`;
}

function parseDurationSeconds(value) {
  const match = String(value || "").match(/^([\d.]+)s$/);
  return match ? Number(match[1]) : 0;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const roundedMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return hours ? `${hours} sa ${minutes} dk` : `${minutes} dk`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toLocaleString("tr-TR", {
    maximumFractionDigits: 1,
  })} km`;
}

function vehicleLabel(type, fallback) {
  const labels = {
    BUS: "Otobüs",
    INTERCITY_BUS: "Şehirlerarası otobüs",
    TROLLEYBUS: "Troleybüs",
    SUBWAY: "Metro",
    METRO_RAIL: "Raylı sistem",
    HEAVY_RAIL: "Tren",
    COMMUTER_TRAIN: "Banliyö",
    LONG_DISTANCE_TRAIN: "Uzun mesafe treni",
    HIGH_SPEED_TRAIN: "Hızlı tren",
    LIGHT_RAIL: "Tramvay",
    TRAM: "Tramvay",
    RAIL: "Raylı sistem",
    MONORAIL: "Monoray",
    FERRY: "Vapur",
    CABLE_CAR: "Teleferik",
    GONDOLA_LIFT: "Gondol",
    FUNICULAR: "Füniküler",
  };

  return labels[type] || fallback || "Toplu taşıma";
}

function isMetrobusTransitStep({ lineName, details, line }) {
  const stops = details?.stopDetails || {};
  const searchable = normalizeSearchText(
    [
      lineName,
      line?.name,
      line?.nameShort,
      line?.vehicle?.name?.text,
      details?.headsign,
      stops?.departureStop?.name,
      stops?.arrivalStop?.name,
      ...(Array.isArray(line?.agencies)
        ? line.agencies.map((agency) => agency?.name)
        : []),
    ]
      .filter(Boolean)
      .join(" ")
  );

  const compactLine = normalizeSearchText(lineName).replace(/\s+/g, "");

  // Google, İstanbul Metrobüsünü ayrı bir ulaşım modu yerine BUS olarak
  // döndürebiliyor. İETT Metrobüs hatlarının kısa adları 34 ile başlar.
  return (
    searchable.includes("metrobus") ||
    /^34(?:[a-z0-9-]*)$/i.test(compactLine)
  );
}

function parseTransitStep(step) {
  const details = step?.transitDetails;
  if (!details) return null;

  const line = details.transitLine || {};
  const stops = details.stopDetails || {};
  const type = String(line.vehicle?.type || "");
  const defaultVehicle = vehicleLabel(type, line.vehicle?.name?.text);
  const lineName = String(line.nameShort || line.name || defaultVehicle).trim();
  const isMetrobus = isMetrobusTransitStep({ lineName, details, line });

  return {
    mode: isMetrobus ? "METROBUS" : type || "TRANSIT",
    vehicle: isMetrobus ? "Metrobüs" : defaultVehicle,
    line: lineName,
    from: String(stops.departureStop?.name || "").trim(),
    to: String(stops.arrivalStop?.name || "").trim(),
    headsign: String(details.headsign || "").trim(),
    stopCount: Number.isFinite(details.stopCount) ? details.stopCount : null,
    departureTime: String(
      details.localizedValues?.departureTime?.time?.text || ""
    ).trim(),
    arrivalTime: String(
      details.localizedValues?.arrivalTime?.time?.text || ""
    ).trim(),
  };
}

function parseRouteResponse(route, destinationQuery, googleMapsUrl) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const steps = legs.flatMap((leg) => (Array.isArray(leg.steps) ? leg.steps : []));
  const transitSteps = steps.map(parseTransitStep).filter(Boolean);
  const walkingInstructions = steps
    .filter((step) => step?.travelMode === "WALK")
    .map((step) => String(step?.navigationInstruction?.instructions || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const uniqueLines = [];
  for (const step of transitSteps) {
    const label = `${step.vehicle} ${step.line}`.trim();
    if (label && !uniqueLines.includes(label)) uniqueLines.push(label);
  }

  const endLocation = legs.at(-1)?.endLocation?.latLng;
  const durationSeconds = parseDurationSeconds(route?.duration);
  const distanceMeters = Number(route?.distanceMeters || 0);

  return {
    configured: true,
    hasMetrobus: transitSteps.some((step) => step.mode === "METROBUS"),
    durationSeconds,
    distanceMeters,
    destinationQuery,
    destination:
      Number.isFinite(endLocation?.latitude) &&
      Number.isFinite(endLocation?.longitude)
        ? {
            lat: Number(endLocation.latitude),
            lng: Number(endLocation.longitude),
          }
        : null,
    distanceText:
      String(route?.localizedValues?.distance?.text || "").trim() ||
      formatDistance(distanceMeters),
    durationText:
      String(route?.localizedValues?.duration?.text || "").trim() ||
      formatDuration(durationSeconds),
    lineSummary:
      uniqueLines.join(" → ") ||
      (walkingInstructions.length ? "Yürüyüş ağırlıklı rota" : "Toplu taşıma rotası"),
    transitSteps,
    walkingInstructions,
    encodedPolyline: String(route?.polyline?.encodedPolyline || ""),
    googleMapsUrl,
  };
}

function routeFingerprint(route) {
  const lines = route.transitSteps
    .map((step) => `${step.mode}:${step.line}:${step.from}:${step.to}`)
    .join("|");

  return [
    lines,
    route.durationSeconds,
    route.distanceMeters,
    route.destinationQuery,
  ].join("::");
}

function buildRouteBundle(routes, destinationQuery, googleMapsUrl) {
  const unique = [];
  const seen = new Set();

  for (const rawRoute of routes) {
    const parsed = parseRouteResponse(rawRoute, destinationQuery, googleMapsUrl);
    const fingerprint = routeFingerprint(parsed);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(parsed);
  }

  unique.sort((a, b) => {
    if (a.hasMetrobus !== b.hasMetrobus) return a.hasMetrobus ? -1 : 1;
    return a.durationSeconds - b.durationSeconds;
  });

  if (!unique.length) return null;

  const routeOptions = unique.slice(0, 6).map((route, index) => ({
    ...route,
    optionId: `route-${index + 1}-${route.hasMetrobus ? "metrobus" : "transit"}`,
    optionLabel: route.hasMetrobus
      ? `Metrobüs rotası · ${route.lineSummary}`
      : `${index === 0 ? "Önerilen rota" : "Alternatif rota"} · ${route.lineSummary}`,
  }));

  const selected = routeOptions.find((route) => route.hasMetrobus) || routeOptions[0];

  return {
    ...selected,
    routeOptions,
  };
}

async function requestGoogleTransitRoutes({
  origin,
  destinationQuery,
  routingPreference,
  signal,
}) {
  const response = await fetch(ROUTES_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": [
        "routes.routeLabels",
        "routes.distanceMeters",
        "routes.duration",
        "routes.localizedValues",
        "routes.polyline.encodedPolyline",
        "routes.legs.endLocation",
        "routes.legs.steps.travelMode",
        "routes.legs.steps.navigationInstruction.instructions",
        "routes.legs.steps.transitDetails",
      ].join(","),
    },
    body: JSON.stringify({
      origin: {
        location: {
          latLng: {
            latitude: origin.lat,
            longitude: origin.lng,
          },
        },
      },
      destination: {
        address: destinationQuery,
      },
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      languageCode: "tr",
      regionCode: "tr",
      units: "METRIC",
      transitPreferences: {
        routingPreference,
        allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"],
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || "Google Routes API isteği başarısız oldu."
    );
    error.statusCode = response.status;
    throw error;
  }

  return Array.isArray(payload.routes) ? payload.routes : [];
}

function getCacheKey(origin, destinationQuery) {
  return [
    Number(origin.lat).toFixed(4),
    Number(origin.lng).toFixed(4),
    destinationQuery.toLocaleLowerCase("tr-TR"),
  ].join("|");
}

function readCachedRoute(key) {
  const cached = routeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ROUTE_CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return cached.value;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function getPathParts(request) {
  const url = new URL(request.url);
  const relative = url.pathname.replace(/^\/api\/?/, "");
  return {
    url,
    parts: relative
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part)),
  };
}

export async function handleApiRequest(request) {
  try {
    const { url, parts } = getPathParts(request);
    const [resource, identifier] = parts;

    if (!resource) {
      const list = getPrograms();
      return json({
        status: true,
        message: "UniRoute API çalışıyor",
        total: list.length,
        routesConfigured: Boolean(GOOGLE_MAPS_API_KEY),
        geocodingConfigured: Boolean(GOOGLE_MAPS_API_KEY),
        placesConfigured: Boolean(GOOGLE_MAPS_API_KEY),
        yokAtlasDetailsConfigured: Boolean(loadProgramIndex()),
        yokAtlasDataYear: 2026,
      });
    }

    if (request.method === "GET" && resource === "search") {
      const normalizedQuery = normalizeSearchText(url.searchParams.get("q"));
      if (!normalizedQuery) return json([]);

      const terms = normalizedQuery.split(" ").filter(Boolean);
      const results = getPrograms()
        .map((program) => ({
          program,
          score: scoreProgramSearch(program, normalizedQuery, terms),
        }))
        .filter((result) => result.score >= 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return findProgramCode(a.program).localeCompare(
            findProgramCode(b.program)
          );
        })
        .slice(0, 30)
        .map((result) => result.program);

      return json(results);
    }

    if (request.method === "GET" && resource === "program" && identifier) {
      const code = String(identifier || "").trim();
      const result = getPrograms().find(
        (program) => findProgramCode(program) === code
      );

      if (!result) {
        return json(
          { status: false, message: "Program bulunamadı." },
          404
        );
      }

      return json(result);
    }

    if (
      request.method === "GET" &&
      resource === "program-detail" &&
      identifier
    ) {
      const code = String(identifier || "").trim();
      const detail = getProgramDetail(code);

      if (!detail) {
        return json(
          {
            status: false,
            message: "Bu program için YÖK Atlas detay verisi bulunamadı.",
          },
          404
        );
      }

      return json({ status: true, detail });
    }

    if (request.method === "GET" && resource === "programs") {
      return json(getPrograms());
    }

    if (request.method === "GET" && resource === "address-suggestions") {
      const input = normalizeAddress(url.searchParams.get("q"));
      const latitude = Number(url.searchParams.get("lat"));
      const longitude = Number(url.searchParams.get("lng"));
      const sessionToken = normalizeAddress(
        url.searchParams.get("sessionToken")
      ).slice(0, 128);

      if (input.length < 3) {
        return json({ status: true, suggestions: [] });
      }

      if (!GOOGLE_MAPS_API_KEY) {
        return json(
          {
            status: false,
            message:
              "Adres seçenekleri için Vercel Environment Variables bölümüne GOOGLE_MAPS_API_KEY eklenmeli.",
          },
          503
        );
      }

      const body = {
        input,
        includedRegionCodes: ["tr"],
        languageCode: "tr",
        regionCode: "tr",
        includeQueryPredictions: false,
      };

      if (sessionToken) body.sessionToken = sessionToken;

      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        body.origin = { latitude, longitude };
        body.locationBias = {
          circle: {
            center: { latitude, longitude },
            radius: 50000,
          },
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(PLACES_AUTOCOMPLETE_API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask": [
              "suggestions.placePrediction.placeId",
              "suggestions.placePrediction.text.text",
              "suggestions.placePrediction.structuredFormat.mainText.text",
              "suggestions.placePrediction.structuredFormat.secondaryText.text",
              "suggestions.placePrediction.distanceMeters",
            ].join(","),
          },
          body: JSON.stringify(body),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          return json(
            {
              status: false,
              message:
                payload?.error?.message ||
                "Google Places adres önerileri alınamadı.",
            },
            response.status >= 500 ? 502 : response.status
          );
        }

        const suggestions = (Array.isArray(payload.suggestions)
          ? payload.suggestions
          : []
        )
          .map((item) => item?.placePrediction)
          .filter(Boolean)
          .map((prediction) => ({
            placeId: String(prediction.placeId || "").trim(),
            text: String(prediction.text?.text || "").trim(),
            mainText: String(
              prediction.structuredFormat?.mainText?.text || ""
            ).trim(),
            secondaryText: String(
              prediction.structuredFormat?.secondaryText?.text || ""
            ).trim(),
            distanceMeters: Number.isFinite(prediction.distanceMeters)
              ? Number(prediction.distanceMeters)
              : null,
          }))
          .filter((suggestion) => suggestion.placeId && suggestion.text)
          .slice(0, 5);

        return json({ status: true, suggestions });
      } catch (error) {
        const isAbort = error?.name === "AbortError";
        return json(
          {
            status: false,
            message: isAbort
              ? "Adres seçenekleri zaman aşımına uğradı. Tekrar dene."
              : "Adres seçenekleri servisine bağlanılamadı.",
          },
          502
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    if (
      request.method === "GET" &&
      resource === "place-details" &&
      identifier
    ) {
      const placeId = normalizeAddress(identifier);
      const sessionToken = normalizeAddress(
        url.searchParams.get("sessionToken")
      ).slice(0, 128);

      if (!placeId) {
        return json(
          {
            status: false,
            message: "Geçerli bir adres seçeneği gönderilmedi.",
          },
          400
        );
      }

      if (!GOOGLE_MAPS_API_KEY) {
        return json(
          {
            status: false,
            message:
              "Adres ayrıntıları için Vercel Environment Variables bölümüne GOOGLE_MAPS_API_KEY eklenmeli.",
          },
          503
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const detailsUrl = new URL(
          `${PLACES_DETAILS_API_URL}/${encodeURIComponent(placeId)}`
        );
        detailsUrl.searchParams.set("languageCode", "tr");
        detailsUrl.searchParams.set("regionCode", "tr");
        if (sessionToken) {
          detailsUrl.searchParams.set("sessionToken", sessionToken);
        }

        const response = await fetch(detailsUrl, {
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
            "X-Goog-FieldMask": "formattedAddress,location",
          },
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          return json(
            {
              status: false,
              message:
                payload?.error?.message ||
                "Seçilen adresin ayrıntıları alınamadı.",
            },
            response.status >= 500 ? 502 : response.status
          );
        }

        const lat = Number(payload?.location?.latitude);
        const lng = Number(payload?.location?.longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return json(
            {
              status: false,
              message: "Seçilen adresin koordinat bilgisi bulunamadı.",
            },
            502
          );
        }

        return json({
          status: true,
          formattedAddress: String(payload.formattedAddress || "").trim(),
          lat,
          lng,
        });
      } catch (error) {
        const isAbort = error?.name === "AbortError";
        return json(
          {
            status: false,
            message: isAbort
              ? "Adres ayrıntısı isteği zaman aşımına uğradı. Tekrar dene."
              : "Adres ayrıntıları servisine bağlanılamadı.",
          },
          502
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    if (request.method === "GET" && resource === "geocode") {
      const address = normalizeAddress(url.searchParams.get("address"));

      if (address.length < 3) {
        return json(
          { status: false, message: "Adres en az 3 karakter olmalı." },
          400
        );
      }

      if (!GOOGLE_MAPS_API_KEY) {
        return json(
          {
            status: false,
            message:
              "Adres araması için Vercel Environment Variables bölümüne GOOGLE_MAPS_API_KEY eklenmeli.",
          },
          503
        );
      }

      const cacheKey = address.toLocaleLowerCase("tr-TR");
      const cached = readTimedCache(
        geocodeCache,
        cacheKey,
        GEOCODE_CACHE_TTL_MS
      );
      if (cached) return json(cached);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const geocodeUrl = new URL(GEOCODING_API_URL);
        geocodeUrl.searchParams.set("address", address);
        geocodeUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);
        geocodeUrl.searchParams.set("language", "tr");
        geocodeUrl.searchParams.set("region", "tr");

        const response = await fetch(geocodeUrl, {
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok || payload.status !== "OK") {
          const apiMessage =
            payload.error_message ||
            (payload.status === "ZERO_RESULTS"
              ? "Bu adres için sonuç bulunamadı."
              : `Google Geocoding API hatası: ${
                  payload.status || "Bilinmeyen hata"
                }`);

          return json(
            { status: false, message: apiMessage },
            payload.status === "ZERO_RESULTS" ? 404 : 502
          );
        }

        const result = Array.isArray(payload.results)
          ? payload.results[0]
          : null;
        const location = result?.geometry?.location;
        const lat = Number(location?.lat);
        const lng = Number(location?.lng);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return json(
            {
              status: false,
              message: "Adres bulundu ancak koordinat bilgisi alınamadı.",
            },
            502
          );
        }

        const value = {
          status: true,
          formattedAddress: String(result.formatted_address || address),
          lat,
          lng,
        };

        geocodeCache.set(cacheKey, { createdAt: Date.now(), value });
        return json(value);
      } catch (error) {
        const isAbort = error?.name === "AbortError";
        return json(
          {
            status: false,
            message: isAbort
              ? "Adres araması zaman aşımına uğradı. Tekrar dene."
              : "Adres servisine bağlanılamadı.",
          },
          502
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    if (request.method === "POST" && resource === "route") {
      const requestBody = await request.json().catch(() => ({}));
      const origin = {
        lat: Number(requestBody?.origin?.lat),
        lng: Number(requestBody?.origin?.lng),
      };
      const destinationInput = requestBody?.destination || {};
      const destinationQuery = buildDestinationQuery(destinationInput);

      if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
        return json(
          { status: false, message: "Başlangıç koordinatı geçersiz." },
          400
        );
      }

      if (!destinationQuery || destinationQuery === "Türkiye") {
        return json(
          {
            status: false,
            message: "Üniversite veya kampüs bilgisi bulunamadı.",
          },
          400
        );
      }

      const googleMapsUrl = buildGoogleMapsUrl(origin, destinationQuery);

      if (!GOOGLE_MAPS_API_KEY) {
        return json({
          configured: false,
          message:
            "Gerçek toplu taşıma hatlarını göstermek için Vercel Environment Variables bölümüne GOOGLE_MAPS_API_KEY eklenmeli.",
          destinationQuery,
          destination: null,
          distanceText: "—",
          durationText: "—",
          lineSummary: "Google Maps'te rotayı aç",
          transitSteps: [],
          walkingInstructions: [],
          encodedPolyline: "",
          googleMapsUrl,
        });
      }

      const cacheKey = getCacheKey(origin, destinationQuery);
      const cached = readCachedRoute(cacheKey);
      if (cached) return json(cached);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      try {
        let rawRoutes = await requestGoogleTransitRoutes({
          origin,
          destinationQuery,
          routingPreference: "LESS_WALKING",
          signal: controller.signal,
        });

        let bundle = buildRouteBundle(
          rawRoutes,
          destinationQuery,
          googleMapsUrl
        );

        if (
          !bundle ||
          !bundle.routeOptions.some((route) => route.hasMetrobus)
        ) {
          const fewerTransfersRoutes = await requestGoogleTransitRoutes({
            origin,
            destinationQuery,
            routingPreference: "FEWER_TRANSFERS",
            signal: controller.signal,
          });
          rawRoutes = [...rawRoutes, ...fewerTransfersRoutes];
          bundle = buildRouteBundle(
            rawRoutes,
            destinationQuery,
            googleMapsUrl
          );
        }

        if (!bundle) {
          return json(
            {
              status: false,
              message:
                "Bu başlangıç noktası ile kampüs arasında toplu taşıma rotası bulunamadı.",
              googleMapsUrl,
            },
            404
          );
        }

        routeCache.set(cacheKey, { createdAt: Date.now(), value: bundle });
        return json(bundle);
      } catch (error) {
        const isAbort = error?.name === "AbortError";
        const statusCode = Number(error?.statusCode);
        const responseStatus =
          Number.isFinite(statusCode) &&
          statusCode >= 400 &&
          statusCode < 500
            ? statusCode
            : 502;

        return json(
          {
            status: false,
            message: isAbort
              ? "Rota servisi zaman aşımına uğradı. Tekrar dene."
              : error?.message || "Rota servisine bağlanılamadı.",
            googleMapsUrl,
          },
          responseStatus
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    return json({ status: false, message: "API yolu bulunamadı." }, 404);
  } catch (error) {
    console.error("UniRoute API hatası:", error);
    return json(
      {
        status: false,
        message: "Beklenmeyen sunucu hatası oluştu.",
      },
      500
    );
  }
}
