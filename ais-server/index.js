const WebSocket = require("ws");
const Redis = require("ioredis");

const redis = new Redis();
const AIS_KEY = "YOUR_AIS_KEY";

// ---------- Prediction Engine ----------
function predictPosition(ship) {
  const now = Date.now();
  const dt = (now - ship.lastUpdate) / 1000;

  if (!ship.sog || !ship.cog) return ship;

  const speed = ship.sog * 0.514444;
  const distance = speed * dt;

  const R = 6371000;
  const bearing = (ship.cog * Math.PI) / 180;

  const lat1 = (ship.lat * Math.PI) / 180;
  const lon1 = (ship.lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance / R) +
      Math.cos(lat1) * Math.sin(distance / R) * Math.cos(bearing),
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance / R) * Math.cos(lat1),
      Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: (lat2 * 180) / Math.PI,
    lon: (lon2 * 180) / Math.PI,
    sog: ship.sog,
    cog: ship.cog,
  };
}

// ---------- AIS + App Server ----------
const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (client) => {
  console.log("📱 App connected");

  let bbox = [
    [12, 73],
    [14, 76],
  ];

  const ais = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ais.on("open", () => {
    console.log("🌐 AIS connected");

    ais.send(
      JSON.stringify({
        APIKey: AIS_KEY,
        BoundingBoxes: [bbox],
      }),
    );
  });

  ais.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);

      if (!msg?.Message?.PositionReport) return;

      const ship = msg.Message.PositionReport;

      const key = `ship:${ship.UserID}`;

      await redis.set(
        key,
        JSON.stringify({
          lat: ship.Latitude,
          lon: ship.Longitude,
          sog: ship.Sog,
          cog: ship.Cog,
          lastUpdate: Date.now(),
        }),
        "EX",
        300,
      );
    } catch (err) {
      console.error("AIS parse error", err);
    }
  });

  // receive bbox updates from app
  client.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.bbox) {
        bbox = data.bbox;

        console.log("📦 Updating bbox:", bbox);

        ais.send(
          JSON.stringify({
            APIKey: AIS_KEY,
            BoundingBoxes: [bbox],
          }),
        );
      }
    } catch {}
  });

  // send predicted ships every second
  const interval = setInterval(async () => {
    const keys = await redis.keys("ship:*");

    let ships = [];

    for (let key of keys) {
      const data = await redis.get(key);
      if (!data) continue;

      const ship = JSON.parse(data);
      const predicted = predictPosition(ship);

      ships.push({
        mmsi: key.split(":")[1],
        ...predicted,
      });
    }

    client.send(JSON.stringify(ships));
  }, 1000);

  client.on("close", () => {
    clearInterval(interval);
    ais.close();
    console.log("📱 App disconnected");
  });
});

console.log("🚀 Server running on ws://localhost:8080");
