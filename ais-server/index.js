const WebSocket = require("ws");
const Redis = require("ioredis");

const redis = new Redis();
const AIS_KEY = "YOUR_KEY";

const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (client) => {
  console.log("📱 App connected");

  const ais = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ais.on("open", () => {
    console.log("🌐 AIS connected");

    ais.send(
      JSON.stringify({
        APIKey: AIS_KEY,
        BoundingBoxes: [
          [
            [12, 73],
            [14, 76],
          ],
        ],
      }),
    );
  });

  ais.on("message", async (data) => {
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
  });

  // stream processed data to app every second
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
