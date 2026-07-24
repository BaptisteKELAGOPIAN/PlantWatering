import { Request, Response, NextFunction } from 'express';

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (token && token === ADMIN_PASSWORD) {
    return next();
  }
  
  res.status(401).json({ 
    error: 'Action non autorisée en mode Démo. Veuillez vous connecter en Administrateur.' 
  });
}
