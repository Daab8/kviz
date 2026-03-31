"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const mqtt = require("mqtt");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "..");
const BACKEND = path.resolve(__dirname, "..");
const BOARD_MAIN = path.join(ROOT, "board", "main.py");
const OTA_DIR = path.join(BACKEND, "public", "ota");
const OTA_MAIN = path.join(OTA_DIR, "main.py");

const API_HOST = process.env.OTA_API_HOST || "127.0.0.1";
const API_PORT = Number(process.env.OTA_API_PORT || process.env.PORT || 80);
const MQTT_HOST = process.env.MQTT_HOST || "127.0.0.1";
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
function detectPublicHost() {
  if (process.env.OTA_PUBLIC_HOST) return process.env.OTA_PUBLIC_HOST;
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      // Node may return 'IPv4' or 4 depending on platform
      const fam = ni.family || ni.family === 4 ? String(ni.family) : "";
      if (!/4|IPv4/.test(String(ni.family))) continue;
      if (ni.internal) continue;
      candidates.push({ name, address: ni.address });
    }
  }
  if (candidates.length === 0) return "127.0.0.1";
  // Prefer addresses that end with .1 (common hotspot/gateway address)
  const dot1 = candidates.find((c) => c.address.split(".").pop() === "1");
  if (dot1) return dot1.address;
  // Prefer interfaces whose name hints at hotspot/wifi
  const prefer = candidates.find((c) => /hotspot|wi-?fi|wireless|local area connection|adapter/i.test(c.name));
  if (prefer) return prefer.address;
  return candidates[0].address;
}

const OTA_PUBLIC_HOST = detectPublicHost();
const OTA_PUBLIC_PORT = Number(process.env.OTA_PUBLIC_PORT || API_PORT);
const OTA_URL = process.env.OTA_URL || `http://${OTA_PUBLIC_HOST}:${OTA_PUBLIC_PORT}/ota/main.py`;
const ACK_WAIT_MS = Number(process.env.OTA_ACK_WAIT_MS || 8000);

function readJsonFromApi(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        method: "GET",
        path: pathname,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} for ${pathname}: ${data.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${pathname}: ${err.message}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.end();
  });
}

function mqttPublish(client, topic, payload) {
  // If payload is a control fw-update object, encode it to the compact binary
  // format used by the gamepads so they receive the same messages as the UI path.
  return new Promise((resolve, reject) => {
    try {
      let outPayload = null;
      // Detect fw-update control payload and encode to binary: [FW_UPDATE, urlLen, urlBytes..., optional 32-byte sha]
      if (payload && typeof payload === 'object' && String(payload.type || '') === 'fw-update') {
        const url = String(payload.url || '');
        const urlBuf = Buffer.from(url, 'utf8');
        const parts = [Buffer.from([0x05, urlBuf.length & 0xff]), urlBuf];
        if (payload.sha256 && typeof payload.sha256 === 'string' && payload.sha256.length === 64) {
          try {
            const raw = Buffer.from(payload.sha256, 'hex');
            if (raw.length === 32) parts.push(raw);
          } catch (e) {
            // ignore sha parse errors
          }
        }
        outPayload = Buffer.concat(parts);
      } else {
        outPayload = Buffer.from(JSON.stringify(payload));
      }

      client.publish(topic, outPayload, { qos: 1, retain: false }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(BOARD_MAIN)) {
    throw new Error(`Missing board firmware file: ${BOARD_MAIN}`);
  }

  fs.mkdirSync(OTA_DIR, { recursive: true });

  const firmware = fs.readFileSync(BOARD_MAIN);
  fs.writeFileSync(OTA_MAIN, firmware);
  const sha256 = crypto.createHash("sha256").update(firmware).digest("hex");

  const state = await readJsonFromApi("/api/state");
  const gamepads = Array.isArray(state && state.gamepads) ? state.gamepads : [];
  const connected = gamepads.filter((g) => g && g.connected && typeof g.id === "string" && g.id.length > 0);

  if (connected.length === 0) {
    console.log("No connected gamepads found. OTA file prepared, no publish sent.");
    return;
  }

  const legacyIds = connected.filter((g) => g.id.startsWith("gamepad-")).map((g) => g.id);
  if (legacyIds.length > 0) {
    console.log("Warning: legacy IDs detected (gamepad-*). Those boards may not include fw-update support yet.");
    console.log("If OTA is ignored, do one USB flash first with the latest board/main.py.");
  }

  const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
    clientId: `ota-push-${Date.now()}`,
    reconnectPeriod: 0,
  });

  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });

  const ackById = new Map();
  client.on("message", (topic, payloadBuf) => {
    const parts = String(topic || "").split("/");
    if (parts.length < 3 || parts[0] !== "gamepad" || parts[2] !== "telemetry") return;
    const gamepadId = parts[1];
    let msg = null;
    // First try JSON payloads (legacy/admin apps)
    try {
      msg = JSON.parse(payloadBuf.toString("utf8"));
    } catch (err) {
      // Fallback: attempt to decode binary telemetry-status (MSG 0x21)
      try {
        if (payloadBuf && payloadBuf.length >= 4) {
          const t0 = payloadBuf.readUInt8(0);
          // MSG.TELEMETRY_STATUS === 0x21
          if (t0 === 0x21) {
            const subtype = payloadBuf.readUInt8(1);
            // subtype 1 === fw-update-status
            if (subtype === 1) {
              const statusCode = payloadBuf.readUInt8(2);
              const len = payloadBuf.readUInt8(3) || 0;
              let detail = "";
              if (len > 0 && 4 + len <= payloadBuf.length) {
                detail = payloadBuf.slice(4, 4 + len).toString('utf8');
              }
              const statusMap = {1: 'start', 2: 'ok', 3: 'error'};
              const status = statusMap[statusCode] || 'unknown';
              msg = { type: 'fw-update-status', status, detail };
            }
          }
        }
      } catch (e) {
        msg = null;
      }
    }
    if (!msg || msg.type !== "fw-update-status") return;
    ackById.set(gamepadId, {
      status: String(msg.status || "unknown"),
      detail: String(msg.detail || ""),
    });
  });

  await new Promise((resolve, reject) => {
    client.subscribe("gamepad/+/telemetry", { qos: 0 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  try {
    const payload = {
      type: "fw-update",
      url: OTA_URL,
      sha256,
      requestedAt: Date.now(),
    };

    for (const gp of connected) {
      const topic = `gamepad/${gp.id}/control`;
      await mqttPublish(client, topic, payload);
      console.log(`Sent OTA request to ${gp.id}`);
    }

    console.log(`Published OTA command to ${connected.length} gamepad(s).`);

    await wait(ACK_WAIT_MS);

    for (const gp of connected) {
      const ack = ackById.get(gp.id);
      if (!ack) {
        console.log(`No OTA ack from ${gp.id}`);
        continue;
      }
      console.log(`OTA ack from ${gp.id}: ${ack.status}${ack.detail ? ` (${ack.detail})` : ""}`);
    }
  } finally {
    client.end(true);
  }
}

main().catch((err) => {
  console.error("OTA push failed:", err && err.message ? err.message : err);
  process.exit(1);
});
