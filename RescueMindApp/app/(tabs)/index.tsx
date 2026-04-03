import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
} from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Dimensions,
  StatusBar,
  Linking,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as Location from "expo-location";
import Constants from "expo-constants";
import MapView, {
  Polyline,
  Marker,
  UrlTile,
  LatLng,
  MAP_TYPES,
} from "react-native-maps";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";

/* ───────────────── TYPES ───────────────── */

type Coord = {
  latitude: number;
  longitude: number;
};

type Step = {
  instruction: string;
  distance: string;
  duration: string;
  maneuver?: string;
  startLat: number;
  startLng: number;
};

type TurnByTurnRoute = {
  summary: string;
  distance: string;
  duration: string;
  distanceM: number;
  durationS: number;
  steps: Step[];
};

type ServerRoute = {
  type: "FASTEST" | "SAFEST" | "SHORTEST";
  distance: number;
  time: number;
  path: { lat: number; lon: number }[];
};

type NearestLocation = {
  lat: number;
  lon: number;
  name?: string;
  [key: string]: any;
};

/**
 * /nearest returns { nearest_location: string, distance_km: number }.
 * If the response has no numeric lat/lon we geocode the place name via
 * OpenStreetMap Nominatim to obtain coordinates.
 */
async function resolveNearestLocation(data: any): Promise<NearestLocation> {
  // Happy path — server already gave us coordinates
  const directLat =
    typeof data.lat === "number"
      ? data.lat
      : typeof data.latitude === "number"
        ? data.latitude
        : undefined;
  const directLon =
    typeof data.lon === "number"
      ? data.lon
      : typeof data.lng === "number"
        ? data.lng
        : typeof data.longitude === "number"
          ? data.longitude
          : undefined;

  if (typeof directLat === "number" && typeof directLon === "number") {
    return {
      ...data,
      lat: directLat,
      lon: directLon,
      name: data.name ?? data.nearest_location ?? undefined,
    };
  }

  // Server returned a place name only — geocode it
  const placeName: string | undefined =
    data.nearest_location ?? data.name ?? data.place ?? data.location;

  if (!placeName) {
    throw new Error(
      `No lat/lon or place name in /nearest response.\n\nGot: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  // Use OpenStreetMap Nominatim — free, no API key required
  const nominatimUrl =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(placeName)}` +
    `&format=json&limit=1`;

  const res = await fetch(nominatimUrl, { headers: nominatimHeaders() });
  const json = await res.json();

  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(
      `Geocoding "${placeName}" returned no results (Nominatim).`,
    );
  }

  const lat = parseFloat(json[0].lat);
  const lon = parseFloat(json[0].lon);
  console.log(`[nominatim] "${placeName}" -> ${lat}, ${lon}`);

  return {
    ...data,
    lat,
    lon,
    name: placeName,
  };
}

type HealthStatus = {
  gateway: boolean | null;
  rag: boolean | null;
  graph: boolean | null;
};

type AppContextType = {
  gatewayIP: string;
  setGatewayIP: (ip: string) => void;
  baseURL: string;
  healthStatus: HealthStatus | null;
  checking: boolean;
  checkHealth: (ip?: string) => void;
  location: Coord | null;
};

/* ───────────────── CONTEXT ───────────────── */

const AppContext = createContext<AppContextType>({} as AppContextType);
const useApp = () => useContext(AppContext);

/* ───────────────── UTILS ───────────────── */

/** ~50 km/h — rough segment times for path-based directions only */
const ASSUMED_SPEED_MPS = 50 / 3.6;

/**
 * Do not use tile.openstreetmap.org in mobile apps: native tile requests cannot
 * set a compliant User-Agent, so OSMF often blocks them. CARTO basemaps are
 * OSM-based and suited for app use (still attribute OSM + CARTO).
 */
const RASTER_TILE_URL =
  "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";

/** https://operations.osmfoundation.org/policies/nominatim/ */
function nominatimHeaders(): Record<string, string> {
  const id =
    Constants.expoConfig?.android?.package ??
    Constants.expoConfig?.ios?.bundleIdentifier ??
    "com.rescuemind.app";
  const contactUrl = process.env.EXPO_PUBLIC_NOMINATIM_CONTACT?.trim();
  const ua = contactUrl
    ? `RescueMind/1.0 (${id}; ${contactUrl})`
    : `RescueMind/1.0 (${id})`;
  const h: Record<string, string> = { "User-Agent": ua };
  const from = process.env.EXPO_PUBLIC_NOMINATIM_FROM_EMAIL?.trim();
  if (from) h.From = from;
  return h;
}

function formatDistanceM(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "—";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function formatDurationS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h} h ${mm} min`;
  }
  if (m === 0) return `${s} s`;
  return `${m} min ${s} s`;
}

function haversineM(a: Coord, b: Coord): number {
  const R = 6371000;
  const φ1 = (a.latitude * Math.PI) / 180;
  const φ2 = (b.latitude * Math.PI) / 180;
  const Δφ = ((b.latitude - a.latitude) * Math.PI) / 180;
  const Δλ = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function bearingDeg(a: Coord, b: Coord): number {
  const φ1 = (a.latitude * Math.PI) / 180;
  const φ2 = (b.latitude * Math.PI) / 180;
  const Δλ = ((b.longitude - a.longitude) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = (Math.atan2(y, x) * 180) / Math.PI;
  return (θ + 360) % 360;
}

function angleDiffDeg(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function cardinal8(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function turnPhrase(delta: number): string | null {
  const abs = Math.abs(delta);
  if (abs < 22) return null;
  const dir = delta > 0 ? "right" : "left";
  if (abs < 45) return `Bear slightly ${dir}`;
  if (abs < 130) return `Turn ${dir}`;
  if (abs < 170) return `Turn sharp ${dir}`;
  return `Make a U-turn to the ${dir}`;
}

/**
 * Turn-by-turn cues derived from the backend route polyline so the line on the map
 * and the steps stay aligned for each tab (FASTEST / SAFEST / SHORTEST).
 */
function buildDirectionsFromPath(
  path: { lat: number; lon: number }[],
  distanceM: number,
  durationS: number,
  modeLabel: string,
): TurnByTurnRoute {
  const pts: Coord[] = path.map((p) => ({
    latitude: p.lat,
    longitude: p.lon,
  }));

  if (pts.length < 2) {
    return {
      summary: `${modeLabel} · route`,
      distance: formatDistanceM(distanceM),
      duration: formatDurationS(durationS),
      distanceM,
      durationS,
      steps: [
        {
          instruction: "You are already at the destination.",
          distance: "—",
          duration: "—",
          startLat: pts[0]?.latitude ?? 0,
          startLng: pts[0]?.longitude ?? 0,
        },
      ],
    };
  }

  const steps: Step[] = [];
  let runM = 0;
  let runStart: Coord = pts[0];

  const pushContinue = (meters: number, at: Coord) => {
    if (meters < 20) return;
    const sec = meters / ASSUMED_SPEED_MPS;
    steps.push({
      instruction: `Continue along the route for ${formatDistanceM(meters)}`,
      distance: formatDistanceM(meters),
      duration: formatDurationS(sec),
      startLat: at.latitude,
      startLng: at.longitude,
    });
  };

  steps.push({
    instruction: `Head ${cardinal8(bearingDeg(pts[0], pts[1]))} along the highlighted route`,
    distance: "—",
    duration: "—",
    startLat: pts[0].latitude,
    startLng: pts[0].longitude,
  });

  for (let i = 1; i < pts.length - 1; i++) {
    const brgIn = bearingDeg(pts[i - 1], pts[i]);
    const brgOut = bearingDeg(pts[i], pts[i + 1]);
    const segM = haversineM(pts[i - 1], pts[i]);
    runM += segM;
    const phrase = turnPhrase(angleDiffDeg(brgIn, brgOut));
    if (phrase) {
      pushContinue(runM, runStart);
      runM = 0;
      runStart = pts[i];
      steps.push({
        instruction: phrase,
        distance: "—",
        duration: "—",
        maneuver: phrase,
        startLat: pts[i].latitude,
        startLng: pts[i].longitude,
      });
    }
  }

  runM += haversineM(pts[pts.length - 2], pts[pts.length - 1]);
  pushContinue(runM, runStart);

  const last = pts[pts.length - 1];
  const finLeg = haversineM(pts[pts.length - 2], last);
  steps.push({
    instruction: "Arrive at your destination",
    distance: formatDistanceM(finLeg),
    duration: formatDurationS(finLeg / ASSUMED_SPEED_MPS),
    startLat: last.latitude,
    startLng: last.longitude,
  });

  return {
    summary: `${modeLabel} · RescueMind graph route`,
    distance: formatDistanceM(distanceM),
    duration: formatDurationS(durationS),
    distanceM,
    durationS,
    steps,
  };
}

function openDirectionsInOpenStreetMap(
  origin: Coord,
  destination: Coord,
): void {
  const o = `${origin.latitude},${origin.longitude}`;
  const d = `${destination.latitude},${destination.longitude}`;
  const url = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(o)}%3B${encodeURIComponent(d)}`;
  Linking.openURL(url).catch(() => {
    Alert.alert("Could not open maps", "No app available to handle the link.");
  });
}

function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/* ───────────────── ROUTE COLORS ───────────────── */

const ROUTE_COLORS: Record<ServerRoute["type"], string> = {
  FASTEST: "#4285F4", // Google Maps blue
  SAFEST: "#34A853", // Google Maps green
  SHORTEST: "#9B59B6",
};

const ROUTE_LABELS: Record<ServerRoute["type"], string> = {
  FASTEST: "⚡ Fastest",
  SAFEST: "🛡 Safest",
  SHORTEST: "📏 Shortest",
};

/* ───────────────── SCREENS ───────────────── */

function ConfigScreen() {
  const { gatewayIP, setGatewayIP, checkHealth, healthStatus, checking } =
    useApp();
  const [draft, setDraft] = useState(gatewayIP);

  const dot = (val: boolean | null) =>
    val === null ? "⚪" : val ? "🟢" : "🔴";

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.configContainer}>
        <Text style={styles.heading}>Gateway Configuration</Text>

        <Text style={styles.label}>Gateway IP / URL</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="e.g. 192.168.1.10:6000"
          placeholderTextColor="#888"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => {
            setGatewayIP(draft);
            checkHealth(draft);
          }}
        >
          <Text style={styles.primaryBtnText}>Save & Check Health</Text>
        </TouchableOpacity>

        {checking && (
          <ActivityIndicator style={{ marginTop: 12 }} color="#FF6B35" />
        )}

        {healthStatus && !checking && (
          <View style={styles.healthCard}>
            <Text style={styles.healthTitle}>Health Status</Text>
            <Text style={styles.healthRow}>
              {dot(healthStatus.gateway)} Gateway
            </Text>
            <Text style={styles.healthRow}>
              {dot(healthStatus.rag)} RAG Server
            </Text>
            <Text style={styles.healthRow}>
              {dot(healthStatus.graph)} Graph API
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RAGScreen() {
  const { baseURL } = useApp();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { role: "user" | "bot"; text: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  async function send() {
    const q = input.trim();
    if (!q || !baseURL) return;
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${baseURL}/rag/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });

      if (!res.ok) throw new Error(`RAG returned ${res.status}`);

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: data.answer ?? JSON.stringify(data) },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        { role: "bot", text: `Error: ${message}` },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.chatScroll}
          contentContainerStyle={styles.chatContent}
        >
          {messages.length === 0 && (
            <Text style={styles.chatEmpty}>
              Ask the RescueMind RAG anything…
            </Text>
          )}
          {messages.map((m, i) => (
            <View
              key={i}
              style={[
                styles.bubble,
                m.role === "user" ? styles.bubbleUser : styles.bubbleBot,
              ]}
            >
              <Text style={styles.bubbleText}>{m.text}</Text>
            </View>
          ))}
          {loading && (
            <ActivityIndicator style={{ marginVertical: 8 }} color="#FF6B35" />
          )}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Type a query…"
            placeholderTextColor="#888"
            style={styles.chatInput}
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <TouchableOpacity style={styles.sendBtn} onPress={send}>
            <Ionicons name="send" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ───────────────── ROUTE SCREEN ───────────────── */

function RouteScreen() {
  const { location, baseURL } = useApp();
  const mapRef = useRef<MapView>(null);

  const [nearest, setNearest] = useState<NearestLocation | null>(null);
  const [routes, setRoutes] = useState<ServerRoute[]>([]);
  const [selectedType, setSelectedType] =
    useState<ServerRoute["type"]>("FASTEST");
  const [loadingNearest, setLoadingNearest] = useState(false);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRoute =
    routes.find((r) => r.type === selectedType) ?? routes[0] ?? null;

  const turnByTurn = useMemo((): TurnByTurnRoute | null => {
    if (!selectedRoute || selectedRoute.path.length < 2) return null;
    return buildDirectionsFromPath(
      selectedRoute.path,
      selectedRoute.distance,
      selectedRoute.time,
      ROUTE_LABELS[selectedRoute.type],
    );
  }, [selectedRoute]);

  // Re-fit + re-project when selected tab changes
  useEffect(() => {
    if (!routes.length || !mapRef.current) return;
    const route = routes.find((r) => r.type === selectedType);
    if (!route || route.path.length < 2) return;
    const coords: LatLng[] = route.path.map((p) => ({
      latitude: p.lat,
      longitude: p.lon,
    }));
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 80, right: 40, bottom: 320, left: 40 },
      animated: true,
    });
  }, [selectedType, routes]);

  const fetchNearest = useCallback(async () => {
    if (!location || !baseURL) {
      setError("Location or gateway not available.");
      return;
    }
    setError(null);
    setLoadingNearest(true);
    setRoutes([]);
    setNearest(null);
    try {
      const res = await fetch(
        `${baseURL}/nearest?lat=${location.latitude}&lon=${location.longitude}`,
      );
      if (!res.ok) throw new Error(`/nearest returned ${res.status}`);
      const raw = await res.json();
      console.log("[/nearest] raw response:", JSON.stringify(raw));
      const parsed = await resolveNearestLocation(raw);
      setNearest(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(`Nearest fetch failed: ${msg}`);
    } finally {
      setLoadingNearest(false);
    }
  }, [location, baseURL]);

  const fetchRoutes = useCallback(async () => {
    if (!location || !nearest || !baseURL) return;
    setError(null);
    setLoadingRoutes(true);
    setRoutes([]);
    try {
      const start = `${location.latitude},${location.longitude}`;
      const end = `${nearest.lat},${nearest.lon}`;
      const res = await fetch(
        `${baseURL}/graph/route?start=${start}&end=${end}`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `/graph/route returned ${res.status}${body ? `: ${body}` : ""}`,
        );
      }
      const data: { routes: ServerRoute[] } = await res.json();
      setRoutes(data.routes ?? []);
      if (data.routes?.length) setSelectedType(data.routes[0].type);

      const allCoords: LatLng[] = data.routes.flatMap((r) =>
        r.path.map((p) => ({ latitude: p.lat, longitude: p.lon })),
      );
      if (allCoords.length && mapRef.current) {
        mapRef.current.fitToCoordinates(allCoords, {
          edgePadding: { top: 80, right: 40, bottom: 260, left: 40 },
          animated: true,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(`Route fetch failed: ${msg}`);
    } finally {
      setLoadingRoutes(false);
    }
  }, [location, nearest, baseURL]);

  useEffect(() => {
    if (nearest) fetchRoutes();
  }, [nearest]);

  const isLoading = loadingNearest || loadingRoutes;

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        showsUserLocation
        mapType={MAP_TYPES.STANDARD}
        initialRegion={{
          latitude: location?.latitude ?? 18.5274,
          longitude: location?.longitude ?? 73.8732,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {/* Inactive routes */}
        {routes
          .filter((r) => r.type !== selectedType)
          .map((r) => (
            <Polyline
              key={r.type}
              coordinates={r.path.map((p) => ({
                latitude: p.lat,
                longitude: p.lon,
              }))}
              strokeColor="rgba(180,180,200,0.4)"
              strokeWidth={3}
              lineDashPattern={[8, 6]}
            />
          ))}

        {(() => {
          const active = routes.find((r) => r.type === selectedType);
          if (!active) return null;
          const coords = active.path.map((p) => ({
            latitude: p.lat,
            longitude: p.lon,
          }));
          return (
            <>
              <Polyline
                coordinates={coords}
                strokeColor="rgba(255,255,255,0.92)"
                strokeWidth={12}
                zIndex={9}
                geodesic
              />
              <Polyline
                coordinates={coords}
                strokeColor="#0099ff"
                strokeWidth={7}
                zIndex={10}
                geodesic
              />
            </>
          );
        })()}

        {nearest && typeof nearest.lat === "number" && (
          <Marker
            coordinate={{ latitude: nearest.lat, longitude: nearest.lon }}
            title={nearest.name ?? "Nearest Location"}
            pinColor="#FF6B35"
          />
        )}
      </MapView>

      {/* Bottom panel — completely unchanged */}
      <View style={styles.routePanel}>
        {error && <Text style={styles.errorText}>{error}</Text>}

        {routes.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.routeTabs}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}
          >
            {routes.map((r) => (
              <TouchableOpacity
                key={r.type}
                style={[
                  styles.routeTab,
                  {
                    backgroundColor:
                      r.type === selectedType
                        ? ROUTE_COLORS[r.type]
                        : "#1e1e2e",
                    borderColor: ROUTE_COLORS[r.type],
                  },
                ]}
                onPress={() => setSelectedType(r.type)}
              >
                <Text
                  style={[
                    styles.routeTabLabel,
                    {
                      color:
                        r.type === selectedType ? "#fff" : ROUTE_COLORS[r.type],
                    },
                  ]}
                >
                  {ROUTE_LABELS[r.type]}
                </Text>
                <Text style={styles.routeTabSub}>
                  {(r.distance / 1000).toFixed(2)} km · {Math.round(r.time)} s
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {routes.length > 0 && location && nearest && turnByTurn ? (
          <View style={styles.directionsSection}>
            <View style={styles.directionsSummaryBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.directionsSummary} numberOfLines={1}>
                  {ROUTE_LABELS[selectedType]}
                </Text>
                <Text style={styles.directionsEta}>
                  {turnByTurn.duration} · {turnByTurn.distance}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.openMapsBtn}
                onPress={() =>
                  openDirectionsInOpenStreetMap(location, {
                    latitude: nearest.lat,
                    longitude: nearest.lon,
                  })
                }
              >
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.openMapsBtnText}>OSM</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.directionsScroll}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {turnByTurn.steps.map((step, i) => {
                const isLast = i === turnByTurn.steps.length - 1;
                const icon = isLast
                  ? "flag"
                  : step.maneuver?.toLowerCase().includes("left")
                    ? "arrow-back"
                    : step.maneuver?.toLowerCase().includes("right")
                      ? "arrow-forward"
                      : step.maneuver?.toLowerCase().includes("u-turn")
                        ? "return-up-back"
                        : i === 0
                          ? "navigate"
                          : "arrow-up";
                return (
                  <View
                    key={`${step.startLat}-${step.startLng}-${i}`}
                    style={styles.directionStep}
                  >
                    <View style={styles.directionStepLeft}>
                      <View
                        style={[
                          styles.directionStepDot,
                          {
                            backgroundColor: isLast
                              ? "#e74c3c"
                              : ROUTE_COLORS[selectedType],
                          },
                        ]}
                      >
                        <Ionicons name={icon as any} size={12} color="#fff" />
                      </View>
                      {!isLast && (
                        <View
                          style={[
                            styles.directionStepLine,
                            {
                              backgroundColor:
                                ROUTE_COLORS[selectedType] + "55",
                            },
                          ]}
                        />
                      )}
                    </View>
                    <View style={styles.directionStepBody}>
                      <Text style={styles.directionStepText}>
                        {step.instruction}
                      </Text>
                      {(step.distance !== "—" || step.duration !== "—") && (
                        <Text style={styles.directionStepMeta}>
                          {step.distance !== "—" ? step.distance : ""}
                          {step.distance !== "—" && step.duration !== "—"
                            ? "  ·  "
                            : ""}
                          {step.duration !== "—" ? step.duration : ""}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {nearest && (
          <View style={styles.nearestInfo}>
            <Text style={styles.nearestTitle}>
              📍 {nearest.name ?? "Nearest Location"}
            </Text>
            <Text style={styles.nearestCoord}>
              {typeof nearest.lat === "number" ? nearest.lat.toFixed(5) : "—"},{" "}
              {typeof nearest.lon === "number" ? nearest.lon.toFixed(5) : "—"}
              {typeof nearest.distance_km === "number"
                ? `  ·  ${nearest.distance_km.toFixed(1)} km away`
                : ""}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.primaryBtn, { marginTop: 8 }]}
          onPress={fetchNearest}
          disabled={isLoading || !location || !baseURL}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>
              {routes.length > 0
                ? "🔄 Refresh Route"
                : "🚀 Find Nearest & Route"}
            </Text>
          )}
        </TouchableOpacity>

        {!baseURL && (
          <Text style={styles.hintText}>
            ⚠️ Set gateway IP in Config tab first
          </Text>
        )}
        {!location && (
          <Text style={styles.hintText}>⚠️ Waiting for GPS location…</Text>
        )}
      </View>
    </View>
  );
}

/* ───────────────── STYLES ───────────────── */

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0d0d1a",
  },
  /* Config */
  configContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  heading: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 12,
    marginTop: 8,
  },
  label: {
    fontSize: 13,
    color: "#aaa",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 10,
    padding: 12,
    color: "#fff",
    backgroundColor: "#1a1a2e",
    fontSize: 15,
    marginBottom: 12,
  },
  primaryBtn: {
    backgroundColor: "#FF6B35",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  healthCard: {
    marginTop: 16,
    backgroundColor: "#1a1a2e",
    borderRadius: 12,
    padding: 16,
    gap: 6,
  },
  healthTitle: {
    color: "#fff",
    fontWeight: "700",
    marginBottom: 4,
  },
  healthRow: {
    color: "#ccc",
    fontSize: 14,
  },
  /* RAG chat */
  chatScroll: {
    flex: 1,
    backgroundColor: "#0d0d1a",
  },
  chatContent: {
    padding: 16,
    paddingBottom: 8,
  },
  chatEmpty: {
    color: "#555",
    textAlign: "center",
    marginTop: 60,
    fontSize: 15,
  },
  bubble: {
    maxWidth: "82%",
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "#FF6B35",
  },
  bubbleBot: {
    alignSelf: "flex-start",
    backgroundColor: "#1e1e2e",
  },
  bubbleText: {
    color: "#fff",
    fontSize: 14,
    lineHeight: 20,
  },
  inputRow: {
    flexDirection: "row",
    padding: 10,
    gap: 8,
    backgroundColor: "#0d0d1a",
    borderTopWidth: 1,
    borderTopColor: "#222",
  },
  chatInput: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: "#FF6B35",
    borderRadius: 20,
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  /* Route panel */
  routePanel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(13,13,26,0.95)",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    paddingBottom: 28,
    gap: 8,
  },
  routeTabs: {
    flexGrow: 0,
  },
  routeTab: {
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 110,
    alignItems: "center",
  },
  routeTabLabel: {
    fontWeight: "700",
    fontSize: 13,
  },
  routeTabSub: {
    color: "#aaa",
    fontSize: 11,
    marginTop: 2,
  },
  nearestInfo: {
    backgroundColor: "#1a1a2e",
    borderRadius: 10,
    padding: 10,
  },
  nearestTitle: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  nearestCoord: {
    color: "#aaa",
    fontSize: 12,
    marginTop: 2,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 13,
    textAlign: "center",
    backgroundColor: "#2a0a0a",
    borderRadius: 8,
    padding: 8,
  },
  hintText: {
    color: "#888",
    fontSize: 12,
    textAlign: "center",
  },
  directionsSection: {
    gap: 6,
    marginTop: 4,
  },
  directionsSummaryBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1a2e",
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  directionsMetaRow: {
    backgroundColor: "#1a1a2e",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  directionsSummary: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  directionsEta: {
    color: "#aaa",
    fontSize: 12,
    marginTop: 2,
  },
  openMapsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#2d6cdf",
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  openMapsBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },
  directionsScroll: {
    maxHeight: 200,
  },
  directionStep: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 2,
  },
  directionStepLeft: {
    alignItems: "center",
    width: 24,
    paddingTop: 2,
  },
  directionStepDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  directionStepLine: {
    width: 2,
    flex: 1,
    minHeight: 16,
    marginTop: 2,
  },
  directionStepIdx: {
    fontWeight: "800",
    fontSize: 13,
    minWidth: 22,
  },
  directionStepBody: {
    flex: 1,
    paddingBottom: 12,
    gap: 2,
  },
  directionStepText: {
    color: "#eee",
    fontSize: 14,
    lineHeight: 20,
  },
  directionStepMeta: {
    color: "#888",
    fontSize: 12,
  },
});

/* ───────────────── ROOT ───────────────── */

const Tab = createBottomTabNavigator();

export default function App() {
  const [gatewayIP, setGatewayIP] = useState("");
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [location, setLocation] = useState<Coord | null>(null);

  const baseURL = normalizeGatewayUrl(gatewayIP);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;

      const loc = await Location.getCurrentPositionAsync({});
      setLocation({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
    })();
  }, []);

  const checkHealth = useCallback(
    async (ip?: string) => {
      const url = ip ? normalizeGatewayUrl(ip) : baseURL;
      if (!url) return;

      setChecking(true);
      try {
        const res = await fetch(`${url}/health`);
        const data: any = await res.json().catch(() => null);

        const parseOk = (value: any): boolean => {
          if (typeof value === "boolean") return value;
          if (typeof value === "string") return value.toLowerCase() === "ok";
          if (value && typeof value === "object") {
            const status =
              value.status ?? value.state ?? value.health ?? value.result;
            return typeof status === "string"
              ? status.toLowerCase() === "ok"
              : typeof status === "boolean"
                ? status
                : false;
          }
          return false;
        };

        const hasField = (obj: any, key: string) =>
          obj && Object.prototype.hasOwnProperty.call(obj, key);

        const gatewayRaw = data?.gateway;
        const gateway =
          hasField(data, "gateway") && typeof gatewayRaw === "string"
            ? gatewayRaw.toLowerCase() === "ok" ||
              gatewayRaw.toLowerCase() === "up"
            : hasField(data, "gateway")
              ? parseOk(gatewayRaw)
              : null;

        setHealthStatus({
          gateway,
          rag: hasField(data, "rag") ? parseOk(data.rag) : null,
          graph: hasField(data, "graph") ? parseOk(data.graph) : null,
        });
      } catch {
        setHealthStatus({ gateway: false, rag: null, graph: null });
      } finally {
        setChecking(false);
      }
    },
    [baseURL],
  );

  const ctx: AppContextType = {
    gatewayIP,
    setGatewayIP,
    baseURL,
    healthStatus,
    checking,
    checkHealth,
    location,
  };

  return (
    <AppContext.Provider value={ctx}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#0d0d1a" />
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarStyle: {
              backgroundColor: "#0d0d1a",
              borderTopColor: "#222",
            },
            tabBarActiveTintColor: "#FF6B35",
            tabBarInactiveTintColor: "#555",
            tabBarIcon: ({ color, size }) => {
              const icons: Record<string, any> = {
                Config: "settings-outline",
                RAG: "chatbubble-ellipses-outline",
                Navigate: "navigate-outline",
              };
              return (
                <Ionicons name={icons[route.name]} size={size} color={color} />
              );
            },
          })}
        >
          <Tab.Screen name="Config" component={ConfigScreen} />
          <Tab.Screen name="RAG" component={RAGScreen} />
          <Tab.Screen name="Navigate" component={RouteScreen} />
        </Tab.Navigator>
      </SafeAreaProvider>
    </AppContext.Provider>
  );
}
