import { Router, Request, Response } from 'express';
import prisma from '../prisma';
import { broadcastToDashboards } from '../websocket';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// 1. Lister toutes les plantes avec leur dernière télémesure et dernier arrosage
router.get('/', async (req: Request, res: Response) => {
  try {
    const plants = await prisma.plant.findMany({
      include: {
        telemetries: {
          orderBy: { createdAt: 'desc' },
          take: 1
        },
        waterings: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { pinNumber: 'asc' }
    });
    res.json(plants);
  } catch (error) {
    console.error('Erreur lors de la récupération des plantes:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// 7. Récupérer la configuration globale du système
router.get('/system/config', async (req: Request, res: Response) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { id: 'system' }
    });
    res.json(config);
  } catch (error) {
    console.error('Erreur config system:', error);
    res.status(500).json({ error: "Erreur lors de la lecture de la configuration système" });
  }
});

// 8. Toggler le mode automatique global (Nécessite Admin)
router.put('/system/config', requireAdmin, async (req: Request, res: Response) => {
  const { globalAutoWater } = req.body;
  try {
    const updatedConfig = await prisma.systemConfig.update({
      where: { id: 'system' },
      data: {
        globalAutoWater: Boolean(globalAutoWater)
      }
    });

    // Diffuser le changement à tous les dashboards en WebSocket
    broadcastToDashboards({
      type: 'SYSTEM_CONFIG_UPDATED',
      config: updatedConfig
    });

    res.json(updatedConfig);
  } catch (error) {
    console.error('Erreur MAJ config system:', error);
    res.status(500).json({ error: "Erreur lors de la mise à jour de la configuration système" });
  }
});

// 5. Récupérer l'historique d'arrosage global (toutes plantes confondues)
router.get('/global/history', async (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;

  try {
    const waterings = await prisma.wateringLog.findMany({
      include: {
        plant: {
          select: { id: true, name: true, pinNumber: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    res.json(waterings);
  } catch (error) {
    console.error('Erreur historique global:', error);
    res.status(500).json({ error: "Erreur lors de la récupération de l'historique global" });
  }
});

// 6. Récupérer les statistiques globales (toutes plantes confondues)
router.get('/global/stats', async (req: Request, res: Response) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    // Nombre d'arrosages globaux (30 jours)
    const totalWaterings30Days = await prisma.wateringLog.count({
      where: { createdAt: { gte: thirtyDaysAgo } }
    });

    // Durée cumulée d'arrosage (30 jours)
    const totalDuration30Days = await prisma.wateringLog.aggregate({
      where: { createdAt: { gte: thirtyDaysAgo } },
      _sum: { duration: true }
    });

    // Humidité moyenne globale actuelle (dernières mesures de chaque plante)
    const latestTelemetries = await prisma.plant.findMany({
      include: {
        telemetries: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    const activeMoistures = latestTelemetries
      .map(p => p.telemetries[0]?.moisture)
      .filter(m => m !== undefined && m !== null) as number[];

    const globalAvgMoisture = activeMoistures.length > 0
      ? activeMoistures.reduce((sum, val) => sum + val, 0) / activeMoistures.length
      : null;

    // Plante la plus arrosée en nombre de fois (30 jours)
    const wateringGrouped = await prisma.wateringLog.groupBy({
      by: ['plantId'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 1
    });

    let mostWateredPlant = null;
    if (wateringGrouped.length > 0) {
      const plantInfo = await prisma.plant.findUnique({
        where: { id: wateringGrouped[0].plantId },
        select: { name: true }
      });
      mostWateredPlant = {
        name: plantInfo?.name || `Plante #${wateringGrouped[0].plantId}`,
        count: wateringGrouped[0]._count.id
      };
    }

    res.json({
      totalWaterings30Days,
      totalDuration30Days: totalDuration30Days._sum.duration || 0,
      globalAvgMoisture,
      mostWateredPlant
    });
  } catch (error) {
    console.error('Erreur stats globales:', error);
    res.status(500).json({ error: "Erreur lors du calcul des statistiques globales" });
  }
});

// 2. Mettre à jour la configuration d'une plante (Nécessite Admin)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, moistureMin, wateringDuration, autoWatering, imageUrl } = req.body;

  try {
    const updatedPlant = await prisma.plant.update({
      where: { id: Number(id) },
      data: {
        name: name !== undefined ? name : undefined,
        moistureMin: moistureMin !== undefined ? Number(moistureMin) : undefined,
        wateringDuration: wateringDuration !== undefined ? Number(wateringDuration) : undefined,
        autoWatering: autoWatering !== undefined ? Boolean(autoWatering) : undefined,
        imageUrl: imageUrl !== undefined ? imageUrl : undefined
      }
    });

    // Envoyer la nouvelle configuration en temps réel aux dashboards
    broadcastToDashboards({
      type: 'PLANT_CONFIG_UPDATED',
      plant: updatedPlant
    });

    res.json(updatedPlant);
  } catch (error) {
    console.error(`Erreur lors de la mise à jour de la plante ${id}:`, error);
    res.status(500).json({ error: 'Erreur serveur lors de la mise à jour de la plante' });
  }
});

// 3. Récupérer l'historique des relevés et des arrosages d'une plante
router.get('/:id/history', async (req: Request, res: Response) => {
  const { id } = req.params;
  const limit = req.query.limit ? Number(req.query.limit) : 50;

  try {
    const telemetries = await prisma.telemetry.findMany({
      where: { plantId: Number(id) },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    const waterings = await prisma.wateringLog.findMany({
      where: { plantId: Number(id) },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    // Inverser pour que le graphique soit chronologique
    res.json({
      telemetries: telemetries.reverse(),
      waterings
    });
  } catch (error) {
    console.error(`Erreur historique pour la plante ${id}:`, error);
    res.status(500).json({ error: "Erreur lors de la récupération de l'historique" });
  }
});

// 4. Récupérer les statistiques d'arrosage et d'humidité d'une plante
router.get('/:id/stats', async (req: Request, res: Response) => {
  const { id } = req.params;
  const plantId = Number(id);

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    // Dernier arrosage
    const lastWatering = await prisma.wateringLog.findFirst({
      where: { plantId },
      orderBy: { createdAt: 'desc' }
    });

    // Nombre d'arrosages les 30 derniers jours
    const wateringCount30Days = await prisma.wateringLog.count({
      where: {
        plantId,
        createdAt: { gte: thirtyDaysAgo }
      }
    });

    // Durée totale d'arrosage les 30 derniers jours (en secondes)
    const totalWateringDuration30Days = await prisma.wateringLog.aggregate({
      where: {
        plantId,
        createdAt: { gte: thirtyDaysAgo }
      },
      _sum: {
        duration: true
      }
    });

    // Humidité moyenne, min et max des dernières 24h
    const moistureStats24h = await prisma.telemetry.aggregate({
      where: {
        plantId,
        createdAt: { gte: oneDayAgo }
      },
      _avg: {
        moisture: true
      },
      _min: {
        moisture: true
      },
      _max: {
        moisture: true
      }
    });

    res.json({
      lastWatering,
      wateringCount30Days,
      totalWateringDuration30Days: totalWateringDuration30Days._sum.duration || 0,
      averageMoisture24h: moistureStats24h._avg.moisture || null,
      minMoisture24h: moistureStats24h._min.moisture || null,
      maxMoisture24h: moistureStats24h._max.moisture || null
    });
  } catch (error) {
    console.error(`Erreur stats pour la plante ${id}:`, error);
    res.status(500).json({ error: "Erreur lors du calcul des statistiques" });
  }
});

export default router;
