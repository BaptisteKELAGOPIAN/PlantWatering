import express from 'express';
import cors from 'cors';
import http from 'http';
import dotenv from 'dotenv';
import plantRoutes from './routes/plants';
import { setupWebSocket, broadcastToDashboards, isRealEsp32Connected } from './websocket';
import prisma from './prisma';

dotenv.config();

export const app = express();
const port = process.env.PORT || 3001;

// Whitelist des origines lues dynamiquement depuis les variables d'environnement
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.trim().replace(/\/+$/, '');
    const cleanFrontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.trim().replace(/\/+$/, '') : '';

    const origins = [
      cleanFrontendUrl,
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000'
    ].filter(Boolean);

    if (origins.includes(cleanOrigin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS Rejeté] Origine non autorisée: "${cleanOrigin}"`);
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

import { ADMIN_PASSWORD, safeComparePassword } from './middleware/auth';
import rateLimit from 'express-rate-limit';

// Configurer Express pour faire confiance au proxy (ex: Railway, Vercel)
// Nécessaire pour que express-rate-limit récupère la bonne IP du client
app.set('trust proxy', 1);

app.use(express.json());

// Limiteur de requêtes global (pour éviter le flood sur l'API)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limite à 300 requêtes par IP
  message: { error: 'Trop de requêtes, veuillez réessayer plus tard.' }
});

// Limiteur ultra strict anti brute-force pour le login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 tentatives de mot de passe par IP toutes les 15 minutes
  message: { success: false, error: 'Trop de tentatives de connexion échouées. Réessayez dans 15 minutes.' }
});

// Appliquer le limiteur global aux routes API
app.use('/api/', apiLimiter);

// Endpoint d'authentification Admin
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  
  if (safeComparePassword(password)) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Mot de passe administrateur incorrect' });
  }
});

// Routes API REST
app.use('/api/plants', plantRoutes);

// Endpoint de santé de l'application
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Création du serveur HTTP
const server = http.createServer(app);

// Initialisation de la couche WebSocket
setupWebSocket(server);
const simulatedMoisture = new Map<number, number>();

// Fonction de simulation d'humidité en arrière-plan (Données fictives)
function startSimulation() {
  console.log("Simulateur d'humidité démarré (Données fictives en mémoire uniquement)...");
  
  setInterval(async () => {
    try {
      // Si une vraie carte ESP32 physique est connectée, suspendre le simulateur fictif
      if (isRealEsp32Connected()) {
        return;
      }

      const plants = await prisma.plant.findMany();
      const systemConfig = await prisma.systemConfig.findUnique({
        where: { id: 'system' }
      });
      const globalAutoWater = systemConfig?.globalAutoWater ?? true;

      for (const plant of plants) {
        // 1. Lire la mesure d'humidité simulée ou initiale
        if (!simulatedMoisture.has(plant.id)) {
          const lastTelemetry = await prisma.telemetry.findFirst({
            where: { plantId: plant.id },
            orderBy: { createdAt: 'desc' }
          });
          simulatedMoisture.set(plant.id, lastTelemetry ? lastTelemetry.moisture : 55.0);
        }

        let currentMoisture = simulatedMoisture.get(plant.id)!;

        // 2. Diminuer l'humidité pour simuler le dessèchement (0.3% à 1.5% de perte par cycle)
        currentMoisture -= (Math.random() * 1.2 + 0.3);

        // Éviter des valeurs négatives absurdes
        if (currentMoisture < 8.0) currentMoisture = 8.0;

        simulatedMoisture.set(plant.id, currentMoisture);

        // 3. Diffuser la nouvelle valeur SANS SAUVEGARDER EN BASE
        broadcastToDashboards({
          type: 'TELEMETRY_UPDATE',
          plantId: plant.id,
          pinNumber: plant.pinNumber,
          moisture: Number(currentMoisture.toFixed(1)),
          createdAt: new Date(),
          isSimulated: true
        });

        // 4. Arrosage automatique simulé
        if (globalAutoWater && plant.autoWatering && currentMoisture < plant.moistureMin) {
          console.log(`[SIMULATION] Arrosage auto virtuel pour ${plant.name} (Pin ${plant.pinNumber})`);

          // Remonter l'humidité à 82% après arrosage simulé
          simulatedMoisture.set(plant.id, 82.0);

          // Informer les dashboards (SANS SAUVEGARDER EN BASE)
          broadcastToDashboards({
            type: 'WATERING_EVENT',
            plantId: plant.id,
            pinNumber: plant.pinNumber,
            duration: plant.wateringDuration,
            mode: 'AUTO',
            createdAt: new Date(),
            isSimulated: true
          });

          broadcastToDashboards({
            type: 'TELEMETRY_UPDATE',
            plantId: plant.id,
            pinNumber: plant.pinNumber,
            moisture: 82.0,
            createdAt: new Date(),
            isSimulated: true
          });
        }
      }
    } catch (error) {
      console.error('Erreur lors de la simulation:', error);
    }
  }, 10000); // Exécuté toutes les 10 secondes
}

// Fonction de démarrage pour s'assurer que la base est accessible et pré-remplie
async function startServer() {
  try {
    // Connexion test à la base de données
    await prisma.$connect();
    console.log('Connecté avec succès à la base de données.');

    // Pré-remplir la configuration système globale
    const configCount = await prisma.systemConfig.count();
    if (configCount === 0) {
      await prisma.systemConfig.create({
        data: {
          id: 'system',
          globalAutoWater: true
        }
      });
      console.log('Configuration globale du système initialisée.');
    }

    // Pré-provisionner les 6 plantes par défaut si la base est vide
    const plantCount = await prisma.plant.count();
    if (plantCount === 0) {
      console.log('Base de données vide. Initialisation des 6 plantes par défaut...');
      const defaultPlants = [
        { name: 'Bonsaï d\'intérieur', pinNumber: 32, imageUrl: '/images/bonsai.jpg' },
        { name: 'Cactus Piquant', pinNumber: 33, imageUrl: '/images/cactus.jpg' },
        { name: 'Monstera Délicieuse', pinNumber: 34, imageUrl: '/images/monstera.jpg' },
        { name: 'Fougère des bois', pinNumber: 35, imageUrl: '/images/fern.jpg' },
        { name: 'Menthe Fraîche', pinNumber: 36, imageUrl: '/images/mint.jpg' },
        { name: 'Basilic Italien', pinNumber: 39, imageUrl: '/images/basil.jpg' },
      ];

      for (const p of defaultPlants) {
        await prisma.plant.create({
          data: {
            pinNumber: p.pinNumber,
            name: p.name,
            moistureMin: 30.0,
            wateringDuration: 5,
            autoWatering: true,
            imageUrl: p.imageUrl
          }
        });
      }
      console.log('Les 6 plantes par défaut avec images ont été enregistrées.');
    }

    // Lancer la simulation de données d'humidité fictives
    startSimulation();

    server.listen(port, () => {
      console.log(`Le serveur écoute sur http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Erreur au démarrage du serveur :', error);
    process.exit(1);
  }
}

startServer();
