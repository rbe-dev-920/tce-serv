// backend/src/server.js
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

console.log('[INIT] Starting server initialization...');
console.log('[INIT] NODE_ENV:', process.env.NODE_ENV);
console.log('[INIT] PORT:', process.env.PORT);
console.log('[INIT] DATABASE_URL exists:', !!process.env.DATABASE_URL);

const app = express();
let prisma; // init guarded to avoid startup crash when DB is unreachable
let prismaReady = false;

console.log('[INIT] Creating PrismaClient...');
try {
  prisma = new PrismaClient({
    log: ['error', 'warn'],
  });
  console.log('[INIT] ✅ PrismaClient created');
} catch (e) {
  console.error('[INIT] ❌ Prisma initialization failed ->', e.message);
  console.error('[INIT] Stack:', e.stack);
}

// Configuration CORS simple pour production
// En production, accepter les domaines spécifiques
// En développement, accepter localhost
const isProduction = process.env.NODE_ENV === 'production';

// CORS permissif pour éviter les blocages (y compris sur erreurs 404/500)
const corsOptions = {
  origin: true, // reflète l'origine appelante
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
  maxAge: 86400,
};

// Middleware CORS global
app.use(cors(corsOptions));

// Headers CORS additionnels même sur 404/500/erreurs
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH,HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  console.log(`[CORS] ${req.method} ${req.path} from ${origin}`);
  
  // Répondre immédiatement aux OPTIONS preflight
  if (req.method === 'OPTIONS') {
    console.log(`[CORS] ✅ OPTIONS preflight allowed`);
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());
app.use(express.text()); // Pour traiter les fichiers en texte brut

// Middleware custom pour multipart/form-data (fichiers)
app.use((req, res, next) => {
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      // Parser simple du multipart
      const boundary = req.headers['content-type'].split('boundary=')[1];
      const parts = body.split(`--${boundary}`);
      
      for (const part of parts) {
        if (part.includes('filename=')) {
          const match = part.match(/\r\n\r\n([\s\S]*?)\r\n/);
          if (match) {
            req.csvContent = match[1];
            break;
          }
        }
      }
      next();
    });
  } else {
    next();
  }
});

// Short-circuit requests that need DB when Prisma is not ready
const noDbPaths = new Set([
  '/',
  '/health',
  '/api/today',
  '/api/server-time',
  '/api/cors-test',
]);

app.use((req, res, next) => {
  if (!prismaReady && !noDbPaths.has(req.path)) {
    return res.status(503).json({ error: 'Database unavailable, retry shortly' });
  }
  next();
});

// ---------- helpers ----------
function parseDateFlexible(val) {
  if (!val) return null;
  if (typeof val === 'string' && val.includes('/')) {
    const [dd, mm, yyyy] = val.split('/');
    if (dd && mm && yyyy) return new Date(`${yyyy}-${mm}-${dd}`);
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}
function objToJsonOrNull(o) {
  try {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const s = JSON.stringify(o);
      return s === '{}' ? null : s;
    }
  } catch {}
  return o == null ? null : String(o);
}

// Obtenir la date actuelle en heure de Paris (YYYY-MM-DD)
function getTodayDateParis() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('fr-FR', { 
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

// ---------- ping ----------
app.get('/', (_req, res) => res.send('TC Outil API - Voyages TC Essonnes'));

// Health check endpoint
app.get('/health', async (_req, res) => {
  if (!prisma) {
    return res.status(503).json({ status: 'degraded', error: 'Prisma not initialized' });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV 
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'error', 
      error: error.message 
    });
  }
});

// ---------- cors-test ----------
app.get('/api/cors-test', (req, res) => {
  res.json({
    message: 'CORS test successful',
    origin: req.get('origin'),
    headers: {
      'Access-Control-Allow-Origin': res.get('Access-Control-Allow-Origin'),
    },
  });
});

// ---------- server-time ----------
app.get('/api/server-time', (_req, res) => {
  res.json({ timestamp: new Date().toISOString() });
});

// Get today's date in Paris timezone
app.get('/api/today', (_req, res) => {
  res.json({ today: getTodayDateParis() });
});

// Diagnostic endpoint
app.get('/api/diagnostic', async (_req, res) => {
  try {
    const now = new Date();
    const todayStr = getTodayDateParis();
    
    const allServices = await prisma.service.findMany({
      select: { date: true, id: true, statut: true }
    });
    
    // Grouper par date
    const byDate = {};
    allServices.forEach(s => {
      const dateStr = new Date(s.date).toISOString().split('T')[0];
      if (!byDate[dateStr]) byDate[dateStr] = [];
      byDate[dateStr].push(s);
    });
    
    res.json({
      serverTime: now.toISOString(),
      parisTime: getTodayDateParis(),
      serverDate: todayStr,
      totalServices: allServices.length,
      servicesByDate: Object.entries(byDate).map(([date, services]) => ({
        date,
        count: services.length,
        statuts: {
          Planifiée: services.filter(s => s.statut === 'Planifiée').length,
          Terminée: services.filter(s => s.statut === 'Terminée').length,
        }
      }))
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== VEHICLES ==========

// LIST
app.get('/api/vehicles', async (_req, res) => {
  try {
    console.log('[API] GET /api/vehicles - prismaReady:', prismaReady);
    if (!prismaReady) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    const data = await prisma.vehicle.findMany({ orderBy: { parc: 'asc' } });
    console.log('[API] GET /api/vehicles - found:', data.length);
    res.json(data);
  } catch (e) {
    console.error('GET /api/vehicles ERROR ->', e.message);
    console.error('Stack:', e.stack);
    res.status(500).json({ error: String(e.message) });
  }
});

// DETAIL
app.get('/api/vehicles/:parc', async (req, res) => {
  const v = await prisma.vehicle.findUnique({ where: { parc: req.params.parc } });
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

// CREATE/UPSERT
app.post('/api/vehicles', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.parc) missing.push('parc');
    if (!b.type) missing.push('type');
    if (!b.modele) missing.push('modele');
    if (!b.immat) missing.push('immat');
    if (missing.length) return res.status(400).json({ error: 'Champs requis manquants', missing });

    const payload = {
      parc: String(b.parc).trim(),
      type: String(b.type || ''),
      modele: String(b.modele || ''),
      immat: String(b.immat || '').toUpperCase(),
      km: Number.isFinite(Number(b.km)) ? Number(b.km) : 0,

      // état unique = etatTechnique (on garde tauxSante pour compat)
      etatTechnique: Number.isFinite(Number(b.etatTechnique))
        ? Number(b.etatTechnique)
        : (Number.isFinite(Number(b.tauxSante)) ? Number(b.tauxSante) : 100),
      tauxSante: Number.isFinite(Number(b.etatTechnique))
        ? Number(b.etatTechnique)
        : (Number.isFinite(Number(b.tauxSante)) ? Number(b.tauxSante) : 100),

      proprete: Number.isFinite(Number(b.proprete)) ? Number(b.proprete) : 100,
      etatInterieur: Number.isFinite(Number(b.etatInterieur)) ? Number(b.etatInterieur) : 100,
      statut: String(b.statut || 'Disponible'),

      annee: b.annee !== '' && b.annee != null ? Number(b.annee) : null,
      boite: b.boite ?? null,
      moteur: b.moteur ?? null,
      portes: b.portes !== '' && b.portes != null ? Number(b.portes) : null,
      girouette: b.girouette ?? null,
      clim: b.clim ?? null,
      pmr: !!b.pmr,
      depot: b.depot ?? null,
      ct: parseDateFlexible(b.ct),

      photosJson: Array.isArray(b.photos) ? JSON.stringify(b.photos) : (b.photosJson || null),

      optionsUsineJson: objToJsonOrNull(b.optionsUsine) ?? (b.optionsUsineJson ?? null),
      optionsAtelierJson: objToJsonOrNull(b.optionsAtelier) ?? (b.optionsAtelierJson ?? null),
      optionsSaeivJson: objToJsonOrNull(b.optionsSaeiv) ?? (b.optionsSaeivJson ?? null),
    };

    const saved = await prisma.vehicle.upsert({
      where: { parc: payload.parc },
      update: payload,
      create: payload,
    });

    res.status(201).json(saved);
  } catch (e) {
    console.error('POST /api/vehicles ERROR ->', e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// UPDATE (partial)
app.put('/api/vehicles/:parc', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      type: b.type ?? undefined,
      modele: b.modele ?? undefined,
      immat: b.immat ? String(b.immat).toUpperCase() : undefined,
      km: b.km !== undefined ? Number(b.km) : undefined,

      // etat technique = source unique ; on aligne tauxSante pour compat
      etatTechnique: b.etatTechnique !== undefined ? Number(b.etatTechnique) : undefined,
      tauxSante: b.etatTechnique !== undefined
        ? Number(b.etatTechnique)
        : (b.tauxSante !== undefined ? Number(b.tauxSante) : undefined),

      proprete: b.proprete !== undefined ? Number(b.proprete) : undefined,
      etatInterieur: b.etatInterieur !== undefined ? Number(b.etatInterieur) : undefined,

      statut: b.statut ?? undefined,

      annee: b.annee === '' ? null : (b.annee != null ? Number(b.annee) : undefined),
      boite: b.boite === '' ? null : (b.boite ?? undefined),
      moteur: b.moteur === '' ? null : (b.moteur ?? undefined),
      portes: b.portes === '' ? null : (b.portes != null ? Number(b.portes) : undefined),
      girouette: b.girouette === '' ? null : (b.girouette ?? undefined),
      clim: b.clim === '' ? null : (b.clim ?? undefined),
      pmr: b.pmr === undefined ? undefined : Boolean(b.pmr),
      depot: b.depot === '' ? null : (b.depot ?? undefined),
      ct: b.ct === '' ? null : (b.ct ? parseDateFlexible(b.ct) : undefined),

      photosJson: Array.isArray(b.photos) ? JSON.stringify(b.photos) : (b.photosJson ?? undefined),

      // options: on accepte objets (stringifiés ici) ou ...Json
      optionsUsineJson: b.optionsUsine ? JSON.stringify(b.optionsUsine)
        : (b.optionsUsineJson ?? undefined),
      optionsAtelierJson: b.optionsAtelier ? JSON.stringify(b.optionsAtelier)
        : (b.optionsAtelierJson ?? undefined),
      optionsSaeivJson: b.optionsSaeiv ? JSON.stringify(b.optionsSaeiv)
        : (b.optionsSaeivJson ?? undefined),
    };

    const updated = await prisma.vehicle.update({
      where: { parc: req.params.parc },
      data,
    });

    res.json(updated);
  } catch (e) {
    console.error('PUT /api/vehicles/:parc ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE
app.delete('/api/vehicles/:parc', async (req, res) => {
  try {
    await prisma.vehicle.delete({ where: { parc: req.params.parc } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== CONDUCTEURS ==========

// LIST
app.get('/api/conducteurs', async (_req, res) => {
  try {
    console.log('[API] GET /api/conducteurs - prismaReady:', prismaReady);
    if (!prismaReady) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    const conducteurs = await prisma.conducteur.findMany({ orderBy: { nom: 'asc' } });
    console.log('[API] GET /api/conducteurs - found:', conducteurs.length);
    res.json(conducteurs);
  } catch (e) {
    console.error('GET /api/conducteurs ERROR ->', e.message);
    console.error('Stack:', e.stack);
    res.status(500).json({ error: String(e.message) });
  }
});

// DETAIL
app.get('/api/conducteurs/:id', async (req, res) => {
  try {
    const conducteur = await prisma.conducteur.findUnique({ where: { id: req.params.id } });
    if (!conducteur) return res.status(404).json({ error: 'Not found' });
    res.json(conducteur);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE
app.post('/api/conducteurs', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.nom) missing.push('nom');
    if (!b.prenom) missing.push('prenom');
    if (!b.matricule) missing.push('matricule');
    if (!b.permis) missing.push('permis');
    if (missing.length) return res.status(400).json({ error: 'Champs requis manquants', missing });

    const payload = {
      nom: String(b.nom).trim(),
      prenom: String(b.prenom).trim(),
      matricule: String(b.matricule).trim(),
      permis: String(b.permis),
      embauche: b.embauche ? new Date(b.embauche) : new Date(),
      statut: String(b.statut || 'Actif'),
      typeContrat: String(b.typeContrat || 'CDI'),
      phone: b.phone || null,
      email: b.email || null,

      busArticules: !!b.busArticules,
      autocars: !!b.autocars,
      pmr: !!b.pmr,
      vehiMarchandises: !!b.vehiMarchandises,

      carteChronosJson: b.carteChronos ? JSON.stringify(b.carteChronos) : null,
      fcoJson: b.fco ? JSON.stringify(b.fco) : null,
      securiteJson: b.securite ? JSON.stringify(b.securite) : null,

      visiteMedicaleJson: b.visiteMedicale ? JSON.stringify(b.visiteMedicale) : null,
      vaccinationsJson: b.vaccinations ? JSON.stringify(b.vaccinations) : null,

      heuresMax: Number.isFinite(Number(b.heuresMax)) ? Number(b.heuresMax) : 35,
      heuresReglementaires: Number.isFinite(Number(b.heuresReglementaires)) ? Number(b.heuresReglementaires) : 35,
    };

    const conducteur = await prisma.conducteur.create({ data: payload });
    res.status(201).json(conducteur);
  } catch (e) {
    console.error('POST /api/conducteurs ERROR ->', e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// UPDATE
app.put('/api/conducteurs/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      nom: b.nom ?? undefined,
      prenom: b.prenom ?? undefined,
      matricule: b.matricule ?? undefined,
      permis: b.permis ?? undefined,
      statut: b.statut ?? undefined,
      typeContrat: b.typeContrat ?? undefined,
      phone: b.phone ?? undefined,
      email: b.email ?? undefined,

      busArticules: b.busArticules !== undefined ? !!b.busArticules : undefined,
      autocars: b.autocars !== undefined ? !!b.autocars : undefined,
      pmr: b.pmr !== undefined ? !!b.pmr : undefined,
      vehiMarchandises: b.vehiMarchandises !== undefined ? !!b.vehiMarchandises : undefined,

      carteChronosJson: b.carteChronos ? JSON.stringify(b.carteChronos) : (b.carteChronosJson ?? undefined),
      fcoJson: b.fco ? JSON.stringify(b.fco) : (b.fcoJson ?? undefined),
      securiteJson: b.securite ? JSON.stringify(b.securite) : (b.securiteJson ?? undefined),

      visiteMedicaleJson: b.visiteMedicale ? JSON.stringify(b.visiteMedicale) : (b.visiteMedicaleJson ?? undefined),
      vaccinationsJson: b.vaccinations ? JSON.stringify(b.vaccinations) : (b.vaccinationsJson ?? undefined),

      heuresMax: b.heuresMax !== undefined ? Number(b.heuresMax) : undefined,
      heuresReglementaires: b.heuresReglementaires !== undefined ? Number(b.heuresReglementaires) : undefined,
    };

    const conducteur = await prisma.conducteur.update({ where: { id: req.params.id }, data });
    res.json(conducteur);
  } catch (e) {
    console.error('PUT /api/conducteurs/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE
app.delete('/api/conducteurs/:id', async (req, res) => {
  try {
    await prisma.conducteur.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== LIGNES ==========

// LIST
app.get('/api/lignes', async (_req, res) => {
  try {
    const lignes = await prisma.ligne.findMany({ 
      orderBy: { numero: 'asc' },
      include: { 
        sens: { 
          orderBy: { ordre: 'asc' },
          include: {
            services: { 
              orderBy: { heureDebut: 'asc' },
              include: { conducteur: true }
            }
          }
        } 
      }
    });
    res.json(lignes);
  } catch (e) {
    console.error('GET /api/lignes ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// Initialiser les calendriers vides
app.post('/api/lignes/init-calendars', async (_req, res) => {
  try {
    const defaultCalendar = {
      lundi: true,
      mardi: true,
      mercredi: true,
      jeudi: true,
      vendredi: true,
      samedi: false,
      dimanche: false
    };

    const lignes = await prisma.ligne.findMany();
    let updatedCount = 0;

    for (const ligne of lignes) {
      if (!ligne.calendrierJson) {
        await prisma.ligne.update({
          where: { id: ligne.id },
          data: { calendrierJson: JSON.stringify(defaultCalendar) }
        });
        updatedCount++;
      }
    }

    res.json({ 
      message: `${updatedCount} ligne(s) mise(s) à jour avec un calendrier par défaut`,
      defaultCalendar 
    });
  } catch (e) {
    console.error('POST /api/lignes/init-calendars ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// ATTENTION: Endpoint de nettoyage - supprimer tous les services
app.delete('/api/services/cleanup', async (_req, res) => {
  try {
    const result = await prisma.service.deleteMany({});
    res.json({ 
      message: `${result.count} services supprimés`,
      count: result.count
    });
  } catch (e) {
    console.error('DELETE /api/services/cleanup ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DETAIL
app.get('/api/lignes/:id', async (req, res) => {
  try {
    const ligne = await prisma.ligne.findUnique({ 
      where: { id: req.params.id },
      include: { 
        sens: { 
          orderBy: { ordre: 'asc' },
          include: {
            services: { orderBy: { heureDebut: 'asc' } }
          }
        } 
      }
    });
    if (!ligne) return res.status(404).json({ error: 'Not found' });
    res.json(ligne);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE
app.post('/api/lignes', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.numero) missing.push('numero');
    if (!b.nom) missing.push('nom');
    if (missing.length) return res.status(400).json({ error: 'Champs requis manquants', missing });

    const payload = {
      numero: String(b.numero).trim(),
      nom: String(b.nom).trim(),
      typesVehicules: Array.isArray(b.typesVehicules) ? JSON.stringify(b.typesVehicules) : '[]',
      statut: String(b.statut || 'Actif'),
      description: b.description || null,
    };

    const ligne = await prisma.ligne.create({ data: payload });
    res.status(201).json(ligne);
  } catch (e) {
    console.error('POST /api/lignes ERROR ->', e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// UPDATE
app.put('/api/lignes/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      numero: b.numero ?? undefined,
      nom: b.nom ?? undefined,
      statut: b.statut ?? undefined,
      description: b.description ?? undefined,
      typesVehicules: Array.isArray(b.typesVehicules) ? JSON.stringify(b.typesVehicules) : (b.typesVehicules ?? undefined),
      heureDebut: b.heureDebut ?? undefined,
      heureFin: b.heureFin ?? undefined,
      calendrierJson: b.calendrierJson ?? undefined,
      contraintes: b.contraintes ?? undefined,
    };

    const ligne = await prisma.ligne.update({ 
      where: { id: req.params.id }, 
      data,
      include: { sens: { include: { services: { orderBy: { heureDebut: 'asc' } } }, orderBy: { ordre: 'asc' } } }
    });
    res.json(ligne);
  } catch (e) {
    console.error('PUT /api/lignes/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE
app.delete('/api/lignes/:id', async (req, res) => {
  try {
    await prisma.ligne.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== SERVICES ==========

// LIST (avec filtrage optionnel par date et conducteur)
app.get('/api/services', async (req, res) => {
  try {
    console.log('[API] GET /api/services - prismaReady:', prismaReady);
    if (!prismaReady) {
      return res.status(503).json({ error: 'Database not ready' });
    }
    const { ligneId, conducteurId, date } = req.query;
    const where = {};
    if (ligneId) where.ligneId = ligneId;
    if (conducteurId) where.conducteurId = conducteurId;
    if (date) {
      const d = new Date(date);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      where.date = { gte: d, lt: nextDay };
    }

    const services = await prisma.service.findMany({
      where,
      include: { ligne: true, conducteur: true },
      orderBy: { date: 'asc' },
    });
    console.log('[API] GET /api/services - found:', services.length);
    res.json(services);
  } catch (e) {
    console.error('GET /api/services ERROR ->', e.message);
    console.error('Stack:', e.stack);
    res.status(500).json({ error: String(e.message) });
  }
});

// DETAIL
app.get('/api/services/:id', async (req, res) => {
  try {
    const service = await prisma.service.findUnique({
      where: { id: req.params.id },
      include: { ligne: true, conducteur: true },
    });
    if (!service) return res.status(404).json({ error: 'Not found' });
    res.json(service);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE
app.post('/api/services', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.ligneId) missing.push('ligneId');
    if (!b.date) missing.push('date');
    if (!b.heureDebut) missing.push('heureDebut');
    if (!b.heureFin) missing.push('heureFin');
    if (missing.length) return res.status(400).json({ error: 'Champs requis manquants', missing });

    const payload = {
      ligneId: String(b.ligneId),
      conducteurId: b.conducteurId || null,
      date: new Date(b.date),
      heureDebut: String(b.heureDebut),
      heureFin: String(b.heureFin),
      statut: String(b.statut || 'Planifiée'),
    };

    const service = await prisma.service.create({
      data: payload,
      include: { ligne: true, conducteur: true },
    });
    res.status(201).json(service);
  } catch (e) {
    console.error('POST /api/services ERROR ->', e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// UPDATE
app.put('/api/services/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      conducteurId: b.conducteurId !== undefined ? (b.conducteurId || null) : undefined,
      heureDebut: b.heureDebut ?? undefined,
      heureFin: b.heureFin ?? undefined,
      statut: b.statut ?? undefined,
    };

    const service = await prisma.service.update({
      where: { id: req.params.id },
      data,
      include: { ligne: true, conducteur: true },
    });
    res.json(service);
  } catch (e) {
    console.error('PUT /api/services/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE
app.delete('/api/services/:id', async (req, res) => {
  try {
    await prisma.service.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== POINTAGES ==========

// LIST with optional filtering
app.get('/api/pointages', async (req, res) => {
  try {
    const { serviceId, conducteurId, dateFrom, dateTo } = req.query;
    const where = {};
    if (serviceId) where.serviceId = String(serviceId);
    if (conducteurId) where.conducteurId = String(conducteurId);
    if (dateFrom || dateTo) {
      where.validatedAt = {};
      if (dateFrom) where.validatedAt.gte = new Date(dateFrom);
      if (dateTo) where.validatedAt.lte = new Date(dateTo);
    }

    const pointages = await prisma.pointage.findMany({
      where,
      include: { service: { include: { ligne: true, conducteur: true } }, conducteur: true },
      orderBy: { validatedAt: 'desc' },
    });
    res.json(pointages);
  } catch (e) {
    console.error('GET /api/pointages ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// STATS - Statistiques quotidiennes TC 360+
app.get('/api/pointages/stats/daily', async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1);

    // Récupérer tous les pointages du jour
    const pointages = await prisma.pointage.findMany({
      where: {
        validatedAt: {
          gte: startOfDay,
          lt: endOfDay,
        },
      },
      include: {
        service: { include: { ligne: true } },
        conducteur: true,
      },
    });

    // Récupérer tous les services du jour pour comparer
    const services = await prisma.service.findMany({
      where: {
        date: {
          gte: startOfDay,
          lt: endOfDay,
        },
      },
      include: { ligne: true, conducteur: true },
    });

    // Statistiques détaillées
    const totalServices = services.length;
    const totalPointages = pointages.length;
    const validationRate = totalServices > 0 ? Math.round((totalPointages / totalServices) * 100) : 0;

    // Par conducteur
    const conductorStats = {};
    pointages.forEach((p) => {
      const cid = p.conducteurId;
      if (!conductorStats[cid]) {
        conductorStats[cid] = {
          id: cid,
          nom: p.conducteur?.nom || 'Inconnu',
          prenom: p.conducteur?.prenom || '',
          pointages: 0,
          permisChecked: 0,
          chronometerChecked: 0,
          avgValidationTime: 0,
        };
      }
      conductorStats[cid].pointages++;
      if (p.permisChecked) conductorStats[cid].permisChecked++;
      if (p.chronometerChecked) conductorStats[cid].chronometerChecked++;
    });

    // Distribuer par heure de départ
    const hourlyDistribution = {};
    services.forEach((s) => {
      const hour = s.heureDebut?.split(':')[0] || '??';
      if (!hourlyDistribution[hour]) hourlyDistribution[hour] = { total: 0, validated: 0 };
      hourlyDistribution[hour].total++;
    });
    pointages.forEach((p) => {
      const hour = p.service?.heureDebut?.split(':')[0] || '??';
      if (hourlyDistribution[hour]) hourlyDistribution[hour].validated++;
    });

    // Top/flop conducteurs
    const conductorList = Object.values(conductorStats).sort((a, b) => b.pointages - a.pointages);
    const topConductors = conductorList.slice(0, 5);
    const flopConductors = conductorList.slice(-5).reverse();

    // Véhicules/types
    const vehicleTypes = {};
    pointages.forEach((p) => {
      if (p.vehicleType) {
        vehicleTypes[p.vehicleType] = (vehicleTypes[p.vehicleType] || 0) + 1;
      }
    });

    // Validateurs (Régulateur vs Chef d'Équipe)
    const validatedByStats = {};
    pointages.forEach((p) => {
      const role = p.validatedBy || 'Inconnu';
      validatedByStats[role] = (validatedByStats[role] || 0) + 1;
    });

    // Lignes/routes
    const lineStats = {};
    pointages.forEach((p) => {
      const lineNum = p.service?.ligne?.numero || '??';
      if (!lineStats[lineNum]) {
        lineStats[lineNum] = { numero: lineNum, pointages: 0 };
      }
      lineStats[lineNum].pointages++;
    });

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      totalServices,
      totalPointages,
      validationRate,
      conductorStats: Object.values(conductorStats),
      topConductors,
      flopConductors,
      hourlyDistribution,
      vehicleTypes,
      validatedByStats,
      lineStats: Object.values(lineStats).sort((a, b) => b.pointages - a.pointages),
      avgPermisCheckRate: totalPointages > 0
        ? Math.round((Object.values(conductorStats).reduce((sum, c) => sum + c.permisChecked, 0) / totalPointages) * 100)
        : 0,
      avgTachographCheckRate: totalPointages > 0
        ? Math.round((Object.values(conductorStats).reduce((sum, c) => sum + c.chronometerChecked, 0) / totalPointages) * 100)
        : 0,
    });
  } catch (e) {
    console.error('GET /api/pointages/stats/daily ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DETAIL
app.get('/api/pointages/:id', async (req, res) => {
  try {
    const pointage = await prisma.pointage.findUnique({
      where: { id: req.params.id },
      include: { service: { include: { ligne: true, conducteur: true } }, conducteur: true },
    });
    if (!pointage) return res.status(404).json({ error: 'Not found' });
    res.json(pointage);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE
app.post('/api/pointages', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.serviceId) missing.push('serviceId');
    if (!b.conducteurId) missing.push('conducteurId');
    if (!b.validatedBy) missing.push('validatedBy');
    if (missing.length) return res.status(400).json({ error: 'Champs requis manquants', missing });

    const payload = {
      serviceId: String(b.serviceId),
      conducteurId: String(b.conducteurId),
      validatedBy: String(b.validatedBy), // "Régulateur" ou "Chef d'Équipe"
      vehicleType: b.vehicleType || null,
      permisChecked: Boolean(b.permisChecked || false),
      chronometerChecked: Boolean(b.chronometerChecked || false),
    };

    // Marquer le service comme "Terminée" AVANT de créer le pointage
    const updatedService = await prisma.service.update({
      where: { id: b.serviceId },
      data: { statut: 'Terminée' },
      include: { ligne: true, conducteur: true }
    });

    const pointage = await prisma.pointage.create({
      data: payload,
      include: { service: { include: { ligne: true, conducteur: true } }, conducteur: true },
    });

    res.status(201).json(pointage);
  } catch (e) {
    console.error('POST /api/pointages ERROR ->', e);
    res.status(400).json({ error: e?.message || String(e) });
  }
});

// UPDATE
app.put('/api/pointages/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      vehicleType: b.vehicleType ?? undefined,
      permisChecked: b.permisChecked !== undefined ? Boolean(b.permisChecked) : undefined,
      chronometerChecked: b.chronometerChecked !== undefined ? Boolean(b.chronometerChecked) : undefined,
    };

    const pointage = await prisma.pointage.update({
      where: { id: req.params.id },
      data,
      include: { service: { include: { ligne: true, conducteur: true } }, conducteur: true },
    });
    res.json(pointage);
  } catch (e) {
    console.error('PUT /api/pointages/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE
app.delete('/api/pointages/:id', async (req, res) => {
  try {
    await prisma.pointage.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ===================== SAEIV ENDPOINTS =====================

// GET ALL SAEIV
app.get('/api/saeivs', async (_req, res) => {
  try {
    const saeivs = await prisma.sAEIV.findMany({ orderBy: { numero: 'asc' } });
    res.json(saeivs);
  } catch (e) {
    console.error('GET /api/saeivs ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// GET SINGLE SAEIV
app.get('/api/saeivs/:id', async (req, res) => {
  try {
    const saeiv = await prisma.sAEIV.findUnique({ where: { id: req.params.id } });
    if (!saeiv) return res.status(404).json({ error: 'Not found' });
    res.json(saeiv);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE SAEIV
app.post('/api/saeivs', async (req, res) => {
  try {
    const b = req.body;
    const missing = [];
    if (!b.numero) missing.push('numero');
    if (!b.libelle) missing.push('libelle');
    if (!b.type) missing.push('type');

    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
    }

    const saeiv = await prisma.sAEIV.create({
      data: {
        numero: b.numero,
        libelle: b.libelle,
        type: b.type,
        statut: b.statut || 'Actif',
      },
    });

    res.json(saeiv);
  } catch (e) {
    console.error('POST /api/saeivs ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// UPDATE SAEIV
app.put('/api/saeivs/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      numero: b.numero ?? undefined,
      libelle: b.libelle ?? undefined,
      type: b.type ?? undefined,
      statut: b.statut ?? undefined,
    };

    const saeiv = await prisma.sAEIV.update({ where: { id: req.params.id }, data });
    res.json(saeiv);
  } catch (e) {
    console.error('PUT /api/saeivs/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE SAEIV
app.delete('/api/saeivs/:id', async (req, res) => {
  try {
    await prisma.sAEIV.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ===================== SENS ENDPOINTS =====================

// GET SENS BY LIGNE
app.get('/api/sens/ligne/:ligneId', async (req, res) => {
  try {
    const sens = await prisma.sens.findMany({ 
      where: { ligneId: req.params.ligneId },
      orderBy: { ordre: 'asc' }
    });
    res.json(sens);
  } catch (e) {
    console.error('GET /api/sens/ligne/:ligneId ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// GET SINGLE SENS
app.get('/api/sens/:id', async (req, res) => {
  try {
    const sens = await prisma.sens.findUnique({ 
      where: { id: req.params.id },
      include: { services: true }
    });
    if (!sens) return res.status(404).json({ error: 'Not found' });
    res.json(sens);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// CREATE SENS
app.post('/api/sens', async (req, res) => {
  try {
    const b = req.body;
    if (!b.ligneId || !b.nom) {
      return res.status(400).json({ error: 'Missing fields: ligneId, nom' });
    }

    const sens = await prisma.sens.create({
      data: {
        ligneId: b.ligneId,
        nom: b.nom,
        direction: b.direction || null,
        ordre: b.ordre || 1,
        statut: b.statut || 'Actif',
      },
    });

    res.json(sens);
  } catch (e) {
    console.error('POST /api/sens ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// UPDATE SENS
app.put('/api/sens/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      nom: b.nom ?? undefined,
      direction: b.direction ?? undefined,
      ordre: b.ordre ?? undefined,
      statut: b.statut ?? undefined,
    };

    const sens = await prisma.sens.update({ where: { id: req.params.id }, data });
    res.json(sens);
  } catch (e) {
    console.error('PUT /api/sens/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE SENS
app.delete('/api/sens/:id', async (req, res) => {
  try {
    await prisma.sens.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ===================== SERVICES ENDPOINTS (pour LignesHierarchie) =====================

// GET SERVICES BY SENS
app.get('/api/services-hierarchie/sens/:sensId', async (req, res) => {
  try {
    const services = await prisma.service.findMany({ 
      where: { sensId: req.params.sensId },
      include: { conducteur: true }
    });
    res.json(services);
  } catch (e) {
    console.error('GET /api/services-hierarchie/sens/:sensId ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// CREATE SERVICE (for LignesHierarchie)
app.post('/api/services-hierarchie', async (req, res) => {
  try {
    const b = req.body;
    if (!b.sensId || !b.heureDebut || !b.heureFin) {
      return res.status(400).json({ error: 'Missing fields: sensId, heureDebut, heureFin' });
    }

    // Validation: durée maximale de 10 heures
    const [hDebut, mDebut] = b.heureDebut.split(':').map(Number);
    const [hFin, mFin] = b.heureFin.split(':').map(Number);
    const minutesDebut = hDebut * 60 + mDebut;
    const minutesFin = hFin * 60 + mFin;
    
    // Calculer la durée en tenant compte du passage éventuel de minuit
    let dureeService = minutesFin - minutesDebut;
    if (dureeService < 0) {
      // Le service passe minuit (ex: 22:00 - 05:00)
      dureeService = (1440 - minutesDebut) + minutesFin;
    }

    if (dureeService > 600) { // 600 minutes = 10 heures
      return res.status(400).json({ 
        error: 'Service duration exceeds 10 hours (from depot departure to return to depot)' 
      });
    }

    if (dureeService <= 0) {
      return res.status(400).json({ 
        error: 'End time must be after start time' 
      });
    }

    // Vérifier les limites horaires de la ligne
    const ligne = await prisma.ligne.findUnique({ where: { id: b.ligneId } });
    if (ligne && ligne.heureDebut && ligne.heureFin) {
      const [hLigneDebut, mLigneDebut] = ligne.heureDebut.split(':').map(Number);
      const [hLigneFin, mLigneFin] = ligne.heureFin.split(':').map(Number);
      const minutesLigneDebut = hLigneDebut * 60 + mLigneDebut;
      const minutesLigneFin = hLigneFin * 60 + mLigneFin;

      const lignePasseMinuit = minutesLigneFin < minutesLigneDebut;

      if (lignePasseMinuit) {
        // Ligne passe minuit (ex: 05h-02h ou 22h-06h)
        // Service accepté s'il commence >= heureDebut OU commence <= heureFin
        
        if (minutesDebut >= minutesLigneDebut) {
          // Service commence après heureDebut: OK
          // Ex: Ligne 05h-02h, Service 05h-14h ou 22h-23h
        } else if (minutesDebut <= minutesLigneFin) {
          // Service commence avant heureFin (après minuit): OK
          // Ex: Ligne 05h-02h, Service 01h-02h
        } else {
          // Service commence dans le trou entre heureFin et heureDebut: NON
          // Ex: Ligne 05h-02h, Service 03h-04h
          return res.status(400).json({ 
            error: `Service must start between ${ligne.heureDebut} and ${ligne.heureFin} (next day)` 
          });
        }

        // Vérifier que service ne dépasse pas les limites excessivement
        if (minutesFin > minutesLigneFin && minutesDebut >= minutesLigneDebut && minutesFin < minutesDebut) {
          // Service passe minuit mais fin > heureFin: NON
          return res.status(400).json({ 
            error: `Service cannot end after ${ligne.heureFin}` 
          });
        }
      } else {
        // Horaires normaux: heureDebut < heureFin (même jour)
        if (minutesDebut < minutesLigneDebut) {
          return res.status(400).json({ 
            error: `Service must start at or after ${ligne.heureDebut}` 
          });
        }

        if (minutesFin > minutesLigneFin) {
          return res.status(400).json({ 
            error: `Service must end before or at ${ligne.heureFin}` 
          });
        }
      }
    }

    // Anti-duplication : si un service identique existe déjà (même sens, date, début, fin), on le renvoie tel quel
    const existing = await prisma.service.findFirst({
      where: {
        sensId: b.sensId,
        date: b.date ? new Date(b.date) : undefined,
        heureDebut: b.heureDebut,
        heureFin: b.heureFin,
      },
      include: { conducteur: true, sens: true }
    });

    if (existing) {
      return res.json({ ...existing, duplicate: true });
    }

    const service = await prisma.service.create({
      data: {
        sensId: b.sensId,
        ligneId: b.ligneId, // Reference to ligne
        heureDebut: b.heureDebut,
        heureFin: b.heureFin,
        statut: b.statut || 'Planifiée',
        date: b.date ? new Date(b.date) : new Date(),
      },
      include: { conducteur: true, sens: true }
    });

    res.json(service);
  } catch (e) {
    console.error('POST /api/services-hierarchie ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// UPDATE SERVICE (for LignesHierarchie)
app.put('/api/services-hierarchie/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      heureDebut: b.heureDebut ?? undefined,
      heureFin: b.heureFin ?? undefined,
      conducteurId: b.conducteurId ?? undefined,
      statut: b.statut ?? undefined,
    };

    const service = await prisma.service.update({ 
      where: { id: req.params.id }, 
      data,
      include: { conducteur: true }
    });
    res.json(service);
  } catch (e) {
    console.error('PUT /api/services-hierarchie/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE SERVICE (for LignesHierarchie)
app.delete('/api/services-hierarchie/:id', async (req, res) => {
  try {
    await prisma.service.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ========== TRAJETS (Itinéraires) ==========

// GET trajets par ligne
app.get('/api/trajets/ligne/:ligneId', async (req, res) => {
  try {
    const trajets = await prisma.trajet.findMany({
      where: { ligneId: req.params.ligneId },
      include: { arrets: { orderBy: { ordre: 'asc' } } },
      orderBy: { ordre: 'asc' }
    });
    res.json(trajets);
  } catch (e) {
    console.error('GET /api/trajets/ligne/:ligneId ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// POST créer trajet
app.post('/api/trajets', async (req, res) => {
  try {
    const b = req.body;
    if (!b.ligneId || !b.nom) {
      return res.status(400).json({ error: 'Missing fields: ligneId, nom' });
    }

    const trajet = await prisma.trajet.create({
      data: {
        ligneId: b.ligneId,
        sensId: b.sensId || null,
        nom: b.nom,
        description: b.description || null,
        ordre: b.ordre || 1,
        statut: b.statut || 'Actif'
      },
      include: { arrets: true }
    });

    res.json(trajet);
  } catch (e) {
    console.error('POST /api/trajets ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// PUT modifier trajet
app.put('/api/trajets/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      nom: b.nom ?? undefined,
      description: b.description ?? undefined,
      sensId: b.sensId ?? undefined,
      ordre: b.ordre ?? undefined,
      statut: b.statut ?? undefined
    };

    const trajet = await prisma.trajet.update({
      where: { id: req.params.id },
      data,
      include: { arrets: { orderBy: { ordre: 'asc' } } }
    });

    res.json(trajet);
  } catch (e) {
    console.error('PUT /api/trajets/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE trajet
app.delete('/api/trajets/:id', async (req, res) => {
  try {
    await prisma.trajet.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/trajets/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// ========== ARRÊTS (Stops) ==========

// GET arrêts par trajet
app.get('/api/arrets/trajet/:trajetId', async (req, res) => {
  try {
    const arrets = await prisma.arret.findMany({
      where: { trajetId: req.params.trajetId },
      orderBy: { ordre: 'asc' }
    });
    res.json(arrets);
  } catch (e) {
    console.error('GET /api/arrets/trajet/:trajetId ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// POST créer arrêt
app.post('/api/arrets', async (req, res) => {
  try {
    const b = req.body;
    if (!b.trajetId || !b.nom) {
      return res.status(400).json({ error: 'Missing fields: trajetId, nom' });
    }

    // Calculer automatiquement le prochain numéro d'ordre si non fourni
    let ordre = b.ordre;
    if (ordre === undefined || ordre === null) {
      const maxOrdre = await prisma.arret.aggregate({
        where: { trajetId: b.trajetId },
        _max: { ordre: true }
      });
      ordre = (maxOrdre._max.ordre || 0) + 1;
    }

    const arret = await prisma.arret.create({
      data: {
        trajetId: b.trajetId,
        nom: b.nom,
        adresse: b.adresse || null,
        ordre: ordre,
        tempsArriveeAntecedent: b.tempsArriveeAntecedent || 0
      }
    });

    res.json(arret);
  } catch (e) {
    console.error('POST /api/arrets ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// PUT modifier arrêt
app.put('/api/arrets/:id', async (req, res) => {
  try {
    const b = req.body;
    const data = {
      nom: b.nom ?? undefined,
      adresse: b.adresse ?? undefined,
      ordre: b.ordre ?? undefined,
      tempsArriveeAntecedent: b.tempsArriveeAntecedent ?? undefined
    };

    const arret = await prisma.arret.update({
      where: { id: req.params.id },
      data
    });

    res.json(arret);
  } catch (e) {
    console.error('PUT /api/arrets/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// DELETE arrêt
app.delete('/api/arrets/:id', async (req, res) => {
  try {
    await prisma.arret.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/arrets/:id ERROR ->', e);
    res.status(400).json({ error: String(e) });
  }
});

// ---------- CSV Import Endpoints ----------

// Helper: Parse CSV simple (pas de dépendance externe)
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV vide ou invalide');

  // Détecter les sections [LIGNES], [ARRETS], etc.
  const sections = {};
  let currentSection = 'LIGNES'; // Section par défaut
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Vérifier si c'est une entête de section
    if (line.startsWith('[') && line.endsWith(']')) {
      // Sauvegarder la section précédente
      if (currentLines.length > 0) {
        sections[currentSection] = parseCSVLines(currentLines);
      }
      currentSection = line.slice(1, -1); // Retirer [ et ]
      currentLines = [];
    } else if (line) {
      currentLines.push(line);
    }
  }

  // Sauvegarder la dernière section
  if (currentLines.length > 0) {
    sections[currentSection] = parseCSVLines(currentLines);
  }

  return sections;
}

function parseCSVLines(lines) {
  if (lines.length < 1) return { headers: [], rows: [] };

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

// Helper: Parse jours "L; M; M; J; V; S; D" en objet calendrier
function parseJours(joursStr) {
  if (!joursStr) return null;
  
  const jours = joursStr.split(';').map(j => j.trim().toUpperCase());
  const mapping = {
    'L': 'lundi',
    'M': 'mardi',
    'J': 'jeudi',
    'V': 'vendredi',
    'S': 'samedi',
    'D': 'dimanche'
  };

  const calendrier = {
    lundi: false,
    mardi: false,
    mercredi: false,
    jeudi: false,
    vendredi: false,
    samedi: false,
    dimanche: false
  };

  // Compter les "M" pour identifier mardi et mercredi
  let mCount = 0;
  jours.forEach(j => {
    if (j === 'L') calendrier.lundi = true;
    else if (j === 'M') {
      mCount++;
      if (mCount === 1) calendrier.mardi = true;
      else if (mCount === 2) calendrier.mercredi = true;
    }
    else if (j === 'J') calendrier.jeudi = true;
    else if (j === 'V') calendrier.vendredi = true;
    else if (j === 'S') calendrier.samedi = true;
    else if (j === 'D') calendrier.dimanche = true;
  });

  return calendrier;
}

// Helper: Parse heures "04h37" -> "04:37"
function parseHeure(heureStr) {
  if (!heureStr) return null;
  return heureStr.replace('h', ':');
}

// POST /api/import/lignes - Import CSV de lignes
app.post('/api/import/lignes', async (req, res) => {
  try {
    console.log('[IMPORT] POST /api/import/lignes');

    if (!prismaReady) {
      return res.status(503).json({ error: 'Database not ready' });
    }

    let csvText = req.csvContent || req.body || '';

    if (!csvText) {
      return res.status(400).json({ error: 'Aucun fichier CSV fourni' });
    }

    await processImportLignes(csvText, res);
  } catch (error) {
    console.error('[IMPORT] POST /api/import/lignes ERROR ->', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Traiter l'import des lignes
async function processImportLignes(csvText, res) {
  const sections = parseCSV(csvText);

  // Parser les sections
  const lignesData = sections['LIGNES'] || { headers: [], rows: [] };
  const arretsData = sections['ARRETS'] || { headers: [], rows: [] };

  // Valider les colonnes requises pour les lignes
  const requiredColumns = ['numéro de ligne', 'nom de la ligne', 'jours de fonctionnement', 'type', 'premier départ', 'dernier arrivé au dépôt'];
  const missingColumns = requiredColumns.filter(col => !lignesData.headers.includes(col.toLowerCase()));

  if (missingColumns.length > 0) {
    throw new Error(`Colonnes manquantes dans [LIGNES]: ${missingColumns.join(', ')}`);
  }

  let imported = 0;
  const errors = [];
  const trajetsMap = new Map(); // Tracker: trajet -> Prisma object
  
  // Obtenir la date d'aujourd'hui en heure Paris
  const todayStr = getTodayDateParis();
  const [year, month, day] = todayStr.split('-').map(Number);
  
  // Créer une date pour "aujourd'hui" en heure Paris
  // On utilise une date UTC pour éviter les décalages timezone
  const today = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  
  // Obtenir le jour de la semaine en heure Paris
  const tempFormatter = new Intl.DateTimeFormat('fr-FR', { 
    timeZone: 'Europe/Paris',
    weekday: 'long'
  });
  const todayDayName = tempFormatter.format(today).toLowerCase();
  const dayNameMap = {
    'lundi': 1, 'mardi': 2, 'mercredi': 3, 'jeudi': 4,
    'vendredi': 5, 'samedi': 6, 'dimanche': 0
  };
  const todayDayOfWeek = dayNameMap[todayDayName] || 1;

  // ============ PHASE 1: Importer les lignes, sens, trajets et services ============
  for (let i = 0; i < lignesData.rows.length; i++) {
    try {
      const row = lignesData.rows[i];
      const numero = row['numéro de ligne']?.trim();
      const nom = row['nom de la ligne']?.trim();
      const joursStr = row['jours de fonctionnement']?.trim();
      const type = row['type']?.trim();
      const heureDebut = parseHeure(row['premier départ']?.trim());
      const heureFin = parseHeure(row['dernier arrivé au dépôt']?.trim());
      const sensNom = row['sens']?.trim();
      const sensDirection = row['direction']?.trim();
      const trajetNom = row['trajet']?.trim();
      const trajetDescription = row['description trajet']?.trim();

      if (!numero || !nom) {
        errors.push(`Ligne [LIGNES] ${i + 2}: numéro et nom requis`);
        continue;
      }

      const calendrier = parseJours(joursStr);

      // Chercher si la ligne existe
      let ligne = await prisma.ligne.findUnique({
        where: { numero },
        include: { sens: true }
      });

      // Si la ligne n'existe pas, la créer
      if (!ligne) {
        ligne = await prisma.ligne.create({
          data: {
            numero,
            nom,
            typesVehicules: JSON.stringify(type ? [type] : ['Standard']),
            heureDebut,
            heureFin,
            calendrierJson: JSON.stringify(calendrier),
            statut: 'Actif',
          },
          include: { sens: true }
        });
      } else {
        // La ligne existe déjà : on ne met à jour que les infos essentielles si elle était vide
        if (!ligne.nom || ligne.nom === '') {
          ligne = await prisma.ligne.update({
            where: { numero },
            data: {
              nom,
              statut: 'Actif',
            },
            include: { sens: true }
          });
        }
      }

      // Créer/mettre à jour le sens
      let sens = null;
      if (sensNom) {
        sens = await prisma.sens.upsert({
          where: {
            ligneId_nom: {
              ligneId: ligne.id,
              nom: sensNom,
            },
          },
          create: {
            ligneId: ligne.id,
            nom: sensNom,
            direction: sensDirection || null,
            statut: 'Actif',
          },
          update: {
            direction: sensDirection || null,
          },
        });
      }

      // Créer/mettre à jour le trajet
      let trajet = null;
      if (trajetNom && sens) {
        trajet = await prisma.trajet.upsert({
          where: {
            ligneId_nom: {
              ligneId: ligne.id,
              nom: trajetNom,
            },
          },
          create: {
            ligneId: ligne.id,
            sensId: sens.id,
            nom: trajetNom,
            description: trajetDescription || null,
            statut: 'Actif',
          },
          update: {
            description: trajetDescription || null,
          },
        });
        trajetsMap.set(trajetNom, trajet);
      }

      // Créer les services
      for (let j = 1; j <= 20; j++) {
        const serviceBeginKey = `service ${j} début`.toLowerCase();
        const serviceEndKey = `service ${j} fin`.toLowerCase();

        const serviceBegin = row[serviceBeginKey]?.trim();
        const serviceEnd = row[serviceEndKey]?.trim();

        if (serviceBegin && serviceEnd) {
          const heureDebuitService = parseHeure(serviceBegin);
          const heureFinService = parseHeure(serviceEnd);

          if (heureDebuitService && heureFinService) {
            // Créer le service pour chaque jour de fonctionnement
            const joursActive = Object.keys(calendrier).filter(jour => calendrier[jour]);

            for (const jour of joursActive) {
              const serviceDate = new Date(today);
              const dayMap = {
                'lundi': 1, 'mardi': 2, 'mercredi': 3, 'jeudi': 4,
                'vendredi': 5, 'samedi': 6, 'dimanche': 0,
              };

              const targetDay = dayMap[jour];
              const currentDay = todayDayOfWeek; // Utiliser le jour correct en heure Paris
              let daysToAdd = targetDay - currentDay;
              
              // Si le jour est dans le passé cette semaine, prendre la semaine prochaine
              // Si c'est le même jour, aussi prendre la semaine prochaine
              if (daysToAdd <= 0) daysToAdd += 7;

              serviceDate.setDate(serviceDate.getDate() + daysToAdd);

              // Créer le service
              await prisma.service.create({
                data: {
                  ligneId: ligne.id,
                  sensId: sens?.id || null,
                  date: serviceDate,
                  heureDebut: heureDebuitService,
                  heureFin: heureFinService,
                  statut: 'Planifiée',
                },
              }).catch(() => {
                // Ignorer les doublons
              });
            }
          }
        }
      }

      imported++;
    } catch (error) {
      errors.push(`Ligne [LIGNES] ${i + 2}: ${error.message}`);
    }
  }

  // ============ PHASE 2: Importer les arrêts ============
  for (let i = 0; i < arretsData.rows.length; i++) {
    try {
      const row = arretsData.rows[i];
      const trajetNom = row['trajet']?.trim();
      const ordre = parseInt(row['ordre']) || 0;
      const nomArret = row['nom arrêt']?.trim();
      const temps = parseInt(row['temps depuis arrêt précédent (min)']) || 0;

      if (!trajetNom || !nomArret) {
        errors.push(`Ligne [ARRETS] ${i + 2}: trajet et nom arrêt requis`);
        continue;
      }

      const trajet = trajetsMap.get(trajetNom);
      if (!trajet) {
        errors.push(`Ligne [ARRETS] ${i + 2}: trajet "${trajetNom}" non trouvé`);
        continue;
      }

      // Créer l'arrêt
      await prisma.arret.upsert({
        where: {
          trajetId_ordre: {
            trajetId: trajet.id,
            ordre: ordre,
          },
        },
        create: {
          trajetId: trajet.id,
          nom: nomArret,
          ordre: ordre,
          tempsArriveeAntecedent: temps,
        },
        update: {
          nom: nomArret,
          tempsArriveeAntecedent: temps,
        },
      });
    } catch (error) {
      errors.push(`Ligne [ARRETS] ${i + 2}: ${error.message}`);
    }
  }

  res.json({
    imported,
    errors: errors.length > 0 ? errors : undefined,
    message: `${imported} ligne(s) et ${arretsData.rows.length} arrêt(s) importée(s)`,
  });
}

// ---------- error handler (global) ----------
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled error:', err.message);
  console.error('[ERROR] Stack:', err.stack);
  
  // Assurer les headers CORS même sur erreur
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH,HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ---------- 404 handler ----------
app.use((req, res) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH,HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

console.log('[STARTUP] Configured PORT:', PORT);
console.log('[STARTUP] Configured HOST:', HOST);

// Vérifier la connexion à la base de données avant de démarrer
async function startServer() {
  console.log('[STARTUP] startServer() called');
  try {
    // Test de connexion à Prisma avec timeout
    console.log('[STARTUP] Testing database connection...');
    console.log('[STARTUP] DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

    if (!prisma) {
      throw new Error('Prisma client not initialized');
    }

    const startTime = Date.now();
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB check timeout (5s)')), 5000)),
    ]);
    const duration = Date.now() - startTime;
    prismaReady = true;
    
    console.log(`✅ Database connection successful (${duration}ms)`);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    console.error('[ERROR] DATABASE_URL:', process.env.DATABASE_URL || 'NOT SET');
    
    // Ne pas quitter immédiatement, laisser le serveur démarrer quand même
    // pour que les health checks puissent fonctionner
    console.warn('⚠️  Starting server without database connection...');
  }

  console.log('[STARTUP] About to create HTTP server on', HOST + ':' + PORT);
  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 TC Outil - API running on http://${HOST}:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📝 NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`🔌 PORT=${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      prisma.$disconnect().then(() => process.exit(0));
    });
  });
}

console.log('[STARTUP] Calling startServer()...');
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
