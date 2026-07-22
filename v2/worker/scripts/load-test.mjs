const target = process.env.POND_LOAD_URL ?? "ws://127.0.0.1:8787/ws/v3";
const clientCount = Math.max(1, Math.min(200, Number(process.argv[2] ?? 100)));
const timeoutMs = Math.max(15_000, Number(process.env.POND_LOAD_TIMEOUT_MS ?? 60_000));
const batchSize = Math.max(1, Number(process.env.POND_LOAD_BATCH_SIZE ?? 10));
const batchDelayMs = Math.max(0, Number(process.env.POND_LOAD_BATCH_DELAY_MS ?? 150));
const waveTest = process.env.POND_LOAD_WAVES === "1";
const statusUrl = new URL("/api/v3/status", target.replace(/^ws/, "http"));
const initialStatusResponse = await fetch(statusUrl);
const initialStatus = initialStatusResponse.ok ? await initialStatusResponse.json() : null;

if (clientCount > 150 && process.env.POND_ALLOW_LARGE_LOAD !== "1") {
  throw new Error("Loads above 150 clients require POND_ALLOW_LARGE_LOAD=1.");
}
if (clientCount > 20 && process.env.POND_ALLOW_PERSISTENT_LOAD !== "1") {
  throw new Error("Embodied load clients create persistent lives. Use an isolated preview and set POND_ALLOW_PERSISTENT_LOAD=1.");
}

const sockets = [];
const clients = Array.from({ length: clientCount }, (_, index) => ({
  index,
  welcomed: false,
  settled: false,
  delta: false,
  closedEarly: false,
  waveTimer: null,
}));
const startedAt = performance.now();
const counters = {
  opened: 0,
  welcomed: 0,
  born: 0,
  queued: 0,
  deltas: 0,
  bytes: 0,
  maxMessageBytes: 0,
  rippleBatchesSent: 0,
  errors: [],
};

function requestId(prefix, index) {
  return `${prefix}_${index}_${Date.now().toString(36)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectClient(client) {
  const url = new URL(target);
  url.searchParams.set("connection", `load-${client.index}-${crypto.randomUUID()}`);
  const socket = new WebSocket(url);
  sockets.push(socket);

  socket.addEventListener("open", () => {
    counters.opened++;
    socket.send(JSON.stringify({
      v: 3,
      type: "hello",
      requestId: requestId("hello", client.index),
      renderer: "webgl",
      reducedMotion: true,
      clientTime: Date.now(),
    }));
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const bytes = Buffer.byteLength(event.data);
    counters.bytes += bytes;
    counters.maxMessageBytes = Math.max(counters.maxMessageBytes, bytes);
    let message;
    try { message = JSON.parse(event.data); }
    catch { counters.errors.push(`client ${client.index}: invalid JSON`); return; }

    if (message.type === "welcome" && !client.welcomed) {
      client.welcomed = true;
      counters.welcomed++;
      const angle = client.index / clientCount * Math.PI * 2;
      socket.send(JSON.stringify({
        v: 3,
        type: "incarnate",
        requestId: requestId("birth", client.index),
        point: {
          x: 0.5 + Math.cos(angle) * (0.08 + (client.index % 17) * 0.018),
          z: 0.5 + Math.sin(angle) * (0.08 + (client.index % 17) * 0.018),
        },
      }));
      return;
    }

    if (message.type === "ritualAck" && message.requestId?.startsWith("birth_") && !client.settled) {
      client.settled = true;
      if (message.accepted) {
        counters.born++;
        if (waveTest) {
          let sent = 0;
          client.waveTimer = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN || sent >= 10) {
              clearInterval(client.waveTimer);
              client.waveTimer = null;
              return;
            }
            const phase = (client.index * 0.37 + sent * 0.19) % (Math.PI * 2);
            const points = Array.from({ length: 12 }, (_, pointIndex) => ({
              x: Math.max(0.02, Math.min(0.98, 0.5 + Math.cos(phase + pointIndex * 0.11) * 0.2)),
              z: Math.max(0.02, Math.min(0.98, 0.5 + Math.sin(phase + pointIndex * 0.11) * 0.2)),
            }));
            socket.send(JSON.stringify({
              v: 3,
              type: "rippleBatch",
              requestId: requestId("ripples", client.index),
              points,
            }));
            counters.rippleBatchesSent++;
            sent++;
          }, 100);
        }
      }
      else counters.errors.push(`client ${client.index}: birth rejected (${message.reason ?? "unknown"})`);
      return;
    }

    if (message.type === "queue" && message.requestId?.startsWith("birth_") && !client.settled) {
      client.settled = true;
      counters.queued++;
      return;
    }

    if (message.type === "delta") {
      counters.deltas++;
      client.delta = true;
      return;
    }

    if (message.type === "error") counters.errors.push(`client ${client.index}: ${message.code}`);
  });

  socket.addEventListener("error", () => {
    counters.errors.push(`client ${client.index}: socket error`);
  });

  socket.addEventListener("close", () => {
    if (!client.settled) client.closedEarly = true;
  });
}

for (let index = 0; index < clients.length; index += batchSize) {
  for (const client of clients.slice(index, index + batchSize)) connectClient(client);
  if (index + batchSize < clients.length) await wait(batchDelayMs);
}

const deadline = performance.now() + timeoutMs;
while (performance.now() < deadline) {
  const settled = counters.born + counters.queued;
  if (counters.welcomed === clientCount && settled === clientCount && clients.every((client) => client.delta)) break;
  await wait(100);
}

await wait(waveTest ? 1500 : 750);
const statusResponse = await fetch(statusUrl);
const status = statusResponse.ok ? await statusResponse.json() : { status: statusResponse.status };
const finishedAt = performance.now();
const summary = {
  target,
  requested: clientCount,
  elapsedMs: Math.round(finishedAt - startedAt),
  opened: counters.opened,
  welcomed: counters.welcomed,
  born: counters.born,
  queued: counters.queued,
  clientsWithDelta: clients.filter((client) => client.delta).length,
  earlyCloses: clients.filter((client) => client.closedEarly).length,
  totalMessages: counters.deltas,
  receivedMiB: Number((counters.bytes / 1024 / 1024).toFixed(2)),
  maxMessageKiB: Number((counters.maxMessageBytes / 1024).toFixed(2)),
  rippleBatchesSent: counters.rippleBatchesSent,
  baselineEmbodied: Number(initialStatus?.capacity?.embodied ?? 0),
  errors: counters.errors.slice(0, 20),
  status,
};

for (const client of clients) {
  if (client.waveTimer !== null) clearInterval(client.waveTimer);
  client.waveTimer = null;
}
for (const socket of sockets) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ v: 3, type: "leave", requestId: requestId("leave", 0) }));
    socket.close(1000, "load test complete");
  }
}

const capacityLimit = Number(status?.capacity?.limit ?? clientCount);
const baselineEmbodied = Number(initialStatus?.capacity?.embodied ?? 0);
const expectedEmbodied = Math.min(clientCount, Math.max(0, capacityLimit - baselineEmbodied));
const expectedQueued = clientCount - expectedEmbodied;
const passed = counters.opened === clientCount
  && counters.welcomed === clientCount
  && counters.born === expectedEmbodied
  && counters.queued === expectedQueued
  && counters.born + counters.queued === clientCount
  && clients.every((client) => client.delta)
  && clients.every((client) => !client.closedEarly)
  && counters.errors.length === 0
  && Number(status?.capacity?.embodied) === baselineEmbodied + expectedEmbodied;

console.log(JSON.stringify({ passed, ...summary }, null, 2));
await wait(100);
process.exit(passed ? 0 : 1);
