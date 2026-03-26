import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
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
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as Location from "expo-location";
import MapView, {
  Polyline,
  Marker,
  PROVIDER_GOOGLE,
  LatLng,
} from "react-native-maps";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";

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

type GoogleRoute = {
  index: number;
  summary: string;
  distance: string;
  duration: string;
  distanceM: number;
  durationS: number;
  polyline: LatLng[];
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
 * the Google Maps Geocoding API to obtain coordinates.
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

  const res = await fetch(nominatimUrl, {
    headers: { "User-Agent": "RescueMindApp/1.0" },
  });
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
  googleApiRequestCount: number;
  googleApiBlocked: boolean;
  resetGoogleApiQuota: () => Promise<void>;
};

/* ───────────────── CONTEXT ───────────────── */

const AppContext = createContext<AppContextType>({} as AppContextType);
const useApp = () => useContext(AppContext);

/* ───────────────── CONFIG ───────────────── */

const GMAPS_KEY =
  Constants.expoConfig?.extra?.googleMapsApiKey ??
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ??
  "";
const GOOGLE_API_REQUEST_LIMIT = 500;
const GOOGLE_API_QUOTA_FILE =
  (FileSystem.documentDirectory ?? "") + "google-api-quota.json";

/* ───────────────── UTILS ───────────────── */

function decodePolyline(encoded: string): LatLng[] {
  let index = 0,
    lat = 0,
    lng = 0;
  const result: LatLng[] = [];

  while (index < encoded.length) {
    let b,
      shift = 0,
      result_ = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result_ |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lat += result_ & 1 ? ~(result_ >> 1) : result_ >> 1;

    shift = 0;
    result_ = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result_ |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    lng += result_ & 1 ? ~(result_ >> 1) : result_ >> 1;

    result.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return result;
}

function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

type GoogleApiQuotaState = {
  requestCount: number;
  blocked: boolean;
};

async function writeGoogleApiQuotaState(
  state: GoogleApiQuotaState,
): Promise<void> {
  await FileSystem.writeAsStringAsync(
    GOOGLE_API_QUOTA_FILE,
    JSON.stringify(state),
  );
}

async function getGoogleApiQuotaState(): Promise<{
  requestCount: number;
  blocked: boolean;
}> {
  try {
    if (!FileSystem.documentDirectory) {
      return { requestCount: 0, blocked: false };
    }

    const fileInfo = await FileSystem.getInfoAsync(GOOGLE_API_QUOTA_FILE);
    if (!fileInfo.exists) {
      return { requestCount: 0, blocked: false };
    }

    const raw = await FileSystem.readAsStringAsync(GOOGLE_API_QUOTA_FILE);
    const parsed = JSON.parse(raw) as Partial<GoogleApiQuotaState>;
    const requestCount =
      typeof parsed.requestCount === "number" &&
      Number.isFinite(parsed.requestCount)
        ? parsed.requestCount
        : 0;
    const blocked = parsed.blocked === true;

    return { requestCount, blocked };
  } catch {
    return { requestCount: 0, blocked: false };
  }
}

async function setGoogleApiBlocked(blocked: boolean): Promise<void> {
  const state = await getGoogleApiQuotaState();
  await writeGoogleApiQuotaState({ ...state, blocked });
}

async function assertGoogleApiCallAllowed() {
  const state = await getGoogleApiQuotaState();

  if (state.blocked || state.requestCount >= GOOGLE_API_REQUEST_LIMIT) {
    await setGoogleApiBlocked(true);
    Alert.alert(
      "Google API limit reached",
      "Maximum 500 requests reached. Google API calls are blocked until you manually reset the counter.",
    );
    throw new Error("GOOGLE_API_LIMIT_REACHED");
  }
}

async function incrementGoogleApiRequestCounter(): Promise<number> {
  const state = await getGoogleApiQuotaState();
  const nextCount = state.requestCount + 1;
  const shouldBlock = nextCount >= GOOGLE_API_REQUEST_LIMIT;

  await writeGoogleApiQuotaState({
    requestCount: nextCount,
    blocked: shouldBlock,
  });

  if (shouldBlock) {
    Alert.alert(
      "Google API limit reached",
      "Maximum 500 requests reached. Google API calls are now blocked until you manually reset the counter.",
    );
  }

  return nextCount;
}

/* ───────────────── GOOGLE DIRECTIONS ───────────────── */

async function fetchGoogleDirections(
  origin: Coord,
  destination: Coord,
): Promise<GoogleRoute[]> {
  await assertGoogleApiCallAllowed();

  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${origin.latitude},${origin.longitude}` +
    `&destination=${destination.latitude},${destination.longitude}` +
    `&alternatives=true` +
    `&key=${GMAPS_KEY}`;

  const res = await fetch(url);
  const data = await res.json();
  await incrementGoogleApiRequestCounter();

  if (data.status !== "OK") throw new Error(data.status);

  return data.routes.map(
    (r: any, i: number): GoogleRoute => ({
      index: i,
      summary: r.summary,
      distance: r.legs[0].distance.text,
      duration: r.legs[0].duration.text,
      distanceM: r.legs[0].distance.value,
      durationS: r.legs[0].duration.value,
      polyline: decodePolyline(r.overview_polyline.points),
      steps: r.legs[0].steps.map(
        (s: any): Step => ({
          instruction: s.html_instructions.replace(/<[^>]*>/g, ""),
          distance: s.distance.text,
          duration: s.duration.text,
          maneuver: s.maneuver,
          startLat: s.start_location.lat,
          startLng: s.start_location.lng,
        }),
      ),
    }),
  );
}

/* ───────────────── ROUTE COLORS ───────────────── */

const ROUTE_COLORS: Record<ServerRoute["type"], string> = {
  FASTEST: "#FF6B35", // orange
  SAFEST: "#2EC4B6", // teal
  SHORTEST: "#9B59B6", // purple
};

const ROUTE_LABELS: Record<ServerRoute["type"], string> = {
  FASTEST: "⚡ Fastest",
  SAFEST: "🛡 Safest",
  SHORTEST: "📏 Shortest",
};

/* ───────────────── SCREENS ───────────────── */

function ConfigScreen() {
  const {
    gatewayIP,
    setGatewayIP,
    checkHealth,
    healthStatus,
    checking,
    googleApiRequestCount,
    googleApiBlocked,
    resetGoogleApiQuota,
  } = useApp();
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

        <View style={styles.divider} />

        <Text style={styles.heading}>Google Maps API</Text>
        <View style={styles.quotaCard}>
          <Text style={styles.quotaText}>
            Requests used:{" "}
            <Text style={styles.quotaBold}>
              {googleApiRequestCount} / {GOOGLE_API_REQUEST_LIMIT}
            </Text>
          </Text>
          <Text style={styles.quotaText}>
            Status:{" "}
            <Text
              style={[
                styles.quotaBold,
                { color: googleApiBlocked ? "#e74c3c" : "#2ecc71" },
              ]}
            >
              {googleApiBlocked ? "Blocked" : "Active"}
            </Text>
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: "#555" }]}
          onPress={resetGoogleApiQuota}
        >
          <Text style={styles.primaryBtnText}>Reset API Counter</Text>
        </TouchableOpacity>
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

  // Derived: selected route polyline
  const selectedRoute =
    routes.find((r) => r.type === selectedType) ?? routes[0] ?? null;

  const selectedPolyline: LatLng[] = selectedRoute
    ? selectedRoute.path.map((p) => ({ latitude: p.lat, longitude: p.lon }))
    : [];

  // Step 1: fetch nearest location from server
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

  // Step 2: fetch routes once we have nearest
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

      // Fit map to show full route
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

  // Auto-fetch routes when nearest changes
  useEffect(() => {
    if (nearest) fetchRoutes();
  }, [nearest]);

  const isLoading = loadingNearest || loadingRoutes;

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        showsUserLocation
        initialRegion={{
          latitude: location?.latitude ?? 18.5274,
          longitude: location?.longitude ?? 73.8732,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {/* All routes (dimmed) */}
        {routes.map((r) => {
          const coords = r.path.map((p) => ({
            latitude: p.lat,
            longitude: p.lon,
          }));
          const isSelected = r.type === selectedType;
          return (
            <Polyline
              key={r.type}
              coordinates={coords}
              strokeColor={isSelected ? ROUTE_COLORS[r.type] : "#ccc"}
              strokeWidth={isSelected ? 5 : 2}
              zIndex={isSelected ? 10 : 1}
            />
          );
        })}

        {/* Nearest location marker */}
        {nearest &&
          typeof nearest.lat === "number" &&
          typeof nearest.lon === "number" && (
            <Marker
              coordinate={{ latitude: nearest.lat, longitude: nearest.lon }}
              title={nearest.name ?? "Nearest Location"}
              description={`${nearest.lat.toFixed(5)}, ${nearest.lon.toFixed(5)}`}
              pinColor="#FF6B35"
            />
          )}
      </MapView>

      {/* Overlay panel */}
      <View style={styles.routePanel}>
        {error && <Text style={styles.errorText}>{error}</Text>}

        {/* Route type selector */}
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

        {/* Nearest info */}
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

        {/* Action button */}
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
  divider: {
    height: 1,
    backgroundColor: "#222",
    marginVertical: 20,
  },
  quotaCard: {
    backgroundColor: "#1a1a2e",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    gap: 6,
  },
  quotaText: {
    color: "#ccc",
    fontSize: 14,
  },
  quotaBold: {
    fontWeight: "700",
    color: "#fff",
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
});

/* ───────────────── ROOT ───────────────── */

const Tab = createBottomTabNavigator();

export default function App() {
  const [gatewayIP, setGatewayIP] = useState("");
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [location, setLocation] = useState<Coord | null>(null);
  const [googleApiRequestCount, setGoogleApiRequestCount] = useState(0);
  const [googleApiBlocked, setGoogleApiBlocked] = useState(false);

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

  const loadGoogleApiQuota = useCallback(async () => {
    const state = await getGoogleApiQuotaState();
    setGoogleApiRequestCount(state.requestCount);
    setGoogleApiBlocked(
      state.blocked || state.requestCount >= GOOGLE_API_REQUEST_LIMIT,
    );
  }, []);

  useEffect(() => {
    void loadGoogleApiQuota();
  }, [loadGoogleApiQuota]);

  const resetGoogleApiQuota = useCallback(async () => {
    await writeGoogleApiQuotaState({ requestCount: 0, blocked: false });
    setGoogleApiRequestCount(0);
    setGoogleApiBlocked(false);
    Alert.alert("Reset complete", "Google API counter reset to 0.");
  }, []);

  const checkHealth = useCallback(
    async (ip?: string) => {
      const url = ip ? normalizeGatewayUrl(ip) : baseURL;
      if (!url) return;

      setChecking(true);
      try {
        const res = await fetch(`${url}/health`);
        const data = await res.json();

        setHealthStatus({
          gateway: true,
          rag: data.rag === "ok",
          graph: data.graph === "ok",
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
    googleApiRequestCount,
    googleApiBlocked,
    resetGoogleApiQuota,
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
