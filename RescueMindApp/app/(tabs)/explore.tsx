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
import AsyncStorage from "@react-native-async-storage/async-storage";

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
const GOOGLE_API_REQUEST_COUNT_KEY = "@rescuemind/google_api_request_count";
const GOOGLE_API_BLOCKED_KEY = "@rescuemind/google_api_blocked";

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

async function getGoogleApiQuotaState(): Promise<{
  requestCount: number;
  blocked: boolean;
}> {
  const [countRaw, blockedRaw] = await Promise.all([
    AsyncStorage.getItem(GOOGLE_API_REQUEST_COUNT_KEY),
    AsyncStorage.getItem(GOOGLE_API_BLOCKED_KEY),
  ]);

  const parsedCount = Number.parseInt(countRaw ?? "0", 10);

  return {
    requestCount: Number.isFinite(parsedCount) ? parsedCount : 0,
    blocked: blockedRaw === "true",
  };
}

async function assertGoogleApiCallAllowed() {
  const state = await getGoogleApiQuotaState();

  if (state.blocked || state.requestCount >= GOOGLE_API_REQUEST_LIMIT) {
    await AsyncStorage.setItem(GOOGLE_API_BLOCKED_KEY, "true");
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

  await Promise.all([
    AsyncStorage.setItem(GOOGLE_API_REQUEST_COUNT_KEY, String(nextCount)),
    AsyncStorage.setItem(
      GOOGLE_API_BLOCKED_KEY,
      shouldBlock ? "true" : "false",
    ),
  ]);

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

/* ───────────────── SCREENS ───────────────── */

function ConfigScreen() {
  const {
    gatewayIP,
    setGatewayIP,
    checkHealth,
    googleApiRequestCount,
    googleApiBlocked,
    resetGoogleApiQuota,
  } = useApp();
  const [draft, setDraft] = useState(gatewayIP);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ padding: 20 }}>
        <Text>Gateway</Text>

        <TextInput
          value={draft}
          onChangeText={setDraft}
          style={{ borderWidth: 1, padding: 10 }}
        />

        <TouchableOpacity
          onPress={() => {
            setGatewayIP(draft);
            checkHealth(draft);
          }}
        >
          <Text>Save</Text>
        </TouchableOpacity>

        <View style={{ marginTop: 16 }}>
          <Text>Google API usage: {googleApiRequestCount}/500</Text>
          <Text>Status: {googleApiBlocked ? "Blocked" : "Active"}</Text>
        </View>

        <TouchableOpacity
          onPress={resetGoogleApiQuota}
          style={{ marginTop: 10 }}
        >
          <Text>Reset Google API Counter</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function RAGScreen() {
  const { baseURL } = useApp();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  async function send() {
    if (!input || !baseURL) return;

    const res = await fetch(`${baseURL}/rag/query`, {
      method: "POST",
      body: JSON.stringify({ query: input }),
    });

    const data = await res.json();
    setMessages((prev) => [...prev, data.answer ?? JSON.stringify(data)]);
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView>
        {messages.map((m, i) => (
          <Text key={i}>{m}</Text>
        ))}
      </ScrollView>

      <TextInput value={input} onChangeText={setInput} />
      <TouchableOpacity onPress={send}>
        <Text>Send</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function RouteScreen() {
  const { location } = useApp();
  const mapRef = useRef<MapView>(null);

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={{ flex: 1 }}
        showsUserLocation
        initialRegion={{
          latitude: location?.latitude ?? 18.5,
          longitude: location?.longitude ?? 73.8,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      />
    </View>
  );
}

/* ───────────────── ROOT ───────────────── */

const Tab = createBottomTabNavigator();

export default function App() {
  const [gatewayIP, setGatewayIP] = useState("");
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [location, setLocation] = useState<Coord | null>(null);
  const [googleApiRequestCount, setGoogleApiRequestCount] = useState(0);
  const [googleApiBlocked, setGoogleApiBlocked] = useState(false);

  const baseURL = gatewayIP.trim();

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
    await Promise.all([
      AsyncStorage.setItem(GOOGLE_API_REQUEST_COUNT_KEY, "0"),
      AsyncStorage.setItem(GOOGLE_API_BLOCKED_KEY, "false"),
    ]);
    setGoogleApiRequestCount(0);
    setGoogleApiBlocked(false);
    Alert.alert("Reset complete", "Google API counter reset to 0.");
  }, []);

  const checkHealth = useCallback(
    async (ip?: string) => {
      const url = ip ?? baseURL;
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
        <Tab.Navigator screenOptions={{ headerShown: false }}>
          <Tab.Screen name="Config" component={ConfigScreen} />
          <Tab.Screen name="RAG" component={RAGScreen} />
          <Tab.Screen name="Navigate" component={RouteScreen} />
        </Tab.Navigator>
      </SafeAreaProvider>
    </AppContext.Provider>
  );
}
