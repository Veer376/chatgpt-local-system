import {
  TURN_CHECKPOINT_MAX_MS,
  TURN_CHECKPOINT_MIN_MS,
  loadTurnCheckpointSettings,
  saveTurnCheckpointSettings,
} from "./turn-checkpoint.js";

const EXTENSION_HEADER = "x-local-system-extension";
const EXTENSION_HEADER_VALUE = "1";

export function registerLocalTurnCheckpointRoutes(app) {
  app.post("/local-ui/turn-checkpoint", (req, res) => {
    if (req.get(EXTENSION_HEADER) !== EXTENSION_HEADER_VALUE) {
      return res.status(403).json({ error: "Local System extension header required" });
    }

    try {
      const action = String(req.body?.action || "get");
      if (action === "get") return res.json(publicSettings(loadTurnCheckpointSettings()));
      if (action !== "update") return res.status(400).json({ error: "Unsupported turn-checkpoint action" });

      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "enabled")) {
        patch.enabled = req.body.enabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "intervalMinutes")) {
        const minutes = Number(req.body.intervalMinutes);
        const minMinutes = TURN_CHECKPOINT_MIN_MS / 60_000;
        const maxMinutes = TURN_CHECKPOINT_MAX_MS / 60_000;
        if (!Number.isFinite(minutes) || minutes < minMinutes || minutes > maxMinutes) {
          return res.status(400).json({
            error: `Checkpoint interval must be between ${minMinutes} and ${maxMinutes} minutes`,
          });
        }
        patch.intervalMs = Math.round(minutes * 60_000);
      }
      return res.json(publicSettings(saveTurnCheckpointSettings(patch)));
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function publicSettings(settings) {
  return {
    enabled: settings.enabled !== false,
    intervalMinutes: settings.intervalMs / 60_000,
  };
}
