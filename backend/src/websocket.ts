import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import prisma from './prisma';
import url from 'url';
import { ADMIN_PASSWORD, safeComparePassword } from './middleware/auth';

// Ensembles pour suivre les connexions actives
const dashboardClients = new Set<WebSocket>();
let esp32Client: WebSocket | null = null;

export function isRealEsp32Connected(): boolean {
  return esp32Client !== null && esp32Client.readyState === WebSocket.OPEN;
}

export function broadcastEsp32Status() {
  broadcastToDashboards({
    type: 'ESP32_STATUS_UPDATE',
    isRealEsp32: isRealEsp32Connected()
  });
}

export function setupWebSocket(server: any) {
  const wss = new WebSocketServer({ noServer: true });

  // Intégration du WebSocket Server avec le serveur HTTP d'Express
  server.on('upgrade', (request: IncomingMessage, socket: any, head: any) => {
    const pathname = url.parse(request.url || '').pathname;

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const parameters = url.parse(request.url || '', true).query;
    const clientType = parameters.clientType; // "dashboard" ou "esp32"
    const rawOrigin = request.headers.origin;
    const cleanOrigin = rawOrigin ? rawOrigin.trim().replace(/\/+$/, '') : '';
    const cleanFrontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.trim().replace(/\/+$/, '') : '';

    const origins = [
      cleanFrontendUrl,
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000'
    ].filter(Boolean);

    if (clientType === 'dashboard' && cleanOrigin && !origins.includes(cleanOrigin)) {
      console.warn(`[WebSocket Bloqué] Origine non autorisée : ${cleanOrigin}`);
      ws.close(1008, 'Origine non autorisée');
      return;
    }

    console.log(`Nouvelle connexion WebSocket établie. Type: ${clientType}`);

    if (clientType === 'esp32') {
      // Fix timing attack here
      const esp32Token = Array.isArray(parameters.token) ? parameters.token[0] : parameters.token;
      if (!safeComparePassword(esp32Token)) {
        console.warn(`[WebSocket ESP32 Bloqué] Tentative de connexion non autorisée (Mauvais token)`);
        ws.close(1008, 'Token invalide pour ESP32');
        return;
      }

      // Déconnecter l'ancien ESP32 s'il y en avait un
      if (esp32Client) {
        esp32Client.close();
      }
      esp32Client = ws;
      console.log('ESP32 Physique connecté en WebSocket');
      broadcastEsp32Status();

      ws.on('close', () => {
        console.log('ESP32 Physique déconnecté');
        if (esp32Client === ws) {
          esp32Client = null;
        }
        broadcastEsp32Status();
      });
    } else {
      // Par défaut, c'est un client Dashboard
      dashboardClients.add(ws);
      console.log(`Dashboard connecté. Total dashboards actifs: ${dashboardClients.size}`);

      // Envoyer l'état actuel des plantes dès la connexion
      try {
        const plants = await prisma.plant.findMany({
          include: {
            telemetries: {
              orderBy: { createdAt: 'desc' },
              take: 1
            }
          }
        });
        ws.send(JSON.stringify({ 
          type: 'INIT_STATE', 
          plants,
          isRealEsp32: isRealEsp32Connected() 
        }));

        // Envoyer la configuration globale
        const systemConfig = await prisma.systemConfig.findUnique({
          where: { id: 'system' }
        });
        if (systemConfig) {
          ws.send(JSON.stringify({ type: 'SYSTEM_CONFIG_UPDATED', config: systemConfig }));
        }
      } catch (err) {
        console.error("Erreur lors de l'envoi de l'état initial :", err);
      }

      ws.on('close', () => {
        dashboardClients.delete(ws);
        console.log(`Dashboard déconnecté. Total dashboards actifs: ${dashboardClients.size}`);
      });
    }

    ws.on('message', async (message: string) => {
      try {
        const data = JSON.parse(message);
        console.log(`Message reçu de (${clientType}):`, data);

        if (clientType === 'esp32') {
          await handleEsp32Message(data, ws);
        } else {
          await handleDashboardMessage(data, ws);
        }
      } catch (err) {
        console.error('Erreur lors du traitement du message WS:', err);
      }
    });
  });
}

// Traite les messages reçus de l'ESP32
async function handleEsp32Message(data: any, ws: WebSocket) {
  if (data.type === 'ESP32_TELEMETRY' && Array.isArray(data.readings)) {
    const responseActions: Array<{ pinNumber: number; triggerWatering: boolean; duration: number }> = [];

    for (const reading of data.readings) {
      const { pinNumber, moisture } = reading;

      // 1. Trouver ou auto-créer la plante correspondante
      let plant = await prisma.plant.findUnique({
        where: { pinNumber: Number(pinNumber) }
      });

      if (!plant) {
        // Auto-provisioning pour faciliter l'installation initiale
        plant = await prisma.plant.create({
          data: {
            pinNumber: Number(pinNumber),
            name: `Plante GPIO ${pinNumber}`,
            moistureMin: 30.0, // Seuil par défaut
            wateringDuration: 5, // 5 secondes par défaut
            autoWatering: true
          }
        });
      }

      // 2. Enregistrer la mesure d'humidité
      const telemetry = await prisma.telemetry.create({
        data: {
          plantId: plant.id,
          moisture: Number(moisture)
        }
      });

      // 3. Diffuser la mesure en direct aux dashboards connectés
      broadcastToDashboards({
        type: 'TELEMETRY_UPDATE',
        plantId: plant.id,
        pinNumber: plant.pinNumber,
        moisture: Number(moisture),
        createdAt: telemetry.createdAt
      });

      // 4. Vérifier si l'arrosage automatique doit être déclenché
      if (plant.autoWatering && Number(moisture) < plant.moistureMin) {
        // Eviter les arrosages intempestifs en vérifiant le dernier arrosage (ex: pas plus d'une fois toutes les 15 minutes)
        const lastWatering = await prisma.wateringLog.findFirst({
          where: { plantId: plant.id },
          orderBy: { createdAt: 'desc' }
        });

        const timeSinceLastWatering = lastWatering
          ? Date.now() - new Date(lastWatering.createdAt).getTime()
          : Infinity;

        // Securité: Pas plus d'un arrosage par jour (18 heures = 64 800 000 ms)
        if (timeSinceLastWatering > 64800000) {
          responseActions.push({
            pinNumber: plant.pinNumber,
            triggerWatering: true,
            duration: plant.wateringDuration
          });

          // Enregistrer l'arrosage automatique dans l'historique
          await prisma.wateringLog.create({
            data: {
              plantId: plant.id,
              duration: plant.wateringDuration,
              mode: 'AUTO'
            }
          });

          // Diffuser l'arrosage aux dashboards
          broadcastToDashboards({
            type: 'WATERING_EVENT',
            plantId: plant.id,
            pinNumber: plant.pinNumber,
            duration: plant.wateringDuration,
            mode: 'AUTO',
            createdAt: new Date()
          });
        }
      }
    }

    // Si des arrosages automatiques doivent être déclenchés, répondre immédiatement
    if (responseActions.length > 0) {
      ws.send(JSON.stringify({
        type: 'WATER_CMD',
        actions: responseActions
      }));
    }
  }
}

// Suivi anti brute-force pour les WebSockets
const wsFailedAttempts = new WeakMap<WebSocket, number>();

// Traite les messages reçus du Dashboard
async function handleDashboardMessage(data: any, ws?: WebSocket) {
  // Déclencher un arrosage manuel depuis le dashboard
  if (data.type === 'TRIGGER_WATERING') {
    const { plantId, duration, token } = data;

    if (!safeComparePassword(token)) {
      if (ws) {
        const attempts = (wsFailedAttempts.get(ws) || 0) + 1;
        wsFailedAttempts.set(ws, attempts);

        if (attempts >= 5) {
          ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Trop de tentatives de mot de passe échouées. Votre connexion est bloquée.'
          }));
          ws.close(1008, 'Brute force detecté');
          return;
        }

        ws.send(JSON.stringify({
          type: 'ERROR',
          message: `Mot de passe incorrect (Tentative ${attempts}/5). Arrosage impossible.`
        }));
      }
      return;
    }

    // Mot de passe correct, on réinitialise les tentatives
    if (ws) wsFailedAttempts.delete(ws);

    const plant = await prisma.plant.findUnique({
      where: { id: Number(plantId) }
    });

    if (plant) {
      // Securité: Pas plus d'un arrosage par jour (18h) même en manuel
      const lastWatering = await prisma.wateringLog.findFirst({
        where: { plantId: plant.id },
        orderBy: { createdAt: 'desc' }
      });
      const timeSinceLastWatering = lastWatering
        ? Date.now() - new Date(lastWatering.createdAt).getTime()
        : Infinity;

      if (timeSinceLastWatering <= 64800000) {
        if (ws) {
          ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Sécurité : Cette plante a déjà été arrosée il y a moins de 18h.'
          }));
        }
        return;
      }
    }

    // Securité: Plafonner la durée d'arrosage manuel à 60 secondes maximum
    const safeDuration = Math.min(Math.max(Number(duration) || 0, 1), 60);

    if (plant && esp32Client) {
      console.log(`Commande d'arrosage manuel reçue pour la plante ${plant.name} (Pin ${plant.pinNumber}) pendant ${safeDuration}s`);
      
      // 1. Envoyer l'ordre à l'ESP32 en temps réel
      esp32Client.send(JSON.stringify({
        type: 'WATER_CMD',
        actions: [
          {
            pinNumber: plant.pinNumber,
            triggerWatering: true,
            duration: safeDuration
          }
        ]
      }));

      // 2. Enregistrer l'arrosage dans la base de données
      await prisma.wateringLog.create({
        data: {
          plantId: plant.id,
          duration: safeDuration,
          mode: 'MANUAL'
        }
      });

      // 3. Informer tous les dashboards connectés de l'action en cours
      broadcastToDashboards({
        type: 'WATERING_EVENT',
        plantId: plant.id,
        pinNumber: plant.pinNumber,
        duration: safeDuration,
        mode: 'MANUAL',
        createdAt: new Date()
      });
    } else if (!esp32Client) {
      console.warn("Impossible d'arroser : l'ESP32 n'est pas connecté en WebSocket.");
      broadcastToDashboards({
        type: 'ERROR',
        message: "L'ESP32 est hors-ligne. Impossible de lancer l'arrosage."
      });
    }
  }
}

// Fonction utilitaire pour diffuser aux dashboards
export function broadcastToDashboards(message: any) {
  const payload = JSON.stringify(message);
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
